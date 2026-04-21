/**
 * mock-router access log 写入 + 10000 滚动 cap 测试
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, ensureUserModule, getToken } from './helpers';

const API = 'http://localhost:3000';
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const USER_ID = 1;

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

function readLogs(userId: number, moduleName?: string) {
  const db = new Database(DB_PATH);
  try {
    if (moduleName) {
      return db.prepare(
        'SELECT * FROM mock_requests WHERE user_id = ? AND module_name = ? ORDER BY id DESC'
      ).all(userId, moduleName) as any[];
    }
    return db.prepare(
      'SELECT * FROM mock_requests WHERE user_id = ? ORDER BY id DESC'
    ).all(userId) as any[];
  } finally {
    db.close();
  }
}

function clearLogsFor(userId: number) {
  const db = new Database(DB_PATH);
  try {
    db.prepare('DELETE FROM mock_requests WHERE user_id = ?').run(userId);
  } finally {
    db.close();
  }
}

test.describe('mock-router access log', () => {
  test('L01 /mock/* 请求写入 mock_requests 表', async () => {
    clearLogsFor(USER_ID);

    // 发 5 个不同请求
    await fetch(`${API}/mock/user`); // GET list
    await fetch(`${API}/mock/user?page=1&pageSize=5`);
    await fetch(`${API}/mock/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'log_test_1', email: 'l1@t.com', password: 'x' }),
    });
    await fetch(`${API}/mock/user/99999`); // GET detail 可能 404
    await fetch(`${API}/mock/user/99999`, { method: 'DELETE' });

    // 给 SQLite 写入时间
    await new Promise((r) => setTimeout(r, 150));

    const logs = readLogs(USER_ID, 'user');
    expect(logs.length).toBeGreaterThanOrEqual(5);
    const first = logs[0];
    expect(first.method).toBeTruthy();
    expect(first.path).toContain('/mock/user');
    expect(typeof first.duration_ms).toBe('number');
    expect(first.status_code).toBeGreaterThan(0);
  });

  test('L02 成功响应的 response_body 被记录', async () => {
    clearLogsFor(USER_ID);
    await fetch(`${API}/mock/user?page=1&pageSize=3`);
    await new Promise((r) => setTimeout(r, 150));

    const logs = readLogs(USER_ID, 'user');
    expect(logs.length).toBeGreaterThan(0);
    // 成功请求的 response_body 应该是 JSON
    const parsed = JSON.parse(logs[0].response_body);
    expect(parsed).toHaveProperty('success');
  });

  test('L03 POST 请求 request_body 被记录', async () => {
    clearLogsFor(USER_ID);
    await fetch(`${API}/mock/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bodytest', email: 'b@t.com', password: 'x' }),
    });
    await new Promise((r) => setTimeout(r, 150));

    const logs = readLogs(USER_ID, 'user').filter((l) => l.method === 'POST');
    expect(logs.length).toBeGreaterThan(0);
    const body = JSON.parse(logs[0].request_body);
    expect(body.username).toBe('bodytest');
  });

  test('L04 长 body 会被截断到 8KB', async () => {
    clearLogsFor(USER_ID);
    const bigValue = 'x'.repeat(20000);
    await fetch(`${API}/mock/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bigbody', email: 'b@t.com', password: bigValue }),
    });
    await new Promise((r) => setTimeout(r, 150));

    const logs = readLogs(USER_ID, 'user').filter((l) => l.method === 'POST');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].request_body.length).toBeLessThan(8300); // 8KB + 截断标记
    expect(logs[0].request_body).toContain('truncated');
  });

  test('L05 trim 按用户滚动 cap 到 10000 条', async () => {
    // 通过 access-log helper 直接注入超过 cap 的数据，避免真实发 11k 请求
    const { recordMockAccess } = await import('../src/server/core/access-log.js');
    clearLogsFor(USER_ID);

    // 先塞 12000 条（每 100 条触发一次 trim，最终应 ≤10000）
    for (let i = 0; i < 12000; i++) {
      recordMockAccess({
        userId: USER_ID,
        moduleName: 'user',
        method: 'GET',
        path: `/mock/user?i=${i}`,
        statusCode: 200,
        durationMs: 1,
      });
    }

    const logs = readLogs(USER_ID, 'user');
    expect(logs.length).toBeLessThanOrEqual(10000);
    expect(logs.length).toBeGreaterThan(9900);

    // 清理以免影响后续测试
    clearLogsFor(USER_ID);
  });
});
