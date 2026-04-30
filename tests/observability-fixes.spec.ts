/**
 * Bug-fix coverage for the "logs exist but percentage = 0%" complaint.
 *
 * Changes verified here:
 *   - timeline-aggregator synthesizes phase rows from tool_timing events
 *     (write_files / run_test / manage_data) so the phase bar reflects time
 *     consumed by tools, not just the chat-runner's prompt_build / llm_thinking
 *     / finalize spans.
 *   - aggregator defensively drops phase_end rows with NaN / negative durationMs
 *     so a single bad emit can't poison the entire bar with NaN%.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

function createSession(): string {
  const id = randomUUID();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
    ).run(id, '[OBS-FIX] aggregator', 1);
    return id;
  } finally {
    db.close();
  }
}

function deleteSession(id: string) {
  const db = new Database(DB_PATH);
  try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id); } finally { db.close(); }
}

/** Insert a synthetic obs event (negative seq) for a session. */
function insertObsEvent(sessionId: string, type: string, payload: Record<string, unknown>) {
  const db = new Database(DB_PATH);
  try {
    const row = db
      .prepare(`SELECT COALESCE(MIN(seq), 0) AS s FROM message_events WHERE session_id = ? AND seq < 0`)
      .get(sessionId) as { s: number } | undefined;
    const seq = (row?.s ?? 0) - 1;
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId, null, seq, type, JSON.stringify(payload),
      new Date().toISOString().replace('T', ' ').slice(0, 19),
    );
  } finally {
    db.close();
  }
}

test.describe('observability fixes — 0%-bug repro', () => {
  test('OB-FIX01 tool_timing events are synthesized into phase rows', async () => {
    const { aggregateTimeline } = await import('../src/server/core/timeline-aggregator.js');
    const sid = createSession();
    try {
      const baseTs = Date.now();
      // Simulate an LLM round + 3 instrumented tool calls
      insertObsEvent(sid, 'phase_end', {
        phase: 'llm_thinking', ts: baseTs, durationMs: 2_000, outcome: 'ok',
      });
      insertObsEvent(sid, 'tool_timing', {
        toolName: 'write_files', startedAt: baseTs + 2_000, finishedAt: baseTs + 22_000,
        durationMs: 20_000, resultSummary: 'ok',
      });
      insertObsEvent(sid, 'tool_timing', {
        toolName: 'run_test', startedAt: baseTs + 22_000, finishedAt: baseTs + 82_000,
        durationMs: 60_000, resultSummary: 'ok',
      });
      insertObsEvent(sid, 'tool_timing', {
        toolName: 'manage_data', startedAt: baseTs + 82_000, finishedAt: baseTs + 87_000,
        durationMs: 5_000, resultSummary: 'ok',
      });

      const tl = aggregateTimeline(sid)!;
      expect(tl).not.toBeNull();
      const phaseNames = tl.phases.map((p) => p.phase).sort();
      expect(phaseNames).toContain('llm_thinking');
      expect(phaseNames).toContain('write_files');
      expect(phaseNames).toContain('run_test');
      expect(phaseNames).toContain('sql_execute'); // manage_data → sql_execute

      // Sum of synthesized phases >>> just llm_thinking, so the bar isn't 99% empty
      const sum = tl.phases.reduce((a, p) => a + p.durationMs, 0);
      expect(sum).toBeGreaterThanOrEqual(87_000);
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-FIX02 NaN / negative durationMs phase_end events are dropped', async () => {
    const { aggregateTimeline } = await import('../src/server/core/timeline-aggregator.js');
    const sid = createSession();
    try {
      const baseTs = Date.now();
      // Good phase
      insertObsEvent(sid, 'phase_end', {
        phase: 'prompt_build', ts: baseTs, durationMs: 100, outcome: 'ok',
      });
      // Bad: missing durationMs entirely → would default to 0; we drop it (<= 0)
      insertObsEvent(sid, 'phase_end', {
        phase: 'llm_thinking', ts: baseTs + 1000, outcome: 'ok',
      });
      // Bad: negative durationMs (clock skew)
      insertObsEvent(sid, 'phase_end', {
        phase: 'finalize', ts: baseTs + 2000, durationMs: -50, outcome: 'ok',
      });

      const tl = aggregateTimeline(sid)!;
      expect(tl).not.toBeNull();
      const phaseNames = tl.phases.map((p) => p.phase);
      expect(phaseNames).toContain('prompt_build');
      expect(phaseNames).not.toContain('llm_thinking');
      expect(phaseNames).not.toContain('finalize');
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-FIX03 unmapped tool_timing names do not pollute phase rows', async () => {
    // list_modules / read_file / set_module_intent etc. are read-only and shouldn't
    // appear in the phase bar even if instrumented as tool_timing.
    const { aggregateTimeline } = await import('../src/server/core/timeline-aggregator.js');
    const sid = createSession();
    try {
      const baseTs = Date.now();
      insertObsEvent(sid, 'tool_timing', {
        toolName: 'list_modules', startedAt: baseTs, finishedAt: baseTs + 50,
        durationMs: 50, resultSummary: 'ok',
      });
      insertObsEvent(sid, 'tool_timing', {
        toolName: 'read_file', startedAt: baseTs + 50, finishedAt: baseTs + 100,
        durationMs: 50, resultSummary: 'ok',
      });

      const tl = aggregateTimeline(sid)!;
      // Tools table still has the entries (so users can see they ran)
      const toolNames = tl.tools.map((t) => t.toolName).sort();
      expect(toolNames).toContain('list_modules');
      expect(toolNames).toContain('read_file');
      // But no synthesized phases for them
      expect(tl.phases.length).toBe(0);
    } finally {
      deleteSession(sid);
    }
  });
});
