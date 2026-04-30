/**
 * Observability emit helpers — fire-and-forget event recording.
 *
 * Goals (per STEP-OBSERVABILITY-1-PLAN):
 *  - Reuse the existing `message_events` table; never block the main task.
 *  - All writes go through `setImmediate` so the caller's hot path is not impacted.
 *  - Failures are silenced — observability MUST NOT break the feature it observes.
 *
 * Event types added on top of the existing chat-runner enum
 * (these are stored in message_events.type as plain strings; no schema migration):
 *
 *   - `phase_start`     payload: { phase, ts }
 *   - `phase_end`       payload: { phase, ts, durationMs, outcome }
 *   - `repair_triggered`payload: { cause, attempt, targetFiles?, errorSnippet }
 *   - `tool_timing`     payload: { toolName, startedAt, finishedAt, durationMs, argSummary?, resultSummary? }
 *   - `llm_round`       payload: { round, ttftMs?, totalMs, inputTokens?, outputTokens?, model? }
 *
 * Phase enum (informal — use freely; consumers tolerate unknown values):
 *
 *   prompt_build | llm_thinking | write_files | sql_execute |
 *   run_test     | repair_loop  | finalize
 */

import { sqlite } from './database.js';

// ----- Types -----

export type ObservabilityType =
  | 'phase_start'
  | 'phase_end'
  | 'repair_triggered'
  | 'tool_timing'
  | 'llm_round';

export type ObservabilityPhase =
  | 'prompt_build'
  | 'llm_thinking'
  | 'write_files'
  | 'sql_execute'
  | 'run_test'
  | 'repair_loop'
  | 'finalize'
  | string; // tolerate ad-hoc values

export type RepairCause =
  | 'sql_exec_failed'
  | 'run_test_failed'
  | 'write_failed'
  | 'spec_invalid'
  | 'meta_parse_error'
  | string;

// ----- Internal state -----

/**
 * Observability events live in a NEGATIVE seq space (-1, -2, -3, ...) while
 * primary chat events use POSITIVE seqs (1, 2, 3, ...). This split makes the
 * unique constraint `(session_id, seq)` impossible to violate across the two
 * streams, so observability never collides with `ChatRunner.appendEvent`.
 *
 * The negative-seq + INSERT pair runs inside a single sqlite transaction so
 * concurrent observability emits for the same session can't both compute the
 * same MIN(seq).
 *
 * The timeline aggregation API sorts by `created_at` (not seq), so the split
 * does not affect ordering.
 */
function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const insertObsEventTxn = (() => {
  let cached: ((sessionId: string, messageId: number | null, type: string, payload: string, createdAt: string) => void) | null = null;
  return () => {
    if (!cached) {
      cached = sqlite.transaction((sessionId: string, messageId: number | null, type: string, payload: string, createdAt: string) => {
        const row = sqlite
          .prepare(`SELECT COALESCE(MIN(seq), 0) AS s FROM message_events WHERE session_id = ? AND seq < 0`)
          .get(sessionId) as { s: number } | undefined;
        const seq = (row?.s ?? 0) - 1;
        sqlite
          .prepare(
            `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(sessionId, messageId, seq, type, payload, createdAt);
      });
    }
    return cached;
  };
})();

// ----- Core emit -----

let enabled = true;

/** Disable observability (used in tests where the events table isn't set up). */
export function setObservabilityEnabled(v: boolean): void {
  enabled = v;
}

export function isObservabilityEnabled(): boolean {
  return enabled;
}

/**
 * Schedule an event insert. Returns immediately (next tick).
 * Failures are swallowed — never throws.
 *
 * NOTE: writes go through setImmediate so the caller does not pay any sync IO
 * cost on the hot path. SQLite + better-sqlite3 is sync, so the "async" here
 * is really about deferring the write off the LLM stream loop.
 */
export function emitObservability(
  sessionId: string,
  type: ObservabilityType,
  payload: Record<string, unknown>,
  messageId: number | null = null,
): void {
  if (!enabled) return;
  if (!sessionId) return;

  // Capture timestamp NOW (before defer), so the recorded time is accurate.
  const ts = nowIso();

  setImmediate(() => {
    try {
      const payloadStr = JSON.stringify({ ...payload, _ts: payload._ts ?? Date.now() });
      insertObsEventTxn()(sessionId, messageId, type, payloadStr, ts);
    } catch {
      /* silent — observability must not crash the main task */
    }
  });
}

// ----- Convenience helpers -----

export function emitPhaseStart(
  sessionId: string,
  phase: ObservabilityPhase,
  extra: Record<string, unknown> = {},
  messageId: number | null = null,
): number {
  const startedAt = Date.now();
  emitObservability(sessionId, 'phase_start', { phase, ts: startedAt, ...extra }, messageId);
  return startedAt;
}

export function emitPhaseEnd(
  sessionId: string,
  phase: ObservabilityPhase,
  startedAt: number,
  outcome: 'ok' | 'failed' | 'partial' = 'ok',
  extra: Record<string, unknown> = {},
  messageId: number | null = null,
): void {
  const finishedAt = Date.now();
  emitObservability(
    sessionId,
    'phase_end',
    { phase, ts: finishedAt, durationMs: finishedAt - startedAt, outcome, ...extra },
    messageId,
  );
}

export function emitRepair(
  sessionId: string,
  cause: RepairCause,
  attempt: number,
  errorSnippet: string,
  targetFiles?: string[],
  messageId: number | null = null,
): void {
  const snippet = errorSnippet ? errorSnippet.slice(0, 500) : '';
  emitObservability(
    sessionId,
    'repair_triggered',
    {
      cause,
      attempt,
      targetFiles: targetFiles ?? [],
      errorSnippet: snippet,
    },
    messageId,
  );
}

export function emitToolTiming(
  sessionId: string,
  toolName: string,
  startedAt: number,
  resultSummary: 'ok' | string,
  argSummary?: Record<string, unknown> | string,
  messageId: number | null = null,
): void {
  const finishedAt = Date.now();
  emitObservability(
    sessionId,
    'tool_timing',
    {
      toolName,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      argSummary: argSummary ?? null,
      resultSummary,
    },
    messageId,
  );
}

export function emitLlmRound(
  sessionId: string,
  round: number,
  totalMs: number,
  extra: { ttftMs?: number; inputTokens?: number; outputTokens?: number; model?: string } = {},
  messageId: number | null = null,
): void {
  emitObservability(
    sessionId,
    'llm_round',
    {
      round,
      totalMs,
      ttftMs: extra.ttftMs ?? null,
      inputTokens: extra.inputTokens ?? null,
      outputTokens: extra.outputTokens ?? null,
      model: extra.model ?? null,
    },
    messageId,
  );
}

// ----- Helpers for tests / external callers -----

/**
 * Synchronously flush any pending setImmediate-scheduled emits.
 * Useful in tests where you want to assert state right after emit.
 */
export async function flushObservability(): Promise<void> {
  // setImmediate callbacks run after current macrotask; one tick is enough
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Some environments need a second tick for nested setImmediate
  await new Promise<void>((resolve) => setImmediate(resolve));
}
