/**
 * BaseModel.withMeta() 自动校验集成测试。
 *
 * 通过 /api/data/{module} REST 端点真实跑一遍 controller → BaseModel,
 * 验证 controller 模板能把 ValidationError 转成 400 友好响应。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'bm_validate_test';

function setupModuleWithConstraints() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const meta = {
    name: MODULE,
    displayName: 'BM Validate Test',
    basePath: `/mock/${MODULE}`,
    version: 1,
    status: 'active',
    entities: [{
      name: 'item',
      tableName: `mock__${MODULE}`,
      fields: [
        { name: 'sku', type: 'string', required: true, displayName: 'SKU', unique: true },
        { name: 'qty', type: 'integer', required: true, min: 0, max: 1000, displayName: '数量' },
        { name: 'status', type: 'string', enum: ['in_stock', 'out_of_stock'], default: 'in_stock', displayName: '状态' },
      ],
      constraints: [{
        id: 'qty-zero',
        when: { qty: 0 },
        must: { status: 'out_of_stock' },
        message: '数量为 0 时,状态必须为 out_of_stock',
      }],
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
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`sku\` TEXT NOT NULL,
  \`qty\` INTEGER NOT NULL,
  \`status\` TEXT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`, 'utf-8');

  // Controller uses .withMeta() so BaseModel auto-validates
  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel, ValidationError } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const model = new BaseModel('mock__${MODULE}').withMeta('${MODULE}');

function asValidationFail(e: unknown) {
  if (e instanceof ValidationError) {
    return { success: false, message: e.message, statusCode: 400 };
  }
  throw e;
}

export function list(query: Record<string, string>) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const r = model.findAll({ page, pageSize });
  return paginated(r.list, r.total, r.page, r.pageSize);
}
export function getById(id: string) {
  const item = model.findById(Number(id));
  if (!item) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(item);
}
export function create(body: Record<string, unknown>) {
  try { return success(model.create(body), '创建成功'); }
  catch (e) { return asValidationFail(e); }
}
export function update(id: string, body: Record<string, unknown>) {
  const existing = model.findById(Number(id));
  if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  try { return success(model.update(Number(id), body), '更新成功'); }
  catch (e) { return asValidationFail(e); }
}
export function remove(id: string) {
  const deleted = model.delete(Number(id));
  if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(null, '删除成功');
}
`, 'utf-8');

  writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('n', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE} API`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (
      \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
      \`sku\` TEXT NOT NULL,
      \`qty\` INTEGER NOT NULL,
      \`status\` TEXT,
      \`created_at\` TEXT DEFAULT (datetime('now')),
      \`updated_at\` TEXT DEFAULT (datetime('now'))
    );`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(MODULE, USER_ID, 'BM Validate', 'test', `/mock/${MODULE}`);
    // Clear table data
    db.prepare(`DELETE FROM \`mock__${USER_ID}_${MODULE}\``).run();
  } finally { db.close(); }
}

function cleanup() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const db = new Database(DB_PATH);
  try {
    db.exec(`DROP TABLE IF EXISTS \`mock__${USER_ID}_${MODULE}\``);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });
test.beforeEach(() => { cleanup(); setupModuleWithConstraints(); });
test.afterAll(() => cleanup());

const API = 'http://localhost:3000';

async function postMock(body: unknown) {
  const res = await fetch(`${API}/mock/${MODULE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function putMock(id: number, body: unknown) {
  const res = await fetch(`${API}/mock/${MODULE}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test.describe('BaseModel.withMeta() 自动校验 + controller 转 400', () => {
  test('B01 缺 required 字段 → 400 + 中文 message', async () => {
    const r = await postMock({ qty: 5 });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(r.body.message).toMatch(/SKU是必填项/);
  });

  test('B02 enum 越界 → 400', async () => {
    const r = await postMock({ sku: 'A1', qty: 5, status: 'unknown' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/状态.*必须是.*in_stock.*out_of_stock/);
  });

  test('B03 数值 min 越界 → 400', async () => {
    const r = await postMock({ sku: 'A2', qty: -1 });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/数量不能小于 0/);
  });

  test('B04 跨字段 qty=0 ↔ status=out_of_stock 违反 → 400', async () => {
    const r = await postMock({ sku: 'A3', qty: 0, status: 'in_stock' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/数量为 0 时.*out_of_stock/);
  });

  test('B05 跨字段满足 + 字段全合法 → 200 创建成功', async () => {
    const r = await postMock({ sku: 'A4', qty: 0, status: 'out_of_stock' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.sku).toBe('A4');
  });

  test('B06 unique 字段重复 → 400', async () => {
    const r1 = await postMock({ sku: 'DUP', qty: 5, status: 'in_stock' });
    expect(r1.status).toBe(200);
    const r2 = await postMock({ sku: 'DUP', qty: 5, status: 'in_stock' });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/SKU已存在/);
  });

  test('B07 update PATCH 部分更新触发跨字段约束 (合并现有行)', async () => {
    const created = await postMock({ sku: 'B7', qty: 5, status: 'in_stock' });
    expect(created.status).toBe(200);
    const id = created.body.data.id as number;
    // 仅 PATCH qty=0 (没传 status), 与现有 status=in_stock 合并 → 触发跨字段
    const r = await putMock(id, { qty: 0 });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/数量为 0 时.*out_of_stock/);
    // 同时改 status 则通过
    const r2 = await putMock(id, { qty: 0, status: 'out_of_stock' });
    expect(r2.status).toBe(200);
  });

  test('B08 老模块 (无 .withMeta()) 不受影响 — back-compat', async () => {
    // 写一个没 withMeta 的 controller 覆盖,验证 BaseModel 不会强制校验
    const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
    writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const model = new BaseModel('mock__${MODULE}');  // 无 .withMeta() — 走旧路径
export function list(q: Record<string, string>) {
  const r = model.findAll({ page: 1, pageSize: 20 });
  return paginated(r.list, r.total, r.page, r.pageSize);
}
export function getById(id: string) {
  const item = model.findById(Number(id));
  if (!item) return { success: false, message: '记录不存在' };
  return success(item);
}
export function create(b: Record<string, unknown>) { return success(model.create(b)); }
export function update(id: string, b: Record<string, unknown>) { return success(model.update(Number(id), b)); }
export function remove(id: string) { return success(null, model.delete(Number(id)) ? 'ok' : 'not found'); }
`, 'utf-8');
    // 老 controller 应能"违法"创建 (sku=null, qty 越界都不报)
    const r = await postMock({ sku: 'XX', qty: -100, status: 'unknown' });
    expect(r.status).toBe(200);  // 旧路径不校验
  });
});
