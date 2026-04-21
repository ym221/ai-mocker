/**
 * mock-router 响应处理测试 — controller 返回值是权威的。
 *
 * 验证新语义:
 *   1) {success:false} 默认 200 (旧逻辑会是 404 — 那行已删)
 *   2) statusCode 字段显式覆盖状态码
 *   3) __mock__ 逃生舱完全接管响应 (status/headers/body)
 *   4) 阿里风格 {code, data, msg} 默认 200
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend } from './helpers';

const API = 'http://localhost:3000';
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'resptest';

const META = {
  name: MODULE,
  displayName: '响应测试',
  description: 'mock-router 响应语义测试',
  basePath: `/mock/${MODULE}`,
  version: 1,
  status: 'active',
  entities: [{ name: 'x', tableName: `mock__${MODULE}`, displayName: 'X', fields: [] }],
  endpoints: [
    { method: 'GET', path: '/ok', name: 'ok', type: 'custom', handler: 'handleOk' },
    { method: 'GET', path: '/biz-fail', name: 'biz-fail', type: 'custom', handler: 'handleBizFail' },
    { method: 'GET', path: '/status-422', name: 'status-422', type: 'custom', handler: 'handle422' },
    { method: 'GET', path: '/status-404', name: 'status-404', type: 'custom', handler: 'handle404' },
    { method: 'GET', path: '/redirect', name: 'redirect', type: 'custom', handler: 'handleRedirect' },
    { method: 'GET', path: '/aliyun', name: 'aliyun', type: 'custom', handler: 'handleAliyun' },
    { method: 'GET', path: '/status-invalid', name: 'status-invalid', type: 'custom', handler: 'handleInvalidStatus' },
    { method: 'GET', path: '/mock-empty', name: 'mock-empty', type: 'custom', handler: 'handleMockEmpty' },
  ],
  config: { delay: { min: 0, max: 0 }, errorRate: 0 },
};

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`;

const CONTROLLER_TS = `// Test-only controller: exercises every response shape mock-router must support.
export function handleOk() {
  return { success: true, data: { id: 1, name: 'ok' } };
}

export function handleBizFail() {
  // Business-validation failure: controller wants 200 with success:false.
  // Old mock-router mapped this to 404; new behavior is 200.
  return { success: false, message: 'business rule violated' };
}

export function handle422() {
  return { success: false, message: 'validation error', statusCode: 422 };
}

export function handle404() {
  return { success: false, message: 'not found', statusCode: 404 };
}

export function handleRedirect() {
  return {
    __mock__: {
      status: 303,
      headers: { Location: '/mock/${MODULE}/ok', 'X-Custom': 'foo' },
      body: null,
    },
  };
}

export function handleAliyun() {
  return { code: 0, data: [{ a: 1 }, { a: 2 }], msg: 'ok' };
}

export function handleInvalidStatus() {
  // Invalid statusCode should fall back to default 200 behavior, body preserved as-is
  return { success: false, statusCode: 'not-a-number' };
}

export function handleMockEmpty() {
  // __mock__ without status → default 200
  return { __mock__: { body: { just: 'body' } } };
}
`;

function ensureResptestModule() {
  if (!existsSync(DB_PATH)) throw new Error('Backend must run at least once first');

  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, '_meta.json'), JSON.stringify(META, null, 2), 'utf-8');
  writeFileSync(join(dir, 'schema.sql'), SCHEMA_SQL, 'utf-8');
  writeFileSync(join(dir, 'controller.ts'), CONTROLLER_TS, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), `import { test, assert, request } from '@core/test-runner.js';\ntest('noop', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}\n响应测试用模块\n`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE} API\n测试用\n`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    const injectedSql = SCHEMA_SQL
      .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${USER_ID}_$1\``);
    db.exec(injectedSql);
    const existing = db.prepare('SELECT id FROM modules WHERE name = ? AND user_id = ?')
      .get(MODULE, USER_ID) as { id: number } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(MODULE, USER_ID, META.displayName, META.description, META.basePath);
    } else {
      db.prepare(`UPDATE modules SET status='active', error_message=NULL WHERE id=?`).run(existing.id);
    }
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  await waitForBackend();
  ensureResptestModule();
  // Give tsx/node a moment to pick up the new controller file (dynamic import uses t=Date.now() busting cache each call)
  await new Promise((r) => setTimeout(r, 200));
});

test.describe('mock-router response semantics', () => {
  test('MR01 {success:true} → 200', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/ok`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('ok');
  });

  test('MR02 {success:false} without statusCode → 200 (new behavior, was 404)', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/biz-fail`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toBe('business rule violated');
  });

  test('MR03 statusCode:422 → 422', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/status-422`);
    expect(res.status).toBe(422);
    const body = await res.json();
    // statusCode field should be stripped from the body
    expect(body).not.toHaveProperty('statusCode');
    expect(body.success).toBe(false);
    expect(body.message).toBe('validation error');
  });

  test('MR04 statusCode:404 → 404', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/status-404`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toBe('not found');
  });

  test('MR05 __mock__ escape hatch → 303 + headers + null body', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/redirect`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/mock/${MODULE}/ok`);
    expect(res.headers.get('x-custom')).toBe('foo');
  });

  test('MR06 aliyun-style {code,data,msg} → 200', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/aliyun`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.msg).toBe('ok');
  });

  test('MR07 invalid statusCode → default 200 (graceful fallback)', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/status-invalid`);
    expect(res.status).toBe(200);
  });

  test('MR08 __mock__ without status → default 200', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/mock-empty`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ just: 'body' });
  });
});

test.afterAll(() => {
  // Cleanup fixture files (DB row left intact — harmless)
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
