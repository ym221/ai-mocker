/**
 * Task 5.1 — headless-session 拆分为 start + attach 两相。
 *
 * 验证:
 * - startHeadlessSession 立即返回 sessionId (无需等 terminal)
 * - attachAndWait 能从 seq=0 拿到 done
 * - attachAndWait 的 waitMaxSec 超时返回 still-running (runner 继续在后台跑)
 * - attachToExisting 能复用现有 runner
 * - runHeadlessSession 的 legacy 门面行为与 MCP-2/3/4 相同
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

function forceTerminal(sessionId: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE id = ? AND run_status = 'running'`).run(sessionId);
  } finally { db.close(); }
}

test.describe('headless-attach (Task 5.1)', () => {
  test('HA01 startHeadlessSession 立即返回 sessionId', async () => {
    const { startHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    const t0 = Date.now();
    const { sessionId, runner } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] HA01 start',
    });
    const dt = Date.now() - t0;

    expect(sessionId).toBeTruthy();
    expect(runner).toBeTruthy();
    // Should return quickly (<2s) — no waiting for terminal
    expect(dt).toBeLessThan(3000);

    // Wait for it to finish so we don't leave runner hanging
    const { attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');
    const tail = await attachAndWait(sessionId, 30);
    expect(tail.status).toBe('done');
  });

  test('HA02 attachAndWait 拿到 done', async () => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');
    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] HA02 attach',
    });

    const result = await attachAndWait(sessionId, 30);
    expect(result.status).toBe('done');
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.type === 'done')).toBe(true);
  });

  test('HA03 waitMaxSec 超时返 still-running + runner 继续在后台跑', async () => {
    test.setTimeout(120_000);
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');
    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake_slow__',
      title: '[MCP-TEST] HA03 timeout',
    });

    // __fake_slow__ takes ~12-18s; attach with waitMaxSec=1 should timeout well before it's done
    const first = await attachAndWait(sessionId, 1);
    expect(first.status).toBe('still-running');
    expect(first.sessionId).toBe(sessionId);
    expect(first.stage).toBeTruthy();
    expect(first.lastEventSeq).toBeGreaterThan(0);
    expect(typeof first.elapsedSec).toBe('number');

    // Re-attach and wait to completion (resume from 0 is fine — DB replay is cheap + idempotent)
    const second = await attachAndWait(sessionId, 90);
    expect(second.status).toBe('done');
  });

  test('HA04 attachToExisting 复用现有 runner', async () => {
    const { startHeadlessSession, attachToExisting } = await import('../src/server/mcp/lib/headless-session.js');
    const { sessionId, runner } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake_slow__',
      title: '[MCP-TEST] HA04 reattach',
    });

    // Don't await first attach — just ensure it kicks off
    const attach1 = attachToExisting(sessionId, 60);

    // Second attacher joins the same runner
    const attach2 = attachToExisting(sessionId, 60);

    const [r1, r2] = await Promise.all([attach1, attach2]);
    expect(r1.status).toBe('done');
    expect(r2.status).toBe('done');
    // Both saw the same sessionId
    expect(r1.sessionId).toBe(sessionId);
    expect(r2.sessionId).toBe(sessionId);
    // Runner should still be the same reference during startup
    expect(runner.sessionId).toBe(sessionId);
  });

  test('HA05 legacy runHeadlessSession 行为不变', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    const result = await runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] HA05 legacy',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    const types = result.events.map((e) => e.type);
    expect(types).toContain('user');
    expect(types).toContain('done');

    const db = new Database(DB_PATH);
    try {
      const row = db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(result.sessionId) as any;
      expect(row).toBeTruthy();
      expect(row.title).toContain('HA05 legacy');
    } finally { db.close(); }
  });
});
