/**
 * Step-Observability-1 / Task 1: observability emit helper unit tests.
 *
 * Validates the contract:
 *   - emit calls return immediately (do not block)
 *   - emit failures are silenced (never throw)
 *   - records are persisted into message_events with the correct shape
 *   - flushObservability() actually flushes pending setImmediate writes
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

/**
 * Create a session row that observability events can attach to.
 * message_events has an FK on session_id → sessions.id; no FK on message_id.
 */
function createSession(): string {
  const id = randomUUID();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
    ).run(id, '[OBS-TEST] emit', 1);
    return id;
  } finally {
    db.close();
  }
}

function deleteSession(id: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  } finally {
    db.close();
  }
}

function readEvents(sessionId: string): Array<{ type: string; payload: any; seq: number }> {
  const db = new Database(DB_PATH);
  try {
    const rows = db
      .prepare(`SELECT type, payload, seq FROM message_events WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as Array<{ type: string; payload: string; seq: number }>;
    return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload), seq: r.seq }));
  } finally {
    db.close();
  }
}

test.describe('observability emit (Task 1)', () => {
  test('OB-E01 emitObservability writes a row asynchronously', async () => {
    const obs = await import('../src/server/core/observability.js');
    const sid = createSession();
    try {
      obs.emitObservability(sid, 'phase_start', { phase: 'prompt_build', ts: 12345 });
      // Before flush, row may or may not be present (setImmediate)
      await obs.flushObservability();
      const events = readEvents(sid);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('phase_start');
      expect(events[0].payload.phase).toBe('prompt_build');
      expect(events[0].payload.ts).toBe(12345);
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-E02 emit returns synchronously without blocking', async () => {
    const obs = await import('../src/server/core/observability.js');
    const sid = createSession();
    try {
      const t0 = Date.now();
      for (let i = 0; i < 50; i++) {
        obs.emitObservability(sid, 'phase_start', { phase: 'x', i });
      }
      const dt = Date.now() - t0;
      // 50 emits should be near-instant (no DB IO yet)
      expect(dt).toBeLessThan(50);
      await obs.flushObservability();
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-E03 emit with bad/non-existent session is silent (no throw)', async () => {
    const obs = await import('../src/server/core/observability.js');
    let threw = false;
    try {
      obs.emitObservability('definitely-does-not-exist', 'phase_start', { phase: 'x' });
      await obs.flushObservability();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test('OB-E04 emit when disabled is a no-op', async () => {
    const obs = await import('../src/server/core/observability.js');
    const sid = createSession();
    try {
      obs.setObservabilityEnabled(false);
      obs.emitObservability(sid, 'phase_start', { phase: 'x' });
      await obs.flushObservability();
      expect(readEvents(sid).length).toBe(0);
    } finally {
      obs.setObservabilityEnabled(true);
      deleteSession(sid);
    }
  });

  test('OB-E05 helper functions write the documented payload shape', async () => {
    const obs = await import('../src/server/core/observability.js');
    const sid = createSession();
    try {
      const start = obs.emitPhaseStart(sid, 'write_files');
      await new Promise((r) => setTimeout(r, 5));
      obs.emitPhaseEnd(sid, 'write_files', start, 'ok');
      obs.emitToolTiming(sid, 'write_files', start, 'ok', { files: 5 });
      obs.emitRepair(sid, 'sql_exec_failed', 1, 'CREATE TABLE failed: syntax error', ['schema.sql']);
      obs.emitLlmRound(sid, 1, 1500, { ttftMs: 500, inputTokens: 1000, outputTokens: 200, model: 'gpt-4' });

      await obs.flushObservability();
      const events = readEvents(sid);
      const byType = Object.fromEntries(events.map((e) => [e.type, e.payload]));

      expect(byType.phase_start.phase).toBe('write_files');
      expect(byType.phase_end.phase).toBe('write_files');
      expect(byType.phase_end.outcome).toBe('ok');
      expect(typeof byType.phase_end.durationMs).toBe('number');

      expect(byType.tool_timing.toolName).toBe('write_files');
      expect(byType.tool_timing.argSummary).toEqual({ files: 5 });
      expect(typeof byType.tool_timing.durationMs).toBe('number');

      expect(byType.repair_triggered.cause).toBe('sql_exec_failed');
      expect(byType.repair_triggered.attempt).toBe(1);
      expect(byType.repair_triggered.targetFiles).toEqual(['schema.sql']);
      expect(byType.repair_triggered.errorSnippet).toContain('CREATE TABLE failed');

      expect(byType.llm_round.round).toBe(1);
      expect(byType.llm_round.totalMs).toBe(1500);
      expect(byType.llm_round.ttftMs).toBe(500);
      expect(byType.llm_round.model).toBe('gpt-4');
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-E06 errorSnippet is truncated to 500 chars', async () => {
    const obs = await import('../src/server/core/observability.js');
    const sid = createSession();
    try {
      const huge = 'x'.repeat(2000);
      obs.emitRepair(sid, 'sql_exec_failed', 1, huge);
      await obs.flushObservability();
      const events = readEvents(sid);
      expect(events[0].payload.errorSnippet.length).toBe(500);
    } finally {
      deleteSession(sid);
    }
  });
});
