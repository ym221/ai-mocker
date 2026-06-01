import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser, getMcpRequestOrigin } from '../context.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';
import { buildCreateUserContent, extractCreateSpec } from '../lib/instruction-utils.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';
import { runWriteTool } from '../lib/write-tool-runner.js';
import { humanizeStage } from '../lib/stage-humanize.js';
import { buildMockBaseUrl } from '../lib/mock-base-url.js';
import { classifySpec } from '../lib/spec-classifier.js';
import { generateTier1Files } from '../lib/generate-template.js';
import { writeFiles } from '../../agent/tools/write-files.js';
import { computeModuleHealth, probeControllerLoadable } from '../../core/module-health.js';
import { runSmokeTest } from '../../core/smoke-test.js';

const GENERATED_DIR = resolve('generated');

/**
 * Extract quality field from the terminal event in result.events.
 * Set by ChatRunner.finalize() — see chat-runner.ts.
 */
function extractQuality(events: any[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'done' || e?.type === 'error' || e?.type === 'paused' || e?.type === 'aborted') {
      const q = (e.payload as any)?.quality;
      if (q && typeof q === 'object') return q as Record<string, unknown>;
      break;
    }
  }
  return null;
}

// ============================================================================
// Spec → dry-run plan preview
// ============================================================================

function tryParseSpec(raw: string): any | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
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
      notes: ['spec is free-form text; AI will infer module name, entities, and endpoints during generation.'],
    };
  }
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
      entities, endpoints, notes,
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

function resolveActualModuleName(requestedName: string | null, events: any[]): string | null {
  if (requestedName) return requestedName;
  for (const ev of events) {
    if (ev.type === 'card' && (ev.payload as any)?.data?.moduleName) {
      return (ev.payload as any).data.moduleName;
    }
    if (ev.type === 'card' && (ev.payload as any)?.moduleName) {
      return (ev.payload as any).moduleName;
    }
  }
  return null;
}

// ============================================================================
// Step-Loosen Phase 3 — tier 1 template-only generation path
// ============================================================================

/**
 * Generate a tier-1 (pure CRUD) module without invoking any LLM.
 * On any failure (health degraded / controller fails to load / smoke test
 * doesn't pass), return null so the caller falls through to tier 3 (ChatRunner).
 */
async function runTier1(
  userId: number,
  moduleName: string,
  classification: ReturnType<typeof classifySpec>,
  requestOrigin?: string | null,
): Promise<any | null> {
  if (!classification.entities || classification.entities.length === 0) return null;
  const entity = classification.entities[0];
  const endpoints = classification.endpoints ?? [];
  if (endpoints.length === 0) return null;

  const startedAt = Date.now();
  const files = generateTier1Files({
    moduleName,
    displayName: classification.openapi?.info?.title ?? moduleName,
    description: classification.openapi?.info?.description ?? '',
    entity,
    endpoints,
  });

  const writeRes = await writeFiles(userId, { files });
  if (!writeRes.success) {
    console.warn(`[tier-1] write_files failed for ${moduleName}: ${writeRes.error ?? writeRes.message}`);
    return null;
  }

  // Health probe
  const health = computeModuleHealth(userId, moduleName);
  if (health.health !== 'healthy') {
    console.warn(`[tier-1] health=${health.health} for ${moduleName}, missing=${health.missing.join(',')}`);
    return null;
  }
  const probe = await probeControllerLoadable(userId, moduleName);
  if (!probe.ok) {
    console.warn(`[tier-1] controller load failed for ${moduleName}: ${probe.error}`);
    return null;
  }
  const smoke = await runSmokeTest(userId, moduleName);
  if (!smoke.passed && !smoke.skipped) {
    console.warn(`[tier-1] smoke test failed for ${moduleName}: ${smoke.error ?? 'no error'}`);
    return null;
  }

  // Success — assemble MCP response
  const endpointsSummary = summarizeEndpoints(userId, moduleName);
  const apiDoc = readModuleApiDocHead(userId, moduleName);
  const mod = db.select().from(modules)
    .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
    .get();
  const built = buildMockBaseUrl({
    moduleName,
    basePath: mod?.basePath,
    requestOrigin: requestOrigin ?? undefined,
  });

  const elapsedMs = Date.now() - startedAt;
  const quality: Record<string, unknown> = {
    smokeTested: smoke.passed,
    smokeEndpoint: smoke.endpoint,
    tier: 1,
    generationPath: 'template',
    generationMs: elapsedMs,
  };
  if (smoke.skipped) quality.smokeSkipped = true;

  return {
    content: [{
      type: 'text',
      text: `Created module "${moduleName}" via template path (tier 1, ${elapsedMs}ms, no LLM). Proxy business code to ${built.url}.`,
    }],
    structuredContent: {
      moduleName,
      status: 'created',
      sessionId: null,  // no session for template path
      attached: false,
      tier: 1,
      generationPath: 'template',
      endpoints: endpointsSummary,
      apiDocPreview: apiDoc,
      mockBaseUrl: built.url,
      mockBaseUrlSource: built.source,
      quality,
      warnings: [],
    },
  };
}

// ============================================================================
// Tool registration
// ============================================================================

export function registerCreateModuleFromSpecTool(server: McpServer): void {
  server.registerTool(
    'create_module_from_spec',
    {
      title: 'Create Mock Module from Spec',
      description:
        'Generate a new Mock module from an API spec. The spec can be an OpenAPI 3 JSON/YAML string or a free-form natural-language description. '
        + 'Blocks up to `waitMaxSec` seconds (default 180, max 300); if generation is still running when the window elapses returns { status:"still-running", sessionId } — call this tool again with the same args to auto-resume. '
        + 'If another session for the same moduleName is already in-flight, `onConflict` decides: "resume" (default) attaches, "reject" returns ALREADY_PROCESSING, "replace" cancels it and starts fresh (requires moduleName). '
        + 'Set dry_run=true to preview the plan without actually generating.',
      inputSchema: {
        spec: z.string().describe('OpenAPI JSON/YAML or natural-language description of the module'),
        moduleName: z.string().optional().describe('Desired module name (lowercase, ASCII). If omitted, AI infers it.'),
        waitMaxSec: z.number().int().optional(),
        onConflict: z.enum(['resume', 'reject', 'replace']).optional(),
        provider: z.number().int().optional(),
        model: z.string().optional(),
        preset: z.union([z.number().int(), z.string()]).optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async ({ spec, moduleName, waitMaxSec, onConflict, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();

      if (dry_run) {
        const plan = buildPlan(spec, moduleName);
        return {
          content: [{
            type: 'text',
            text: `DRY RUN — would ${plan.kind === 'openapi-derived' ? 'generate from OpenAPI' : 'ask AI to interpret and generate'} module "${plan.moduleName}":`
              + (plan.entities?.length ? `\n  entities: ${plan.entities.map(e => e.name).join(', ')}` : '')
              + (plan.endpoints?.length ? `\n  endpoints: ${plan.endpoints.join(', ')}` : '')
              + (plan.notes?.length ? `\n  notes: ${plan.notes.join('; ')}` : ''),
          }],
          structuredContent: { moduleName: plan.moduleName, status: 'would-create', plan },
        };
      }

      const requestedName = moduleName ?? null;

      // ============================================================================
      // Step-Loosen Phase 3 — tier 路由
      // ============================================================================
      // tier 1 → 模板生成,无 LLM,几秒返回
      // tier 2 → MVP 暂走 tier 3(完整 AI 链路);后续可优化为 generateObject 单次填充
      // tier 3 → 走 ChatRunner 全量(现状)
      try {
        const classification = classifySpec(spec, moduleName);
        if (classification.tier === 1 && classification.entities && classification.endpoints && classification.entities[0]) {
          const inferredName = moduleName || classification.inferredModuleName;
          if (!inferredName) {
            // Without a usable module name we can't write files — fall through to tier 3
            console.log('[classifier] tier 1 detected but no module name resolved — falling through to tier 3');
          } else {
            try {
              const tier1Result = await runTier1(user.userId, inferredName, classification, getMcpRequestOrigin());
              if (tier1Result) return tier1Result;
            } catch (err) {
              console.warn(`[classifier] tier 1 generation threw for ${inferredName} — falling back to tier 3:`, (err as Error).message);
              // Fall through to tier 3
            }
          }
        }
        if (classification.tier === 2) {
          console.log(`[classifier] tier 2 detected (${classification.reason}) — MVP routes through tier 3 ChatRunner`);
        }
      } catch (err) {
        console.warn('[classifier] spec classification threw — falling back to tier 3:', (err as Error).message);
      }

      return runWriteTool({
        userId: user.userId,
        moduleName: requestedName,
        waitMaxSec,
        onConflict,
        provider,
        model,
        preset,
        extra,
        userContent: buildCreateUserContent(spec, moduleName),
        title: `[MCP] create ${moduleName || 'module'}`,
        yourInstruction: spec,
        extractOriginalFromContent: extractCreateSpec,
        toolKind: 'create',

        buildSuccessResponse: ({ result, attached, driftWarning, actualInstruction }) => {
          const actualModuleName = resolveActualModuleName(requestedName, result.events);
          if (!actualModuleName) {
            return mcpError({
              code: MCP_ERROR_CODES.INTERNAL_ERROR,
              message: 'Generation completed but no module was created (AI may have refused or errored). Check the session in Web UI for details.',
              hint: 'Open the session in the Web UI to see the AI\'s reasoning. You may need to rephrase the spec.',
              sessionId: result.sessionId,
              status: result.status,
              errorMessage: result.errorMessage,
            });
          }

          const mod = db.select().from(modules)
            .where(and(eq(modules.userId, user.userId), eq(modules.name, actualModuleName)))
            .get();
          const endpoints = summarizeEndpoints(user.userId, actualModuleName);
          const apiDoc = readModuleApiDocHead(user.userId, actualModuleName);
          const built = buildMockBaseUrl({
            moduleName: actualModuleName,
            basePath: mod?.basePath,
            requestOrigin: getMcpRequestOrigin(),
          });
          const mockBaseUrl = built.url;
          const mockBaseUrlSource = built.source;
          const mockBaseUrlHint = mockBaseUrlSource === 'fallback-localhost'
            ? 'mockBaseUrl 用 localhost 兜底,若 MCP 部署在远程主机,请管理员配 env MCP_PUBLIC_URL 或反向代理加 X-Forwarded-Proto/Host/Port,否则把这个 URL 写入业务代码后部署会失败。'
            : undefined;

          const retryWarnings = bumpRetryCounter(`${user.userId}:${actualModuleName}:create`) ?? [];
          const quality = extractQuality(result.events);
          const qualityWarnings = (quality?.warnings as string[] | undefined) ?? [];
          const warnings = [...retryWarnings, ...qualityWarnings];

          return {
            content: [{
              type: 'text',
              text: `Created module "${actualModuleName}". Proxy business code to ${mockBaseUrl}.${attached ? ` (attached to running session ${result.sessionId})` : ''}${driftWarning ? `\n\nWARNING: ${driftWarning}` : ''}${mockBaseUrlHint ? `\n\nNOTE: ${mockBaseUrlHint}` : ''}`,
            }],
            structuredContent: {
              moduleName: actualModuleName,
              status: 'created',
              sessionId: result.sessionId,
              attached,
              endpoints,
              apiDocPreview: apiDoc,
              mockBaseUrl,
              mockBaseUrlSource,
              ...(mockBaseUrlHint ? { mockBaseUrlHint } : {}),
              warnings,
              ...(quality ? { quality } : {}),
              ...(attached && actualInstruction != null ? { actualInstruction } : {}),
              ...(attached ? { yourInstruction: spec } : {}),
              ...(driftWarning ? { warning: driftWarning } : {}),
            },
          };
        },

        buildStillRunningResponse: ({ result, attached, driftWarning, actualInstruction }) => {
          const info = humanizeStage(result.stage);
          const text = `模块 "${requestedName ?? '(AI 推断中)'}" ${info.description}(已用 ${result.elapsedSec ?? '?'}s, session=${result.sessionId})。预计再 ~${info.expectedRemainingSec}s 可完成 — 重新调用相同参数即自动续接。`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              moduleName: requestedName,
              status: 'still-running',
              sessionId: result.sessionId,
              attached,
              stage: result.stage,
              stageDescription: info.description,
              elapsedSec: result.elapsedSec,
              expectedRemainingSec: info.expectedRemainingSec,
              lastEventSeq: result.lastEventSeq,
              hint: 'Call create_module_from_spec again with the same arguments to auto-resume. Use get_session_status(sessionId) for a live snapshot, or cancel_session(sessionId) to abort.',
              suggestedNextAction: info.suggestedNextAction,
              ...(attached && actualInstruction != null ? { actualInstruction } : {}),
              ...(attached ? { yourInstruction: spec } : {}),
              ...(driftWarning ? { warning: driftWarning } : {}),
            },
          };
        },
      });
    },
  );
}
