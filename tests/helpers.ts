import { type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';

const API = 'http://localhost:3000';
const NO_PROXY_FETCH: RequestInit = {};

/** 等待后端就绪 */
export async function waitForBackend() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Backend not ready after 15s');
}

/** 通过 UI 登录（Playwright 页面） */
export async function login(page: Page, username = 'admin', password = 'admin123') {
  await page.goto('/login');
  await page.waitForSelector('input[type="text"]', { timeout: 10000 });
  await page.fill('input[type="text"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(chat|modules|settings|admin)/, { timeout: 15000 });
}

/** 通过 API 获取 token */
export async function getToken(username = 'admin', password = 'admin123'): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message);
  return data.data.token;
}

/** 带认证的 API 请求 */
export async function apiRequest(
  method: string,
  path: string,
  token: string,
  body?: any,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json };
}

/** 不带认证的 API 请求 */
export async function apiRequestNoAuth(
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json };
}

/** 等待 toast 出现并返回文字 */
export async function waitForToast(page: Page, timeout = 5000): Promise<string> {
  const toast = page.locator('[data-sonner-toast]').first();
  await toast.waitFor({ state: 'visible', timeout });
  return toast.textContent() as Promise<string>;
}

/** 检查 toast 包含指定文字 */
export async function expectToast(page: Page, text: string, timeout = 5000) {
  const toast = page.locator(`[data-sonner-toast]:has-text("${text}")`).first();
  await toast.waitFor({ state: 'visible', timeout });
}

/**
 * 创建新会话:点"新建对话"按钮直接创建(不再弹 dialog)。
 * 使用用户的默认 provider + 该 provider 的默认 model + 无 preset。
 */
export async function startNewChatSession(page: Page) {
  await page.click('[data-testid="new-session-btn"]');
  // session 创建是异步的,等 chat 路由切到具体会话 + UI 稳定
  await page.waitForURL(/\/chat\/[\w-]+/, { timeout: 5000 }).catch(() => { /* 已在该路由也算成功 */ });
  await page.waitForTimeout(300);
}

// ==================== Fixture bootstrap ====================

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;

const USER_META = {
  name: 'user',
  displayName: '用户管理',
  description: '测试夹具模块：用户账户基础信息',
  basePath: '/mock/user',
  version: 1,
  status: 'active',
  entities: [{
    name: 'user',
    tableName: 'mock__user',
    displayName: '用户',
    fields: [
      { name: 'username', type: 'string', displayName: '用户名', required: true },
      { name: 'email', type: 'string', displayName: '邮箱', required: true },
      { name: 'password', type: 'string', displayName: '密码', required: true },
      { name: 'role', type: 'string', displayName: '角色', required: false, defaultValue: 'user' },
      { name: 'status', type: 'integer', displayName: '状态', required: false, defaultValue: 1 },
    ],
  }],
  endpoints: [
    { method: 'GET', path: '/', name: '列表', type: 'list' },
    { method: 'GET', path: '/:id', name: '详情', type: 'detail' },
    { method: 'POST', path: '/', name: '创建', type: 'create' },
    { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
    { method: 'DELETE', path: '/:id', name: '删除', type: 'delete' },
  ],
  config: { delay: { min: 0, max: 0 }, errorRate: 0 },
};

const USER_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS \`mock__user\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`username\` TEXT NOT NULL,
  \`email\` TEXT NOT NULL,
  \`password\` TEXT NOT NULL,
  \`role\` TEXT DEFAULT 'user',
  \`status\` INTEGER DEFAULT 1,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`;

const USER_CONTROLLER_TS = `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';

const model = new BaseModel('mock__user');

export function list(query: Record<string, string>) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const result = model.findAll({ page, pageSize });
  return paginated(result.list, result.total, result.page, result.pageSize);
}

export function getById(id: string) {
  const item = model.findById(Number(id));
  if (!item) return { success: false, message: '记录不存在' };
  return success(item);
}

export function create(body: Record<string, unknown>) {
  const item = model.create(body);
  return success(item, '创建成功');
}

export function update(id: string, body: Record<string, unknown>) {
  const item = model.update(Number(id), body);
  return success(item, '更新成功');
}

export function remove(id: string) {
  const deleted = model.delete(Number(id));
  return success(null, deleted ? '删除成功' : '记录不存在');
}
`;

const USER_TEST_TS = `import { test, assert, request } from '@core/test-runner.js';

test('create user', async (ctx) => {
  const res = await request.post('/mock/user', { username: 't', email: 't@t.com', password: 'x' });
  assert.eq(res.status, 200);
  return res.body.data.id;
});

test('list', async () => {
  const res = await request.get('/mock/user');
  assert.eq(res.status, 200);
});
`;

const USER_CONTEXT_MD = `# user 模块
字段: username, email, password, role, status
接口: /mock/user GET/POST, /mock/user/:id GET/PUT/DELETE
`;

const USER_API_DOC_MD = `# 用户管理 API

## GET /mock/user
列表查询，支持 page / pageSize / orderBy / filter[xxx].

### 响应
| 字段 | 类型 | 说明 |
|------|------|------|
| success | boolean | 是否成功 |
| data.list | array | 用户列表 |
| data.total | integer | 总数 |

## POST /mock/user
创建用户。

### 请求 Body
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 用户名 |
| email | string | 是 | 邮箱 |
| password | string | 是 | 密码 |
`;

/**
 * 幂等确保 user mock 模块的 fixture 存在：
 * - 文件落盘 generated/1/user/*
 * - mock__1_user 物理表存在
 * - modules 表有对应记录
 *
 * 设计为可重复调用，不破坏已有数据。
 */
export async function ensureUserModule(_token?: string): Promise<void> {
  // 1. Files
  const dir = join(GENERATED_DIR, String(USER_ID), 'user');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    '_meta.json': JSON.stringify(USER_META, null, 2),
    'schema.sql': USER_SCHEMA_SQL,
    'controller.ts': USER_CONTROLLER_TS,
    'test.ts': USER_TEST_TS,
    '_context.md': USER_CONTEXT_MD,
    'api-doc.md': USER_API_DOC_MD,
  };
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, content, 'utf-8');
  }

  // 2. Physical table + modules row (direct DB, WAL mode allows concurrent writers)
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database file not found at ${DB_PATH} — backend must run once first.`);
  }
  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create physical table (userId-injected name)
    const injectedSql = USER_SCHEMA_SQL
      .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${USER_ID}_$1\``)
      .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${USER_ID}_$1`);
    db.exec(injectedSql);

    // Ensure modules row
    const existing = db.prepare(
      `SELECT id FROM modules WHERE name = ? AND user_id = ?`
    ).get('user', USER_ID) as { id: number } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run('user', USER_ID, USER_META.displayName, USER_META.description, USER_META.basePath);
    } else {
      // Make sure status is healthy
      db.prepare(`UPDATE modules SET status = 'active', error_message = NULL WHERE id = ?`).run(existing.id);
    }
  } finally {
    db.close();
  }
}
