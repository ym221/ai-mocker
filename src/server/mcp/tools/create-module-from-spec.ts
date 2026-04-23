import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import {
  startHeadlessSession,
  attachAndWait,
  type HeadlessProgress,
  type HeadlessResult,
} from '../lib/headless-session.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';
import { findInFlightSession } from '../lib/in-flight-lock.js';
import { ChatRunner } from '../../agent/chat-runner.js';
import {
  buildCreateUserContent,
  extractCreateSpec,
  instructionsDiffer,
} from '../lib/instruction-utils.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

const GENERATED_DIR = resolve('generated');
const DEFAULT_WAIT_MAX_SEC = 60;
const MAX_WAIT_MAX_SEC = 300;

/** 尝试把 spec 解析为对象（JSON 优先，失败兜底 YAML，再失败返回 null）。 */
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
      notes: [
        'spec is free-form text; AI will infer module name, entities, and endpoints during generation.',
      ],
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

function readOriginalSpec(sessionId: string): string {
  const row = sqlite.prepare(
    `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`,
  ).get(sessionId) as { content: string } | undefined;
  if (!row) return '';
  return extractCreateSpec(row.content);
}

function clampWaitMaxSec(raw: number | undefined): number {
  if (raw == null) return DEFAULT_WAIT_MAX_SEC;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MAX_SEC;
  return Math.min(n, MAX_WAIT_MAX_SEC);
}

function makeProgressSender(extra: any) {
  const sendNotification = extra?.sendNotification;
  const progressToken = extra?._meta?.progressToken;
  return async (p: HeadlessProgress) => {
    if (!sendNotification || !progressToken) return;
    try {
      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: p.seq,
          message: `${p.stage}${p.detail ? ': ' + JSON.stringify(p.detail) : ''}`,
        },
      });
    } catch { /* ignore */ }
  };
}

function buildCreatedResponse(params: {
  userId: number;
  requestedModuleName: string | null;
  result: HeadlessResult;
  attached: boolean;
  actualSpec?: string;
  yourSpec?: string;
}): any {
  const { userId, requestedModuleName, result, attached, actualSpec, yourSpec } = params;

  // Locate module name from events (set_module_intent)
  let actualModuleName = requestedModuleName || null;
  for (const ev of result.events) {
    if (ev.type === 'card' && (ev.payload as any)?.data?.moduleName) {
      actualModuleName = (ev.payload as any).data.moduleName;
      break;
    }
    if (ev.type === 'card' && (ev.payload as any)?.moduleName) {
      actualModuleName = (ev.payload as any).moduleName;
      break;
    }
  }
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

  if (result.status !== 'done') {
    const code = result.status === 'error' ? MCP_ERROR_CODES.INTERNAL_ERROR : MCP_ERROR_CODES.WAIT_TIMEOUT;
    return mcpError({
      code,
      message: `Generation ended with status=${result.status}${result.errorMessage ? ': ' + result.errorMessage : ''}. Session: ${result.sessionId}`,
      hint: 'Inspect the session in the Web UI. If it was interrupted, call create_module_from_spec again with the same moduleName — it will resume automatically.',
      sessionId: result.sessionId,
      status: result.status,
      errorMessage: result.errorMessage,
      moduleName: actualModuleName,
      attached,
    });
  }

  const mod = db.select().from(modules)
    .where(and(eq(modules.userId, userId), eq(modules.name, actualModuleName)))
    .get();
  const endpoints = summarizeEndpoints(userId, actualModuleName);
  const apiDoc = readModuleApiDocHead(userId, actualModuleName);
  const port = process.env.PORT || '3000';
  const host = process.env.MCP_PUBLIC_HOST || 'localhost';
  const basePath = mod?.basePath || `/mock/${actualModuleName}`;
  const mockBaseUrl = basePath.startsWith('/mock')
    ? `http://${host}:${port}${basePath}`
    : `http://${host}:${port}/mock${basePath.startsWith('/') ? basePath : '/' + basePath}`;

  const warnings = bumpRetryCounter(`${userId}:${actualModuleName}:create`);

  let driftWarning: string | null = null;
  if (attached && actualSpec != null && yourSpec != null && instructionsDiffer(actualSpec, yourSpec)) {
    driftWarning = `Note: your spec differs from the in-flight one. The result returned is from the executing one. If you meant to start fresh, call this with onConflict: 'replace' (and pass a moduleName).`;
  }

  return {
    content: [{
      type: 'text',
      text: `Created module "${actualModuleName}". Proxy business code to ${mockBaseUrl}.${attached ? ` (attached to running session ${result.sessionId})` : ''}${driftWarning ? `\n\nWARNING: ${driftWarning}` : ''}`,
    }],
    structuredContent: {
      moduleName: actualModuleName,
      status: 'created',
      sessionId: result.sessionId,
      attached,
      endpoints,
      apiDocPreview: apiDoc,
      mockBaseUrl,
      warnings,
      ...(attached && actualSpec != null ? { actualInstruction: actualSpec } : {}),
      ...(attached && yourSpec != null ? { yourInstruction: yourSpec } : {}),
      ...(driftWarning ? { warning: driftWarning } : {}),
    },
  };
}

function buildStillRunningResponse(params: {
  moduleName: string | null;
  result: HeadlessResult;
  attached: boolean;
  actualSpec?: string;
  yourSpec?: string;
}): any {
  const { moduleName, result, attached, actualSpec, yourSpec } = params;
  const text = `Module "${moduleName ?? '(inferring)'}" is still being created (elapsed ${result.elapsedSec ?? '?'}s, stage=${result.stage ?? 'unknown'}, session=${result.sessionId}). `
    + `Call create_module_from_spec again with the same arguments to auto-resume.`;

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      moduleName,
      status: 'still-running',
      sessionId: result.sessionId,
      attached,
      stage: result.stage,
      elapsedSec: result.elapsedSec,
      lastEventSeq: result.lastEventSeq,
      hint: 'Call create_module_from_spec again with the same arguments to auto-resume. Use get_session_status(sessionId) for a live snapshot, or cancel_session(sessionId) to abort.',
      ...(attached && actualSpec != null ? { actualInstruction: actualSpec } : {}),
      ...(attached && yourSpec != null ? { yourInstruction: yourSpec } : {}),
    },
  };
}

export function registerCreateModuleFromSpecTool(server: McpServer): void {
  server.registerTool(
    'create_module_from_spec',
    {
      title: 'Create Mock Module from Spec',
      description:
        'Generate a new Mock module from an API spec. The spec can be an OpenAPI 3 JSON/YAML string or a free-form natural-language description. '
        + 'Blocks up to `waitMaxSec` seconds (default 60, max 300); if generation is still running when the window elapses returns { status:"still-running", sessionId } — call this tool again with the same args to auto-resume. '
        + 'If another session for the same moduleName is already in-flight, `onConflict` decides: "resume" (default) attaches, "reject" returns ALREADY_PROCESSING, "replace" cancels it and starts fresh (requires moduleName). '
        + 'Set dry_run=true to preview the plan without actually generating. This triggers a full AI generation cycle; progress is streamed via MCP progress notifications.',
      inputSchema: {
        spec: z.string().describe('OpenAPI JSON/YAML or natural-language description of the module'),
        moduleName: z.string().optional().describe('Desired module name (lowercase, ASCII). If omitted, AI infers it.'),
        waitMaxSec: z.number().int().optional().describe('Max seconds to block waiting for the run to finish. Default 60, max 300. On timeout returns status="still-running" and the underlying generation keeps going.'),
        onConflict: z.enum(['resume', 'reject', 'replace']).optional().describe('Behavior when another session is already creating this moduleName (ignored if moduleName not given). Default "resume" (attach + wait).'),
        provider: z.number().int().optional().describe('Provider id to use for this run (must be user-owned or public). Overrides auto-pick.'),
        model: z.string().optional().describe('Model id to use (e.g. "claude-sonnet-4-6"). Overrides provider default.'),
        preset: z.union([z.number().int(), z.string()]).optional().describe('Preset id (number) or preset name (string). Pins response format / field naming / pagination rules.'),
        dry_run: z.boolean().optional().describe('If true, return only the plan preview without executing'),
      },
    },
    async ({ spec, moduleName, waitMaxSec, onConflict, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();
      const conflictMode: 'resume' | 'reject' | 'replace' = onConflict ?? 'resume';
      const waitSec = clampWaitMaxSec(waitMaxSec);

      // dry_run: pure static preview
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

      // In-flight check (only when moduleName was provided; without it we can't dedupe anyway)
      if (moduleName) {
        const { inFlight, existingSessionId } = findInFlightSession(user.userId, moduleName);

        if (inFlight && conflictMode === 'reject') {
          return mcpError({
            code: MCP_ERROR_CODES.ALREADY_PROCESSING,
            message: `Module "${moduleName}" is already being created (session ${existingSessionId}). Wait for it to finish or inspect it in the Web UI.`,
            hint: 'Retry without onConflict or with onConflict="resume" to attach + wait. Use onConflict="replace" to cancel and start fresh.',
            moduleName,
            existingSessionId,
          });
        }

        if (inFlight && conflictMode === 'replace') {
          const existingRunner = ChatRunner.get(existingSessionId!);
          if (existingRunner) {
            try { existingRunner.pause(); } catch { /* ignore */ }
          }
          await attachAndWait(existingSessionId!, 10).catch(() => null);
          // fall through to fresh-start
        }

        if (inFlight && conflictMode === 'resume') {
          const actualSpec = readOriginalSpec(existingSessionId!);
          const sendProgress = makeProgressSender(extra);
          const result = await attachAndWait(existingSessionId!, waitSec, { onProgress: sendProgress });

          if (result.status === 'still-running') {
            return buildStillRunningResponse({ moduleName, result, attached: true, actualSpec, yourSpec: spec });
          }
          return buildCreatedResponse({
            userId: user.userId,
            requestedModuleName: moduleName,
            result,
            attached: true,
            actualSpec,
            yourSpec: spec,
          });
        }
      }

      // Fresh start
      const userContent = buildCreateUserContent(spec, moduleName);
      const sendProgress = makeProgressSender(extra);

      let sessionId: string;
      try {
        const started = await startHeadlessSession({
          userId: user.userId,
          userContent,
          title: `[MCP] create ${moduleName || 'module'}`,
          moduleName,
          providerId: provider,
          model,
          presetId: typeof preset === 'number' ? preset : undefined,
          presetName: typeof preset === 'string' ? preset : undefined,
        });
        sessionId = started.sessionId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isProviderErr = /provider|preset/i.test(msg);
        return mcpError({
          code: isProviderErr ? MCP_ERROR_CODES.PROVIDER_NOT_CONFIGURED : MCP_ERROR_CODES.INTERNAL_ERROR,
          message: msg,
          hint: isProviderErr
            ? 'Configure an AI provider in Settings → Providers, or pass a valid provider id via the "provider" arg.'
            : 'Retry later or inspect server logs.',
          moduleName: moduleName ?? null,
        });
      }

      const result = await attachAndWait(sessionId, waitSec, { onProgress: sendProgress });

      if (result.status === 'still-running') {
        return buildStillRunningResponse({ moduleName: moduleName ?? null, result, attached: false });
      }
      return buildCreatedResponse({
        userId: user.userId,
        requestedModuleName: moduleName ?? null,
        result,
        attached: false,
      });
    }
  );
}
