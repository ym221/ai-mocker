/**
 * Step-Observability-1 / Task 4: timeline aggregation API tests.
 *
 * Validates GET /api/sessions/:id/timeline and GET /api/modules/:name/timeline.
 */
import { test, expect } from '@playwright/test';
import { getToken, waitForBackend } from './helpers';

const API = 'http://localhost:3000';

test.beforeAll(async () => { await waitForBackend(); });

async function authedGet(path: string) {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test.describe('timeline API (Task 4)', () => {
  test('OB-API01 timeline of fake-runner session aggregates phases + tools', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-API-TEST] OB-API01',
    });
    await attachAndWait(sessionId, 30);
    await new Promise((r) => setTimeout(r, 250));

    const { status, body } = await authedGet(`/api/sessions/${sessionId}/timeline`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const tl = body.data;

    expect(tl.sessionId).toBe(sessionId);
    expect(tl.status).toBe('done');
    expect(Array.isArray(tl.phases)).toBe(true);
    expect(Array.isArray(tl.tools)).toBe(true);
    expect(Array.isArray(tl.repairs)).toBe(true);
    expect(Array.isArray(tl.llmRounds)).toBe(true);
    expect(typeof tl.totals.eventCount).toBe('number');
    expect(tl.totals.eventCount).toBeGreaterThan(0);

    // At least the finalize phase should be there from chat-runner emit
    const finalize = tl.phases.find((p: any) => p.phase === 'finalize');
    expect(finalize).toBeTruthy();
    expect(typeof finalize.durationMs).toBe('number');
    expect(['ok', 'failed', 'partial']).toContain(finalize.outcome);
  });

  test('OB-API02 unknown session returns 404', async () => {
    const { status, body } = await authedGet(`/api/sessions/no-such-session-id/timeline`);
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('OB-API03 module timeline picks most recent session', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    // Use a fresh module name; bind sessions to it via moduleName
    const moduleName = `obs_api03_${Date.now()}`;

    // Manually create a session that targets this module
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const { randomUUID } = await import('crypto');
    const dbPath = resolve(process.cwd(), 'data', 'mockforge.db');

    const sid = randomUUID();
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, user_id, module_name, run_status, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 'idle', 0, ?, ?)`,
      ).run(sid, '[OBS-API-TEST] OB-API03', 1, moduleName, '2024-01-01 00:00:00', '2099-01-01 00:00:00');
    } finally {
      db.close();
    }

    // Emit a couple of obs events directly to that session so the timeline isn't empty
    const { emitPhaseStart, emitPhaseEnd, flushObservability } = await import('../src/server/core/observability.js');
    const start = emitPhaseStart(sid, 'finalize');
    emitPhaseEnd(sid, 'finalize', start, 'ok');
    await flushObservability();

    const { status, body } = await authedGet(`/api/modules/${moduleName}/timeline`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.available).toBe(true);
    expect(body.data.sessionId).toBe(sid);

    // Cleanup
    const cleanup = new Database(dbPath);
    try { cleanup.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { cleanup.close(); }
  });

  test('OB-API04 module timeline with no sessions returns available:false', async () => {
    const { status, body } = await authedGet(`/api/modules/__never_created_${Date.now()}/timeline`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.available).toBe(false);
  });

  test('OB-API06 set_module_intent links session.module_name (so module timeline finds it)', async () => {
    // Simulate the chat flow: a user starts a chat WITHOUT specifying a module,
    // then the AI calls set_module_intent mid-stream. The session's
    // module_name column should be auto-populated so /api/modules/:name/timeline
    // can find this session afterwards.
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const { randomUUID } = await import('crypto');
    const dbPath = resolve(process.cwd(), 'data', 'mockforge.db');

    const sid = randomUUID();
    const moduleName = `obs_link_${Date.now()}`;
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, user_id, run_status, last_seq, created_at, updated_at) VALUES (?, ?, ?, 'idle', 0, ?, ?)`,
      ).run(sid, '[OBS-API06]', 1, '2024-01-01 00:00:00', '2099-01-01 00:00:00');
    } finally {
      db.close();
    }

    try {
      // Get/Create the runner and call applyModuleIntent — this is what the
      // set_module_intent tool does.
      const { ChatRunner } = await import('../src/server/agent/chat-runner.js');
      const runner = ChatRunner.getOrCreate(sid);
      runner.applyModuleIntent(1, { moduleName, operation: 'create' });

      // session.module_name should now be set
      const db2 = new Database(dbPath);
      try {
        const row = db2.prepare(`SELECT module_name FROM sessions WHERE id = ?`).get(sid) as { module_name: string };
        expect(row.module_name).toBe(moduleName);
      } finally { db2.close(); }

      // Module-timeline lookup picks up the session
      const { status, body } = await authedGet(`/api/modules/${moduleName}/timeline`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.available).toBe(true);
      expect(body.data.sessionId).toBe(sid);
    } finally {
      // Cleanup
      const cleanup = new Database(dbPath);
      try {
        cleanup.prepare(`DELETE FROM modules WHERE name = ?`).run(moduleName);
        cleanup.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
      } finally { cleanup.close(); }
    }
  });

  test('OB-API05 phases array is sorted by startedAtMs', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-API-TEST] OB-API05',
    });
    await attachAndWait(sessionId, 30);
    await new Promise((r) => setTimeout(r, 250));

    const { body } = await authedGet(`/api/sessions/${sessionId}/timeline`);
    const phases = body.data.phases;
    if (phases.length > 1) {
      for (let i = 1; i < phases.length; i++) {
        expect(phases[i].startedAtMs).toBeGreaterThanOrEqual(phases[i - 1].startedAtMs);
      }
    }
  });
});
