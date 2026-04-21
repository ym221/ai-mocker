/**
 * headless-session helper 单元测试
 *
 * 使用 __fake__ 前缀的 userContent 触发 ChatRunner 的假流生成，
 * 不消耗真实 LLM token，快速验证 start → subscribe → terminal 路径。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => {
  await waitForBackend();
});

test.describe('headless-session helper', () => {
  test('H01 __fake__ content 走一趟拿到 done + 事件序列', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    const progressEvents: any[] = [];
    const result = await runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] headless fake',
      onProgress: (p) => { progressEvents.push(p); },
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);

    // 必含 user 和 done 事件
    const types = result.events.map((e) => e.type);
    expect(types).toContain('user');
    expect(types).toContain('done');

    // sessions 表里应该有这条 session
    const db = new Database(DB_PATH);
    try {
      const row = db.prepare('SELECT id, title, user_id FROM sessions WHERE id = ?').get(result.sessionId) as any;
      expect(row).toBeTruthy();
      expect(row.user_id).toBe(1);
      expect(row.title).toContain('headless fake');
    } finally {
      db.close();
    }
  });

  test('H02 完全没有 active provider 时抛错', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    // 暂时禁用所有 public provider，让 fallback 也空
    const db = new Database(DB_PATH);
    let restored: number[] = [];
    try {
      const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(99) as any;
      if (!existing) {
        db.prepare(
          `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (99, 'notelesser', 'fake', 'nt', 'user')`
        ).run();
      }
      db.prepare('DELETE FROM providers WHERE owner_id = 99').run();

      // 关掉所有 public active providers，记录 id 以便恢复
      const pubs = db.prepare(`SELECT id FROM providers WHERE scope = 'public' AND is_active = 1`).all() as any[];
      restored = pubs.map((r) => r.id);
      for (const id of restored) {
        db.prepare('UPDATE providers SET is_active = 0 WHERE id = ?').run(id);
      }
    } finally {
      db.close();
    }

    try {
      await expect(runHeadlessSession({
        userId: 99,
        userContent: '__fake__',
        title: '[MCP-TEST] no-provider',
      })).rejects.toThrow(/No active AI provider/);
    } finally {
      // 恢复 public provider
      const db2 = new Database(DB_PATH);
      try {
        for (const id of restored) {
          db2.prepare('UPDATE providers SET is_active = 1 WHERE id = ?').run(id);
        }
      } finally {
        db2.close();
      }
    }
  });
});
