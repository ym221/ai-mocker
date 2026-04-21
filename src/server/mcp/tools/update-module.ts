import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { runHeadlessSession, type HeadlessProgress } from '../lib/headless-session.js';
import { summarizeEndpoints, readModuleMeta } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';

const GENERATED_DIR = resolve('generated');

interface MetaSnapshot {
  entityNames: Set<string>;
  fieldsByEntity: Map<string, Set<string>>;
  endpoints: Set<string>;
}

function snapshotMeta(userId: number, moduleName: string): MetaSnapshot {
  const meta = readModuleMeta(userId, moduleName);
  const entityNames = new Set<string>();
  const fieldsByEntity = new Map<string, Set<string>>();
  for (const ent of meta?.entities || []) {
    entityNames.add(ent.name);
    fieldsByEntity.set(ent.name, new Set((ent.fields || []).map((f) => f.name)));
  }
  const endpoints = new Set((meta?.endpoints || []).map((ep) => `${String(ep.method || '').toUpperCase()} ${ep.path || ''}`));
  return { entityNames, fieldsByEntity, endpoints };
}

function diffSnapshots(before: MetaSnapshot, after: MetaSnapshot): string[] {
  const diffs: string[] = [];

  for (const n of after.entityNames) if (!before.entityNames.has(n)) diffs.push(`+entity ${n}`);
  for (const n of before.entityNames) if (!after.entityNames.has(n)) diffs.push(`-entity ${n}`);

  for (const [name, afterFields] of after.fieldsByEntity) {
    const beforeFields = before.fieldsByEntity.get(name) || new Set();
    for (const f of afterFields) if (!beforeFields.has(f)) diffs.push(`+field ${name}.${f}`);
    for (const f of beforeFields) if (!afterFields.has(f)) diffs.push(`-field ${name}.${f}`);
  }

  for (const ep of after.endpoints) if (!before.endpoints.has(ep)) diffs.push(`+endpoint ${ep}`);
  for (const ep of before.endpoints) if (!after.endpoints.has(ep)) diffs.push(`-endpoint ${ep}`);

  return diffs;
}

function readModuleApiDocHead(userId: number, moduleName: string): string {
  const p = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8').slice(0, 500); } catch { return ''; }
}

export function registerUpdateModuleTool(server: McpServer): void {
  server.registerTool(
    'update_module',
    {
      title: 'Update Existing Mock Module',
      description:
        'Modify an existing Mock module. Pass a natural-language instruction describing the desired change (add a field, add an endpoint, tweak response shape, fix a bug). Set dry_run=true to preview which entities/fields/endpoints would change, without touching files. Triggers a full AI generation cycle; progress streamed via MCP progress notifications. Optional provider/model/preset overrides pin this run to specific configurations.',
      inputSchema: {
        moduleName: z.string(),
        instruction: z.string().describe('Natural-language description of the change'),
        provider: z.number().int().optional().describe('Provider id to use for this run (must be user-owned or public). Overrides auto-pick.'),
        model: z.string().optional().describe('Model id to use (e.g. "claude-sonnet-4-6"). Overrides provider default.'),
        preset: z.union([z.number().int(), z.string()]).optional().describe('Preset id (number) or preset name (string). Pins response format / field naming / pagination rules.'),
        dry_run: z.boolean().optional(),
      },
    },
    async ({ moduleName, instruction, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();

      // 校验模块存在
      const existing = db.select().from(modules)
        .where(and(eq(modules.userId, user.userId), eq(modules.name, moduleName)))
        .get();
      if (!existing) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Module '${moduleName}' not found.` }],
        };
      }

      // dry_run: 只返回"将调 AI 修改此模块 + 列出当前契约"
      if (dry_run) {
        const endpoints = summarizeEndpoints(user.userId, moduleName);
        return {
          content: [{
            type: 'text',
            text: `DRY RUN — would ask AI to modify module "${moduleName}" per instruction: ${instruction}\nCurrent endpoints:\n  ${endpoints.join('\n  ')}`,
          }],
          structuredContent: {
            moduleName,
            status: 'would-update',
            instruction,
            currentEndpoints: endpoints,
          },
        };
      }

      const before = snapshotMeta(user.userId, moduleName);

      const userContent =
        `修改已有模块："${moduleName}"。具体要求：\n${instruction}\n\n` +
        `请保持模块名不变，只改动必要的字段/端点/文件。`;

      const sendProgress = (extra as any)?.sendNotification;
      const progressToken = (extra as any)?._meta?.progressToken;

      const result = await runHeadlessSession({
        userId: user.userId,
        userContent,
        title: `[MCP] update ${moduleName}`,
        moduleName,
        providerId: provider,
        model,
        presetId: typeof preset === 'number' ? preset : undefined,
        presetName: typeof preset === 'string' ? preset : undefined,
        onProgress: async (p: HeadlessProgress) => {
          if (!sendProgress || !progressToken) return;
          try {
            await sendProgress({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: p.seq,
                message: `${p.stage}${p.detail ? ': ' + JSON.stringify(p.detail) : ''}`,
              },
            });
          } catch { /* ignore */ }
        },
      });

      if (result.status !== 'done') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Update ended with status=${result.status}${result.errorMessage ? ': ' + result.errorMessage : ''}. Session: ${result.sessionId}` }],
          structuredContent: { sessionId: result.sessionId, status: result.status, errorMessage: result.errorMessage, moduleName },
        };
      }

      const after = snapshotMeta(user.userId, moduleName);
      const diff = diffSnapshots(before, after);
      const apiDoc = readModuleApiDocHead(user.userId, moduleName);

      // retry counter
      const warnings = bumpRetryCounter(`${user.userId}:${moduleName}:update`);

      return {
        content: [{
          type: 'text',
          text: diff.length
            ? `Updated "${moduleName}":\n  ${diff.join('\n  ')}`
            : `Updated "${moduleName}" (no structural diff detected)`,
        }],
        structuredContent: {
          moduleName,
          status: 'updated',
          sessionId: result.sessionId,
          diff,
          apiDocPreview: apiDoc,
          warnings,
        },
      };
    }
  );
}
