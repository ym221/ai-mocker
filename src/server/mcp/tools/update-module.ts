import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { runHeadlessSession, type HeadlessProgress } from '../lib/headless-session.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';
import { findInFlightSession } from '../lib/in-flight-lock.js';
import { snapshotMeta, diffSnapshots } from '../lib/update-diff.js';

const GENERATED_DIR = resolve('generated');

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

      // 去重: 拒绝对同一 moduleName 的并发修改(避免客户端重试造成双 session)
      const { inFlight, existingSessionId } = findInFlightSession(user.userId, moduleName);
      if (inFlight) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Module "${moduleName}" is already being processed (session ${existingSessionId}). Wait for it to finish or inspect it in the Web UI.`,
          }],
          structuredContent: {
            moduleName,
            status: 'already-processing',
            existingSessionId,
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
      const richDiff = diffSnapshots(before, after);
      const apiDoc = readModuleApiDocHead(user.userId, moduleName);

      // retry counter (existing soft warnings)
      const retryWarnings = bumpRetryCounter(`${user.userId}:${moduleName}:update`);
      const allWarnings = [...richDiff.warnings, ...retryWarnings];

      const summaryText = richDiff.lines.length
        ? `Updated "${moduleName}":\n  ${richDiff.lines.join('\n  ')}`
        : `Updated "${moduleName}" (no structural diff detected)`;
      const warningSuffix = richDiff.warnings.length
        ? `\nNotes:\n  ${richDiff.warnings.join('\n  ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: summaryText + warningSuffix,
        }],
        structuredContent: {
          moduleName,
          status: 'updated',
          sessionId: result.sessionId,
          diff: richDiff.lines,
          structuralOnly: richDiff.lines.length > 0 && richDiff.warnings.length === 0,
          hasChange: richDiff.hasChange,
          apiDocPreview: apiDoc,
          warnings: allWarnings,
        },
      };
    }
  );
}
