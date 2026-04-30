/**
 * Step-Observability-1 / Task 2: chat-runner emit integration.
 *
 * Validates that running a session (via the __fake__ pathway, which exercises
 * finalize but not the full LLM stream) produces at least the finalize phase
 * markers. The full LLM-path coverage (prompt_build / llm_thinking / llm_round)
 * is exercised under real-LLM E2E and the timeline aggregation tests.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

function readObsEvents(sessionId: string): Array<{ type: string; payload: any; seq: number; createdAt: string }> {
  const db = new Database(DB_PATH);
  try {
    // Observability events use NEGATIVE seq numbers
    const rows = db
      .prepare(`SELECT type, payload, seq, created_at FROM message_events WHERE session_id = ? AND seq < 0 ORDER BY id ASC`)
      .all(sessionId) as Array<{ type: string; payload: string; seq: number; created_at: string }>;
    return rows.map((r) => ({
      type: r.type,
      payload: JSON.parse(r.payload),
      seq: r.seq,
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

test.describe('chat-runner observability (Task 2)', () => {
  test('OB-CR01 fake runner produces finalize phase markers', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-TEST] OB-CR01',
    });

    const tail = await attachAndWait(sessionId, 30);
    expect(tail.status).toBe('done');

    // Allow setImmediate writes to flush
    await new Promise((r) => setTimeout(r, 200));

    const events = readObsEvents(sessionId);
    const types = events.map((e) => e.type);

    // Must have at least the finalize bracket (fake runner doesn't go through runAIGeneration)
    expect(types).toContain('phase_start');
    expect(types).toContain('phase_end');

    const finalizeStart = events.find((e) => e.type === 'phase_start' && e.payload.phase === 'finalize');
    const finalizeEnd = events.find((e) => e.type === 'phase_end' && e.payload.phase === 'finalize');
    expect(finalizeStart).toBeTruthy();
    expect(finalizeEnd).toBeTruthy();
    expect(finalizeEnd!.payload.outcome).toBe('ok');
    expect(typeof finalizeEnd!.payload.durationMs).toBe('number');
  });

  test('OB-CR02 observability events use negative seq (no collision with primary)', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-TEST] OB-CR02',
    });

    await attachAndWait(sessionId, 30);
    await new Promise((r) => setTimeout(r, 200));

    const db = new Database(DB_PATH);
    try {
      const allEvents = db
        .prepare(`SELECT seq, type FROM message_events WHERE session_id = ? ORDER BY id`)
        .all(sessionId) as Array<{ seq: number; type: string }>;

      const positive = allEvents.filter((e) => e.seq > 0);
      const negative = allEvents.filter((e) => e.seq < 0);

      // Both populated
      expect(positive.length).toBeGreaterThan(0);
      expect(negative.length).toBeGreaterThan(0);

      // Negative ones are exactly the observability event types
      const obsTypes = new Set(['phase_start', 'phase_end', 'tool_timing', 'repair_triggered', 'llm_round']);
      for (const ev of negative) {
        expect(obsTypes.has(ev.type)).toBe(true);
      }
      // Negative seqs are unique
      const negSeqs = negative.map((e) => e.seq);
      expect(new Set(negSeqs).size).toBe(negSeqs.length);
    } finally {
      db.close();
    }
  });

  test('OB-CR03 phase markers do not appear in primary stream subscribe path', async () => {
    // Negative seq = filtered out by ChatRunner.subscribe (which uses afterSeq>0).
    // This test asserts that the existing replay mechanism is unaffected.
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    const { sessionId, runner } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-TEST] OB-CR03',
    });

    await attachAndWait(sessionId, 30);
    await new Promise((r) => setTimeout(r, 200));

    // Replay all primary events from 0
    const collected: string[] = [];
    for await (const ev of runner.subscribe(0)) {
      collected.push(ev.type);
      if (ev.type === 'done' || ev.type === 'error') break;
    }
    // No observability event types should show up
    const obsTypes = new Set(['phase_start', 'phase_end', 'tool_timing', 'repair_triggered', 'llm_round']);
    for (const t of collected) {
      expect(obsTypes.has(t)).toBe(false);
    }
  });
});
