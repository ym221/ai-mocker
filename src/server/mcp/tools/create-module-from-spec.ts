import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { runHeadlessSession, type HeadlessProgress } from '../lib/headless-session.js';
import { buildOpenApi, summarizeEndpoints } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';

const GENERATED_DIR = resolve('generated');

/** 尝试把 spec 解析为对象（JSON 优先，失败兜底 YAML，再失败返回 null）。 */
function tryParseSpec(raw: string): any | null {
  const trimmed = raw.trim();
  // JSON
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // YAML
  try {
    const parsed = parseYaml(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* not yaml */ }
  return null;
}

interface PlanPreview {
  kind: 'openapi-derived' | 'natural-language';
  moduleName: string;
  entities?: Array<{ name: string; fields: string[] }>;
  endpoints?: string[];
  notes?: string[];
}

function buildPlan(spec: string, requestedName?: string): PlanPreview {
  const parsed = tryParseSpec(spec);
  const notes: string[] = [];

  if (!parsed) {
    return {
      kind: 'natural-language',
      moduleName: requestedName || 'inferred-by-ai',
      notes: [
        'spec is free-form text; AI will infer module name, entities, and endpoints during generation.',
      ],
    };
  }

  // OpenAPI-like: has paths / components
  if (parsed.paths || parsed.components) {
    const endpoints: string[] = [];
    for (const [p, methods] of Object.entries(parsed.paths || {})) {
      for (const method of Object.keys(methods || {})) {
        endpoints.push(`${method.toUpperCase()} ${p}`);
      }
    }

    const entities: Array<{ name: string; fields: string[] }> = [];
    const schemas = parsed.components?.schemas || {};
    for (const [name, schema] of Object.entries(schemas)) {
      const fields = Object.keys((schema as any)?.properties || {});
      entities.push({ name, fields });
    }

    return {
      kind: 'openapi-derived',
      moduleName: requestedName
        || parsed.info?.title?.toLowerCase().replace(/\s+/g, '_')
        || 'from_spec',
      entities,
      endpoints,
      notes,
    };
  }

  return {
    kind: 'natural-language',
    moduleName: requestedName || 'inferred-by-ai',
    notes: ['spec has unrecognized shape; AI will interpret.'],
  };
}

function readModuleApiDocHead(userId: number, moduleName: string): string {
  const p = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8').slice(0, 500); } catch { return ''; }
}

export function registerCreateModuleFromSpecTool(server: McpServer): void {
  server.registerTool(
    'create_module_from_spec',
    {
      title: 'Create Mock Module from Spec',
      description:
        'Generate a new Mock module from an API spec. The spec can be an OpenAPI 3 JSON/YAML string or a free-form natural-language description. Set dry_run=true to preview the plan without actually generating. This triggers a full AI generation cycle (up to ~3 minutes); progress is streamed via MCP progress notifications. Optional provider/model/preset overrides pin this run to specific configurations — useful when the IDE caller wants a specific response-format or naming style.',
      inputSchema: {
        spec: z.string().describe('OpenAPI JSON/YAML or natural-language description of the module'),
        moduleName: z.string().optional().describe('Desired module name (lowercase, ASCII). If omitted, AI infers it.'),
        provider: z.number().int().optional().describe('Provider id to use for this run (must be user-owned or public). Overrides auto-pick.'),
        model: z.string().optional().describe('Model id to use (e.g. "claude-sonnet-4-6"). Overrides provider default.'),
        preset: z.union([z.number().int(), z.string()]).optional().describe('Preset id (number) or preset name (string). Pins response format / field naming / pagination rules.'),
        dry_run: z.boolean().optional().describe('If true, return only the plan preview without executing'),
      },
    },
    async ({ spec, moduleName, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();

      // ---- dry_run: 纯静态预览，不起 ChatRunner ----
      if (dry_run) {
        const plan = buildPlan(spec, moduleName);
        return {
          content: [{
            type: 'text',
            text: `DRY RUN — would ${plan.kind === 'openapi-derived' ? 'generate from OpenAPI' : 'ask AI to interpret and generate'} module "${plan.moduleName}":`
              + (plan.entities?.length ? `\n  entities: ${plan.entities.map((e) => e.name).join(', ')}` : '')
              + (plan.endpoints?.length ? `\n  endpoints: ${plan.endpoints.join(', ')}` : '')
              + (plan.notes?.length ? `\n  notes: ${plan.notes.join('; ')}` : ''),
          }],
          structuredContent: {
            moduleName: plan.moduleName,
            status: 'would-create',
            plan,
          },
        };
      }

      // ---- 正式生成 ----
      const nameHint = moduleName ? `\n模块名必须是："${moduleName}"。` : '';
      const userContent =
        `请根据以下 API 规范/需求，创建一个全新的 Mock API 模块。${nameHint}\n\n` +
        `规范内容：\n${spec}`;

      const sendProgress = (extra as any)?.sendNotification;
      const progressToken = (extra as any)?._meta?.progressToken;

      const result = await runHeadlessSession({
        userId: user.userId,
        userContent,
        title: `[MCP] create ${moduleName || 'module'}`,
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
          } catch { /* ignore progress errors */ }
        },
      });

      // 从 events 里抓模块名（AI 通过 set_module_intent 声明）
      let actualModuleName = moduleName || null;
      for (const ev of result.events) {
        if (ev.type === 'card' && (ev.payload as any)?.moduleName) {
          actualModuleName = (ev.payload as any).moduleName;
          break;
        }
      }
      if (!actualModuleName) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Generation completed but no module was created (AI may have refused or errored). Check the session in Web UI for details.' }],
          structuredContent: { sessionId: result.sessionId, status: result.status, errorMessage: result.errorMessage },
        };
      }

      if (result.status !== 'done') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Generation ended with status=${result.status}${result.errorMessage ? ': ' + result.errorMessage : ''}. Session: ${result.sessionId}` }],
          structuredContent: { sessionId: result.sessionId, status: result.status, errorMessage: result.errorMessage, moduleName: actualModuleName },
        };
      }

      // 读生成的模块摘要
      const mod = db.select().from(modules)
        .where(and(eq(modules.userId, user.userId), eq(modules.name, actualModuleName)))
        .get();
      const endpoints = summarizeEndpoints(user.userId, actualModuleName);
      const apiDoc = readModuleApiDocHead(user.userId, actualModuleName);
      const port = process.env.PORT || '3000';
      const host = process.env.MCP_PUBLIC_HOST || 'localhost';
      const basePath = mod?.basePath || `/mock/${actualModuleName}`;
      const mockBaseUrl = basePath.startsWith('/mock')
        ? `http://${host}:${port}${basePath}`
        : `http://${host}:${port}/mock${basePath.startsWith('/') ? basePath : '/' + basePath}`;

      // 记一次 retry（create 也算一次）
      const warnings = bumpRetryCounter(`${user.userId}:${actualModuleName}:create`);

      return {
        content: [{
          type: 'text',
          text: `Created module "${actualModuleName}". Proxy business code to ${mockBaseUrl}.`,
        }],
        structuredContent: {
          moduleName: actualModuleName,
          status: 'created',
          sessionId: result.sessionId,
          endpoints,
          apiDocPreview: apiDoc,
          mockBaseUrl,
          warnings,
        },
      };
    }
  );
}
