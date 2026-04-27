/**
 * Shared engine for heavy MCP write tools (create_module_from_spec, update_module).
 *
 * Handles everything both tools have in common:
 * - waitMaxSec clamping + default
 * - onConflict routing (resume / reject / replace)
 * - in-flight detection + existing-session lookup
 * - concurrency-gate acquire / release (with terminal-release watcher)
 * - progress notification plumbing
 * - attach-to-existing with drift warning
 *
 * Tool-specific pieces (userContent wrapper, success response shape, drift
 * warning text) are supplied via callbacks in the WriteToolContext.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { and, eq } from 'drizzle-orm';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { ChatRunner } from '../../agent/chat-runner.js';
import {
  startHeadlessSession,
  attachAndWait,
  type HeadlessProgress,
  type HeadlessResult,
} from './headless-session.js';
import { findInFlightSession } from './in-flight-lock.js';
import { tryAcquire, release } from './concurrency-gate.js';
import { instructionsDiffer } from './instruction-utils.js';
import { MCP_ERROR_CODES, mcpError } from './error-codes.js';
import { humanizeStage } from './stage-humanize.js';

const DEFAULT_WAIT_MAX_SEC = 180;  // 3 min, aligned with real-LLM tool-call cadence
const MAX_WAIT_MAX_SEC = 300;

export type OnConflict = 'resume' | 'reject' | 'replace';

export interface WriteToolContext {
  userId: number;
  /** Name of the module being created/edited. For create-from-spec it may be null
   *  if user didn't pre-specify a name (AI infers it during generation). */
  moduleName: string | null;

  /** Max seconds to block inside this call before returning still-running. */
  waitMaxSec?: number;
  /** Behavior when another session is already running for this (user, moduleName). */
  onConflict?: OnConflict;

  /** Provider / preset overrides. */
  provider?: number;
  model?: string;
  preset?: number | string;

  /** MCP tool's `extra` argument (carries sendNotification + progressToken). */
  extra: any;

  /** Assembled user content to feed into ChatRunner. */
  userContent: string;
  /** Session title (appears in Web UI sessions list). */
  title: string;

  /** What the caller sent this round — used to detect drift on attach. */
  yourInstruction: string;
  /**
   * Given a prior session's first user-message content, return the "original"
   * instruction string (strip wrappers). Used to compute drift warning.
   */
  extractOriginalFromContent: (content: string) => string;

  /** Build the terminal-success response. `result.status` will be 'done' here. */
  buildSuccessResponse: (args: SuccessArgs) => any;
  /** Build the still-running response. */
  buildStillRunningResponse: (args: RunningArgs) => any;
  /**
   * Optional override for non-done terminal states (error / paused / aborted).
   * Default is a generic WAIT_TIMEOUT / INTERNAL_ERROR mcpError.
   */
  buildNonDoneTerminalResponse?: (args: NonDoneArgs) => any;

  /** Short label for error messages, e.g. "update" / "create". */
  toolKind: 'update' | 'create';
}

export interface SuccessArgs {
  result: HeadlessResult;
  attached: boolean;
  driftWarning: string | null;
  actualInstruction: string | null;
  /** This is the resolved module name — never null for update; for create it
   *  may be populated by the caller from card events if user didn't pre-specify.*/
  resolvedModuleName: string | null;
}

export interface RunningArgs {
  result: HeadlessResult;
  attached: boolean;
  driftWarning: string | null;
  actualInstruction: string | null;
}

export interface NonDoneArgs {
  result: HeadlessResult;
  attached: boolean;
}

export function clampWaitMaxSec(raw: number | undefined): number {
  if (raw == null) return DEFAULT_WAIT_MAX_SEC;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MAX_SEC;
  return Math.min(n, MAX_WAIT_MAX_SEC);
}

export function makeProgressSender(extra: any) {
  const sendNotification = extra?.sendNotification;
  const progressToken = extra?._meta?.progressToken;
  return async (p: HeadlessProgress) => {
    if (!sendNotification || !progressToken) return;
    try {
      // Humanize the stage for the MCP client (AI sees friendly phrase + raw stage)
      const toolName = (p.detail as any)?.tool as string | undefined;
      const rawStage = p.stage === 'tool' && toolName ? `tool:${toolName}` : p.stage;
      const { description } = humanizeStage(rawStage);
      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: p.seq,
          message: description,
        },
      });
    } catch { /* ignore */ }
  };
}

function readFirstUserMessageContent(sessionId: string): string {
  const row = sqlite.prepare(
    `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`,
  ).get(sessionId) as { content: string } | undefined;
  return row?.content ?? '';
}

function computeDriftWarning(
  toolKind: 'update' | 'create',
  actualInstruction: string | null,
  yourInstruction: string,
): string | null {
  if (!actualInstruction) return null;
  if (!instructionsDiffer(actualInstruction, yourInstruction)) return null;
  if (toolKind === 'update') {
    return `Note: your instruction ("${yourInstruction}") differs from what's actually executing ("${actualInstruction}"). The result returned is from the executing one. If you meant to start fresh with new instructions, call this again with onConflict: 'replace'.`;
  }
  return `Note: your spec differs from the in-flight one. The result returned is from the executing one. If you meant to start fresh, call this with onConflict: 'replace' (and pass a moduleName).`;
}

/**
 * Core routine shared by update_module + create_module_from_spec.
 *
 * Flow:
 *   1. Resolve onConflict default + clamp waitMaxSec
 *   2. Check in-flight session (if moduleName is known)
 *      - reject  → MOCKFORGE_ALREADY_PROCESSING
 *      - replace → cancel existing + wait terminal + fall through to fresh
 *      - resume (default) → attachAndWait to existing, with drift detection
 *   3. Fresh start: acquire concurrency slot → startHeadlessSession →
 *      rekey slot → spawn background release-on-terminal watcher →
 *      attachAndWait within waitMaxSec window
 *   4. Route final state to one of three response builders.
 */
export async function runWriteTool(ctx: WriteToolContext): Promise<any> {
  const conflictMode: OnConflict = ctx.onConflict ?? 'resume';
  const waitSec = clampWaitMaxSec(ctx.waitMaxSec);
  const sendProgress = makeProgressSender(ctx.extra);

  // -------- in-flight check (only meaningful when moduleName known) --------
  if (ctx.moduleName) {
    const { inFlight, existingSessionId } = findInFlightSession(ctx.userId, ctx.moduleName);

    if (inFlight && conflictMode === 'reject') {
      return mcpError({
        code: MCP_ERROR_CODES.ALREADY_PROCESSING,
        message: `Module "${ctx.moduleName}" is already being processed (session ${existingSessionId}). Wait for it to finish or inspect it in the Web UI.`,
        hint: 'Retry without onConflict or with onConflict="resume" to attach + wait. Use onConflict="replace" to cancel and start fresh.',
        moduleName: ctx.moduleName,
        existingSessionId,
      });
    }

    if (inFlight && conflictMode === 'replace' && existingSessionId) {
      const runner = ChatRunner.get(existingSessionId);
      if (runner) { try { runner.pause(); } catch { /* ignore */ } }
      await attachAndWait(existingSessionId, 10).catch(() => null);
      // fall through to fresh-start
    }

    if (inFlight && conflictMode === 'resume' && existingSessionId) {
      const originalContent = readFirstUserMessageContent(existingSessionId);
      const actualInstruction = ctx.extractOriginalFromContent(originalContent);
      const driftWarning = computeDriftWarning(ctx.toolKind, actualInstruction, ctx.yourInstruction);
      const result = await attachAndWait(existingSessionId, waitSec, { onProgress: sendProgress });

      if (result.status === 'still-running') {
        return ctx.buildStillRunningResponse({ result, attached: true, driftWarning, actualInstruction });
      }
      if (result.status !== 'done') {
        return defaultNonDone(ctx, { result, attached: true });
      }
      // Phantom-success guard: registered + 5 files
      if (ctx.toolKind === 'create' && ctx.moduleName) {
        if (!moduleIsRegistered(ctx.userId, ctx.moduleName)) {
          return mcpError({
            code: MCP_ERROR_CODES.INTERNAL_ERROR,
            message: `Generation session ${existingSessionId} reached 'done' but module "${ctx.moduleName}" was not registered (no _meta.json written).`,
            hint: 'Retry with onConflict="replace" or switch to a stronger model.',
            moduleName: ctx.moduleName,
            sessionId: existingSessionId,
            phantomSuccess: true,
          });
        }
        const missing = listMissingFiles(ctx.userId, ctx.moduleName);
        if (missing.length > 0) {
          return mcpError({
            code: MCP_ERROR_CODES.INTERNAL_ERROR,
            message: `Generation session ${existingSessionId} reached 'done' but module "${ctx.moduleName}" is incomplete — missing files: ${missing.join(', ')}.`,
            hint: 'Retry with onConflict="replace" to regenerate, or call update_module with explicit file-write instructions.',
            moduleName: ctx.moduleName,
            sessionId: existingSessionId,
            phantomSuccess: true,
            missingFiles: missing,
          });
        }
      }
      return ctx.buildSuccessResponse({
        result, attached: true, driftWarning, actualInstruction, resolvedModuleName: ctx.moduleName,
      });
    }
  }

  // -------- fresh start path --------
  const reservationId = randomUUID();
  const gate = tryAcquire(ctx.userId, reservationId, ctx.moduleName);
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

  let sessionId: string;
  try {
    const started = await startHeadlessSession({
      userId: ctx.userId,
      userContent: ctx.userContent,
      title: ctx.title,
      moduleName: ctx.moduleName ?? undefined,
      providerId: ctx.provider,
      model: ctx.model,
      presetId: typeof ctx.preset === 'number' ? ctx.preset : undefined,
      presetName: typeof ctx.preset === 'string' ? ctx.preset : undefined,
    });
    sessionId = started.sessionId;
    release(reservationId);
    tryAcquire(ctx.userId, sessionId, ctx.moduleName);
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
      moduleName: ctx.moduleName ?? null,
    });
  }

  const result = await attachAndWait(sessionId, waitSec, { onProgress: sendProgress });
  if (result.status === 'still-running') {
    return ctx.buildStillRunningResponse({ result, attached: false, driftWarning: null, actualInstruction: null });
  }
  if (result.status !== 'done') {
    return defaultNonDone(ctx, { result, attached: false });
  }
  // Phantom-success guard: registered + 5 files
  if (ctx.toolKind === 'create' && ctx.moduleName) {
    if (!moduleIsRegistered(ctx.userId, ctx.moduleName)) {
      return mcpError({
        code: MCP_ERROR_CODES.INTERNAL_ERROR,
        message: `Generation session ${sessionId} reached 'done' but module "${ctx.moduleName}" was not registered.`,
        hint: 'Retry with onConflict="replace" or switch to a stronger model.',
        moduleName: ctx.moduleName,
        sessionId,
        phantomSuccess: true,
      });
    }
    const missing = listMissingFiles(ctx.userId, ctx.moduleName);
    if (missing.length > 0) {
      return mcpError({
        code: MCP_ERROR_CODES.INTERNAL_ERROR,
        message: `Generation session ${sessionId} reached 'done' but module "${ctx.moduleName}" is incomplete — missing files: ${missing.join(', ')}.`,
        hint: 'Retry with onConflict="replace" or call update_module with explicit file-write instructions.',
        moduleName: ctx.moduleName,
        sessionId,
        phantomSuccess: true,
        missingFiles: missing,
      });
    }
  }
  return ctx.buildSuccessResponse({
    result, attached: false, driftWarning: null, actualInstruction: null, resolvedModuleName: ctx.moduleName,
  });
}

/**
 * Phantom-success guard (Round-2 finding).
 *
 * The model can finish a session with `runStatus='done'` while having produced
 * zero meaningful output (no thinking, no tool_call) OR partial output (e.g.
 * only 2 of 5 required files). Both cases used to return status:'created' to
 * the caller, who then hit MODULE_NOT_FOUND or health=degraded downstream.
 *
 * Verify both: (a) module is registered in `modules` table, (b) all 5 required
 * files exist on disk. Either failure → surface a clear error.
 */
function moduleIsRegistered(userId: number, moduleName: string): boolean {
  const row = db.select()
    .from(modules)
    .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
    .get();
  return !!row;
}

const REQUIRED_MODULE_FILES = ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts', 'api-doc.md'];

function listMissingFiles(userId: number, moduleName: string): string[] {
  const dir = join(resolve('generated'), String(userId), moduleName);
  return REQUIRED_MODULE_FILES.filter(f => !existsSync(join(dir, f)));
}

function defaultNonDone(ctx: WriteToolContext, args: NonDoneArgs): any {
  if (ctx.buildNonDoneTerminalResponse) return ctx.buildNonDoneTerminalResponse(args);
  const { result, attached } = args;
  const code = result.status === 'error' ? MCP_ERROR_CODES.INTERNAL_ERROR : MCP_ERROR_CODES.WAIT_TIMEOUT;
  const verb = ctx.toolKind === 'update' ? 'Update' : 'Generation';
  return mcpError({
    code,
    message: `${verb} ended with status=${result.status}${result.errorMessage ? ': ' + result.errorMessage : ''}. Session: ${result.sessionId}`,
    hint: 'Inspect the session in the Web UI. If it was interrupted, call the tool again with the same arguments — it will resume automatically.',
    moduleName: ctx.moduleName ?? null,
    sessionId: result.sessionId,
    status: result.status,
    errorMessage: result.errorMessage,
    attached,
  });
}
