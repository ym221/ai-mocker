/**
 * Timeline aggregator — folds raw `message_events` rows into a structured
 * view for the front-end "执行日志" tab.
 *
 * Inputs: rows from message_events (both primary seq>0 and observability seq<0).
 * Output: { totalMs, phases[], tools[], repairs[], llmRounds[], rawEvents[] }
 *
 * Sort key is `created_at` (ISO string) — this works across the two seq spaces
 * since both streams write the same column.
 */

import { sqlite } from './database.js';

export interface RawEvent {
  id: number;
  seq: number;
  type: string;
  payload: any;
  createdAt: string;
}

export interface PhaseRow {
  phase: string;
  startedAtMs: number;
  durationMs: number;
  outcome: 'ok' | 'failed' | 'partial';
  meta?: Record<string, unknown>;
}

export interface ToolStatRow {
  toolName: string;
  count: number;
  totalMs: number;
  avgMs: number;
  errorCount: number;
}

export interface RepairRow {
  attempt: number;
  cause: string;
  targetFiles: string[];
  errorSnippet: string;
  atMs: number;
}

export interface LlmRoundRow {
  round: number;
  totalMs: number;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
}

export interface TimelineSummary {
  sessionId: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  totalMs: number | null;
  status: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'unknown';
  phases: PhaseRow[];
  tools: ToolStatRow[];
  repairs: RepairRow[];
  llmRounds: LlmRoundRow[];
  totals: {
    eventCount: number;
    obsEventCount: number;
    repairCount: number;
    toolCallCount: number;
  };
  rawEvents: RawEvent[];
}

function parsePayload(s: string | null | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function isoToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  // Accept "YYYY-MM-DD HH:MM:SS" (sqlite default) and ISO 8601
  const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(norm);
  return Number.isFinite(t) ? t : null;
}

export function aggregateTimeline(sessionId: string, options: { rawEventLimit?: number } = {}): TimelineSummary | null {
  const rawLimit = options.rawEventLimit ?? 1000;

  // Load session basic info
  const sess = sqlite
    .prepare(`SELECT id, run_status FROM sessions WHERE id = ?`)
    .get(sessionId) as { id: string; run_status: string } | undefined;
  if (!sess) return null;

  // Load all events for this session
  const rows = sqlite
    .prepare(`SELECT id, seq, type, payload, created_at FROM message_events WHERE session_id = ? ORDER BY created_at ASC, id ASC`)
    .all(sessionId) as Array<{ id: number; seq: number; type: string; payload: string; created_at: string }>;

  const rawEvents: RawEvent[] = rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    type: r.type,
    payload: parsePayload(r.payload),
    createdAt: r.created_at,
  }));

  const obsEvents = rawEvents.filter((e) => e.seq < 0);
  const primaryEvents = rawEvents.filter((e) => e.seq > 0);

  // ----- Aggregate phases -----
  const phases: PhaseRow[] = [];
  for (const ev of obsEvents) {
    if (ev.type === 'phase_end') {
      const startedAtMs = (ev.payload.ts ?? 0) - (ev.payload.durationMs ?? 0);
      phases.push({
        phase: String(ev.payload.phase ?? 'unknown'),
        startedAtMs,
        durationMs: Number(ev.payload.durationMs ?? 0),
        outcome: (ev.payload.outcome === 'failed' || ev.payload.outcome === 'partial')
          ? ev.payload.outcome : 'ok',
        meta: { ...ev.payload, phase: undefined, ts: undefined, durationMs: undefined, outcome: undefined, _ts: undefined },
      });
    }
  }
  phases.sort((a, b) => a.startedAtMs - b.startedAtMs);

  // ----- Aggregate tool stats -----
  const toolMap = new Map<string, { count: number; totalMs: number; errors: number }>();
  for (const ev of obsEvents) {
    if (ev.type !== 'tool_timing') continue;
    const name = String(ev.payload.toolName ?? 'unknown');
    const dur = Number(ev.payload.durationMs ?? 0);
    const err = String(ev.payload.resultSummary ?? '').startsWith('error') || ev.payload.resultSummary === 'error';
    const cur = toolMap.get(name) ?? { count: 0, totalMs: 0, errors: 0 };
    cur.count += 1;
    cur.totalMs += dur;
    if (err) cur.errors += 1;
    toolMap.set(name, cur);
  }
  const tools: ToolStatRow[] = Array.from(toolMap.entries()).map(([toolName, v]) => ({
    toolName,
    count: v.count,
    totalMs: v.totalMs,
    avgMs: v.count > 0 ? Math.round(v.totalMs / v.count) : 0,
    errorCount: v.errors,
  })).sort((a, b) => b.totalMs - a.totalMs);

  // ----- Aggregate repairs -----
  const repairs: RepairRow[] = obsEvents
    .filter((e) => e.type === 'repair_triggered')
    .map((e) => ({
      attempt: Number(e.payload.attempt ?? 1),
      cause: String(e.payload.cause ?? 'unknown'),
      targetFiles: Array.isArray(e.payload.targetFiles) ? e.payload.targetFiles : [],
      errorSnippet: String(e.payload.errorSnippet ?? ''),
      atMs: isoToMs(e.createdAt) ?? 0,
    }));

  // ----- Aggregate LLM rounds -----
  const llmRounds: LlmRoundRow[] = obsEvents
    .filter((e) => e.type === 'llm_round')
    .map((e) => ({
      round: Number(e.payload.round ?? 0),
      totalMs: Number(e.payload.totalMs ?? 0),
      ttftMs: e.payload.ttftMs == null ? null : Number(e.payload.ttftMs),
      inputTokens: e.payload.inputTokens == null ? null : Number(e.payload.inputTokens),
      outputTokens: e.payload.outputTokens == null ? null : Number(e.payload.outputTokens),
      model: e.payload.model ?? null,
    }))
    .sort((a, b) => a.round - b.round);

  // ----- Compute total run window -----
  const firstEvent = rawEvents[0];
  const lastEvent = rawEvents[rawEvents.length - 1];
  const startedAtMs = firstEvent ? isoToMs(firstEvent.createdAt) : null;
  const finishedAtMs = lastEvent ? isoToMs(lastEvent.createdAt) : null;
  const totalMs = startedAtMs != null && finishedAtMs != null ? finishedAtMs - startedAtMs : null;

  // status
  const knownStatuses = new Set(['idle', 'running', 'paused', 'done', 'error']);
  const status = knownStatuses.has(sess.run_status) ? (sess.run_status as TimelineSummary['status']) : 'unknown';

  return {
    sessionId,
    startedAtMs,
    finishedAtMs,
    totalMs,
    status,
    phases,
    tools,
    repairs,
    llmRounds,
    totals: {
      eventCount: rawEvents.length,
      obsEventCount: obsEvents.length,
      repairCount: repairs.length,
      toolCallCount: primaryEvents.filter((e) => e.type === 'tool_call').length,
    },
    // Cap raw events to keep response size sane on long sessions
    rawEvents: rawEvents.slice(0, rawLimit),
  };
}
