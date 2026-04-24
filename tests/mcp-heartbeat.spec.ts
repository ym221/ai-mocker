/**
 * Task 5.4 — heartbeat 单元测试 (HB01-HB02).
 *
 * 启动一个 __fake_slow__ 假流 session,把 heartbeat 间隔调到 500ms,
 * 运行到 terminal 后查 message_events,确认有 heartbeat 事件。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

test.describe('Task 5.4 — heartbeat', () => {
  test('HB01 长 fake session 期间能看到 heartbeat 事件', async () => {
    test.setTimeout(60_000);
    const { ChatRunner } = await import('../src/server/agent/chat-runner.js');
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    ChatRunner.setHeartbeatMsForTest(500);
    try {
      const { sessionId } = await startHeadlessSession({
        userId: 1,
        userContent: '__fake_slow__ hb test',
        title: '[MCP-TEST] HB01 heartbeat',
      });

      const result = await attachAndWait(sessionId, 60);
      expect(result.status).toBe('done');

      const db = new Database(DB_PATH);
      try {
        const row = db.prepare(
          `SELECT COUNT(*) as n FROM message_events WHERE session_id = ? AND type = 'heartbeat'`,
        ).get(sessionId) as { n: number };
        // __fake_slow__ takes ~14s; with 500ms heartbeat we expect many events
        expect(row.n).toBeGreaterThan(3);
      } finally { db.close(); }
    } finally {
      ChatRunner.setHeartbeatMsForTest(null);
    }
  });

  test('HB02 heartbeat payload 含 stage + elapsedSec + currentToolCall', async () => {
    test.setTimeout(60_000);
    const { ChatRunner } = await import('../src/server/agent/chat-runner.js');
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    ChatRunner.setHeartbeatMsForTest(400);
    try {
      const { sessionId } = await startHeadlessSession({
        userId: 1,
        userContent: '__fake_slow__ hb payload test',
        title: '[MCP-TEST] HB02 payload',
      });
      await attachAndWait(sessionId, 60);

      const db = new Database(DB_PATH);
      try {
        const rows = db.prepare(
          `SELECT payload FROM message_events WHERE session_id = ? AND type = 'heartbeat'`,
        ).all(sessionId) as Array<{ payload: string }>;
        expect(rows.length).toBeGreaterThan(0);
        const parsed = JSON.parse(rows[0].payload);
        expect(parsed).toHaveProperty('stage');
        expect(parsed).toHaveProperty('elapsedSec');
        // currentToolCall can be null early; at least one row should have it set later
        const anyWithTool = rows.some((r) => {
          try { return JSON.parse(r.payload).currentToolCall != null; } catch { return false; }
        });
        expect(anyWithTool).toBe(true);
      } finally { db.close(); }
    } finally {
      ChatRunner.setHeartbeatMsForTest(null);
    }
  });
});
