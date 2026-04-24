import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
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
import { snapshotMeta, diffSnapshots } from '../lib/update-diff.js';
import { ChatRunner } from '../../agent/chat-runner.js';
import {
  buildUpdateUserContent,
  extractUpdateInstruction,
  instructionsDiffer,
} from '../lib/instruction-utils.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';
import { tryAcquire, release } from '../lib/concurrency-gate.js';
import { randomUUID } from 'crypto';

const GENERATED_DIR = resolve('generated');
const DEFAULT_WAIT_MAX_SEC = 60;
const MAX_WAIT_MAX_SEC = 300;

function readModuleApiDocHead(userId: number, moduleName: string): string {
  const p = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8').slice(0, 500); } catch { return ''; }
}

function readOriginalInstruction(sessionId: string): string {
  const row = sqlite.prepare(
    `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`,
  ).get(sessionId) as { content: string } | undefined;
  if (!row) return '';
  return extractUpdateInstruction(row.content);
}

function clampWaitMaxSec(raw: number | undefined): number {
  if (raw == null) return DEFAULT_WAIT_MAX_SEC;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MAX_SEC;
  return Math.min(n, MAX_WAIT_MAX_SEC);
}

/** Build the per-progress-notification sender. */
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

/** Build a terminal-result response (shared by fresh-start + attach paths). */
function buildTerminalResponse(params: {
  userId: number;
  moduleName: string;
  result: HeadlessResult;
  before: ReturnType<typeof snapshotMeta>;
  attached: boolean;
  actualInstruction?: string;
  yourInstruction?: string;
}): any {
  const { userId, moduleName, result, before, attached, actualInstruction, yourInstruction } = params;

  if (result.status !== 'done') {
    // Non-done terminal: error / paused / aborted (still-running handled upstream)
    const code = result.status === 'error' ? MCP_ERROR_CODES.INTERNAL_ERROR : MCP_ERROR_CODES.WAIT_TIMEOUT;
    return mcpError({
      code,
      message: `Update ended with status=${result.status}${result.errorMessage ? ': ' + result.errorMessage : ''}. Session: ${result.sessionId}`,
      hint: 'Inspect the session in the Web UI. If it was interrupted, call update_module again — it will resume automatically.',
      moduleName,
      sessionId: result.sessionId,
      status: result.status,
      errorMessage: result.errorMessage,
      attached,
    });
  }

  const after = snapshotMeta(userId, moduleName);
  const richDiff = diffSnapshots(before, after);
  const apiDoc = readModuleApiDocHead(userId, moduleName);

  const retryWarnings = bumpRetryCounter(`${userId}:${moduleName}:update`) ?? [];
  const allWarnings = [...richDiff.warnings, ...retryWarnings];

  // Drift warning on attached result: your instruction doesn't match the in-flight one.
  let driftWarning: string | null = null;
  if (attached && actualInstruction != null && yourInstruction != null && instructionsDiffer(actualInstruction, yourInstruction)) {
    driftWarning = `Note: your instruction ("${yourInstruction}") differs from what's actually executing ("${actualInstruction}"). The result returned is from the executing one. If you meant to start fresh with new instructions, call this again with onConflict: 'replace'.`;
  }

  const summaryText = richDiff.lines.length
    ? `Updated "${moduleName}":\n  ${richDiff.lines.join('\n  ')}`
    : `Updated "${moduleName}" (no structural diff detected)`;
  const warningSuffix = richDiff.warnings.length
    ? `\nNotes:\n  ${richDiff.warnings.join('\n  ')}`
    : '';
  const attachSuffix = attached ? `\n(attached to running session ${result.sessionId})` : '';
  const driftSuffix = driftWarning ? `\n\nWARNING: ${driftWarning}` : '';

  return {
    content: [{ type: 'text', text: summaryText + warningSuffix + attachSuffix + driftSuffix }],
    structuredContent: {
      moduleName,
      status: 'updated',
      sessionId: result.sessionId,
      attached,
      diff: richDiff.lines,
      structuralOnly: richDiff.lines.length > 0 && richDiff.warnings.length === 0,
      hasChange: richDiff.hasChange,
      apiDocPreview: apiDoc,
      warnings: allWarnings,
      ...(attached && actualInstruction != null ? { actualInstruction } : {}),
      ...(attached && yourInstruction != null ? { yourInstruction } : {}),
      ...(driftWarning ? { warning: driftWarning } : {}),
    },
  };
}

function buildStillRunningResponse(params: {
  moduleName: string;
  result: HeadlessResult;
  attached: boolean;
  actualInstruction?: string;
  yourInstruction?: string;
}): any {
  const { moduleName, result, attached, actualInstruction, yourInstruction } = params;
  const driftWarning = (attached && actualInstruction != null && yourInstruction != null && instructionsDiffer(actualInstruction, yourInstruction))
    ? `Note: your instruction differs from the in-flight one; attaching to the existing session. Response will reflect the in-flight instruction.`
    : null;

  const text = `Module "${moduleName}" is still updating (elapsed ${result.elapsedSec ?? '?'}s, stage=${result.stage ?? 'unknown'}, session=${result.sessionId}). `
    + `Call update_module(${JSON.stringify({ moduleName })}, ...) again with the same arguments to auto-resume.`;

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
      hint: 'Call update_module again with the same arguments to auto-resume. Use get_session_status(sessionId) for a live snapshot, or cancel_session(sessionId) to abort.',
      ...(attached && actualInstruction != null ? { actualInstruction } : {}),
      ...(attached && yourInstruction != null ? { yourInstruction } : {}),
      ...(driftWarning ? { warning: driftWarning } : {}),
    },
  };
}

export function registerUpdateModuleTool(server: McpServer): void {
  server.registerTool(
    'update_module',
    {
      title: 'Update Existing Mock Module',
      description:
        'Modify an existing Mock module. Pass a natural-language instruction describing the desired change (add a field, add an endpoint, tweak response shape, fix a bug). '
        + 'Blocks up to `waitMaxSec` seconds (default 60, max 300); if generation is still running when the window elapses returns { status:"still-running", sessionId } — call this tool again with the same args to auto-resume. '
        + 'If another session for this moduleName is already in-flight, `onConflict` decides: "resume" (default) attaches to it, "reject" returns ALREADY_PROCESSING, "replace" cancels it and starts fresh. '
        + 'Set dry_run=true to preview which entities/fields/endpoints would change without touching files. Triggers a full AI generation cycle; progress streamed via MCP progress notifications.',
      inputSchema: {
        moduleName: z.string(),
        instruction: z.string().describe('Natural-language description of the change'),
        waitMaxSec: z.number().int().optional().describe('Max seconds to block waiting for the run to finish. Default 60, max 300. On timeout returns status="still-running" and the underlying generation keeps going.'),
        onConflict: z.enum(['resume', 'reject', 'replace']).optional().describe('Behavior when another session is already updating this moduleName. Default "resume" (attach + wait).'),
        provider: z.number().int().optional().describe('Provider id to use for this run (must be user-owned or public). Overrides auto-pick.'),
        model: z.string().optional().describe('Model id to use (e.g. "claude-sonnet-4-6"). Overrides provider default.'),
        preset: z.union([z.number().int(), z.string()]).optional().describe('Preset id (number) or preset name (string). Pins response format / field naming / pagination rules.'),
        dry_run: z.boolean().optional(),
      },
    },
    async ({ moduleName, instruction, waitMaxSec, onConflict, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();
      const conflictMode: 'resume' | 'reject' | 'replace' = onConflict ?? 'resume';
      const waitSec = clampWaitMaxSec(waitMaxSec);

      // Module existence
      const existing = db.select().from(modules)
        .where(and(eq(modules.userId, user.userId), eq(modules.name, moduleName)))
        .get();
      if (!existing) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found.`,
          hint: 'Call list_modules to see available modules, or use create_module_from_spec to create a new one.',
          moduleName,
        });
      }

      // Dry run
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
      const yourInstruction = instruction;

      // In-flight check
      const { inFlight, existingSessionId } = findInFlightSession(user.userId, moduleName);

      if (inFlight && conflictMode === 'reject') {
        return mcpError({
          code: MCP_ERROR_CODES.ALREADY_PROCESSING,
          message: `Module "${moduleName}" is already being processed (session ${existingSessionId}). Wait for it to finish or inspect it in the Web UI.`,
          hint: 'Retry without onConflict or with onConflict="resume" to attach + wait. Use onConflict="replace" to cancel and start fresh.',
          moduleName,
          existingSessionId,
        });
      }

      if (inFlight && conflictMode === 'replace') {
        // Cancel existing, wait for it to reach terminal, then start new
        const existingRunner = ChatRunner.get(existingSessionId!);
        if (existingRunner) {
          try { existingRunner.pause(); } catch { /* ignore */ }
        }
        // Wait for the existing session to finalize (up to 10s) so the next in-flight check is clean
        await attachAndWait(existingSessionId!, 10).catch(() => null);
        // fall through to fresh-start
      }

      if (inFlight && conflictMode === 'resume') {
        // Attach to existing in-flight session
        const actualInstruction = readOriginalInstruction(existingSessionId!);
        const sendProgress = makeProgressSender(extra);
        const result = await attachAndWait(existingSessionId!, waitSec, { onProgress: sendProgress });

        if (result.status === 'still-running') {
          return buildStillRunningResponse({ moduleName, result, attached: true, actualInstruction, yourInstruction });
        }
        return buildTerminalResponse({
          userId: user.userId,
          moduleName,
          result,
          before,
          attached: true,
          actualInstruction,
          yourInstruction,
        });
      }

      // Fresh start path (no in-flight OR we just replaced it)
      // Concurrency gate: reserve a slot BEFORE we touch any resources.
      const reservationId = randomUUID();
      const gate = tryAcquire(user.userId, reservationId, moduleName);
      if (!gate.ok) {
        return mcpError({
          code: MCP_ERROR_CODES.BUSY,
          message: `Concurrency limit reached (${gate.scope}): user=${gate.userConcurrent}/${gate.userLimit}, global=${gate.globalConcurrent}/${gate.globalLimit}.`,
          hint: gate.hint,
          scope: gate.scope,
          userConcurrent: gate.userConcurrent,
          userLimit: gate.userLimit,
          globalConcurrent: gate.globalConcurrent,
          globalLimit: gate.globalLimit,
          runningSessions: gate.runningSessions,
        });
      }

      const userContent = buildUpdateUserContent(moduleName, instruction);
      const sendProgress = makeProgressSender(extra);

      let sessionId: string;
      try {
        const started = await startHeadlessSession({
          userId: user.userId,
          userContent,
          title: `[MCP] update ${moduleName}`,
          moduleName,
          providerId: provider,
          model,
          presetId: typeof preset === 'number' ? preset : undefined,
          presetName: typeof preset === 'string' ? preset : undefined,
        });
        sessionId = started.sessionId;
        // Rekey the gate slot to the real sessionId + spin a background release-on-terminal watcher
        release(reservationId);
        tryAcquire(user.userId, sessionId, moduleName);
        void (async () => {
          try { await attachAndWait(sessionId, undefined); } catch { /* ignore */ }
          release(sessionId);
        })();
      } catch (err) {
        release(reservationId);
        const msg = err instanceof Error ? err.message : String(err);
        const isProviderErr = /provider|preset/i.test(msg);
        return mcpError({
          code: isProviderErr ? MCP_ERROR_CODES.PROVIDER_NOT_CONFIGURED : MCP_ERROR_CODES.INTERNAL_ERROR,
          message: msg,
          hint: isProviderErr
            ? 'Configure an AI provider in Settings → Providers, or pass a valid provider id via the "provider" arg.'
            : 'Retry later or inspect server logs.',
          moduleName,
        });
      }

      const result = await attachAndWait(sessionId, waitSec, { onProgress: sendProgress });

      if (result.status === 'still-running') {
        return buildStillRunningResponse({ moduleName, result, attached: false });
      }
      return buildTerminalResponse({
        userId: user.userId,
        moduleName,
        result,
        before,
        attached: false,
      });
    }
  );
}
