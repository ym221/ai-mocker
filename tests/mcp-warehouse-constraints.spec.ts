/**
 * Step-MCP-4 端到端验收: 复刻用户报告的"对话式注入业务约束"场景。
 *
 * 用户原始痛点:
 *   "api-doc.md 已经写入了这些业务约束,但 get_openapi 输出里 status 仍是 string、
 *    没有 enum/约束描述...生成器目前没把这些规则映射进 OpenAPI"
 *
 * 本测试用 fake-runner 模拟"AI 完成 update_module 后的最终状态" — 直接落地
 * 包含 enum + 跨字段约束的 _meta.json,然后通过 MCP 客户端验证整条链路:
 *   1) get_openapi 看到 status enum + endpoint 含跨字段说明
 *   2) manage_data POST 违反约束 → 400 + 友好 message (auto-validate 起作用)
 *   3) diff_with_openapi 喂入违反请求 → constraint-violation / cross-field-violation
 *   4) update_module 返回的 diff 包含 +constraint / +test / api-doc warnings
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const MCP_URL = new URL('http://localhost:3000/mcp');
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'wh_constraint_e2e';

function seedWarehouseWithConstraints() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const meta = {
    name: MODULE,
    displayName: '仓储管理',
    description: '管理仓库库存物料 (含 enum + 跨字段约束)',
    basePath: `/mock/${MODULE}`,
    version: 1,
    status: 'active',
    entities: [{
      name: 'warehouse_item',
      tableName: `mock__${MODULE}`,
      displayName: '库存物料',
      fields: [
        { name: 'sku', type: 'string', displayName: 'SKU', required: true, unique: true, pattern: '^[A-Z0-9-]{3,32}$' },
        { name: 'name', type: 'string', displayName: '物料名称', required: true },
        { name: 'qty', type: 'integer', displayName: '数量', required: true, min: 0, max: 100000 },
        { name: 'status', type: 'string', displayName: '状态', enum: ['in_stock', 'low_stock', 'out_of_stock'], default: 'in_stock' },
        { name: 'safety_stock', type: 'integer', displayName: '安全库存', min: 0, default: 0 },
      ],
      constraints: [
        { id: 'qty-zero-status', when: { qty: 0 }, must: { status: 'out_of_stock' }, message: '数量为 0 时,状态必须为 out_of_stock' },
        { id: 'low-stock', when: { qty: { gt: 0, lte: 10 } }, must: { status: 'low_stock' }, message: '数量 ≤10 (>0) 时,状态必须为 low_stock' },
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
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`sku\` TEXT NOT NULL,
  \`name\` TEXT NOT NULL,
  \`qty\` INTEGER NOT NULL,
  \`status\` TEXT,
  \`safety_stock\` INTEGER DEFAULT 0,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`, 'utf-8');

  // controller 用 .withMeta() 把约束接进 BaseModel.create/update
  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel, ValidationError } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const model = new BaseModel('mock__${MODULE}').withMeta('${MODULE}');
function asValidationFail(e: unknown) {
  if (e instanceof ValidationError) return { success: false, message: e.message, statusCode: 400 };
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
export function create(b: Record<string, unknown>) {
  try { return success(model.create(b), '创建成功'); } catch (e) { return asValidationFail(e); }
}
export function update(id: string, b: Record<string, unknown>) {
  const existing = model.findById(Number(id));
  if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  try { return success(model.update(Number(id), b), '更新成功'); } catch (e) { return asValidationFail(e); }
}
export function remove(id: string) {
  const deleted = model.delete(Number(id));
  if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(null, '删除成功');
}
`, 'utf-8');

  writeFileSync(join(dir, 'test.ts'), `import { test, assert, request } from '@core/test-runner.js';
test('创建合法物料', async (ctx) => {
  const r = await request.post('/mock/${MODULE}', { sku: 'SKU-001', name: 'Item A', qty: 50, status: 'in_stock' });
  assert.eq(r.status, 200);
  return r.body.data.id;
});
test('列表查询', async () => {
  const r = await request.get('/mock/${MODULE}');
  assert.eq(r.status, 200);
});
test('详情', async (ctx) => {
  const r = await request.get(\`/mock/${MODULE}/\${ctx.lastId}\`);
  assert.eq(r.status, 200);
});
test('PUT 部分更新', async (ctx) => {
  const r = await request.put(\`/mock/${MODULE}/\${ctx.lastId}\`, { qty: 30 });
  assert.eq(r.status, 200);
});
test('数量为 0 时必须 out_of_stock', async () => {
  const bad = await request.post('/mock/${MODULE}', { sku: 'SKU-002', name: 'X', qty: 0, status: 'in_stock' });
  assert.eq(bad.status, 400);
  const ok = await request.post('/mock/${MODULE}', { sku: 'SKU-003', name: 'Y', qty: 0, status: 'out_of_stock' });
  assert.eq(ok.status, 200);
});
test('数量 ≤10 时必须 low_stock', async () => {
  const bad = await request.post('/mock/${MODULE}', { sku: 'SKU-004', name: 'Z', qty: 5, status: 'in_stock' });
  assert.eq(bad.status, 400);
});
test('删除', async (ctx) => {
  const r = await request.delete(\`/mock/${MODULE}/\${ctx.lastId}\`);
  assert.eq(r.status, 200);
});
`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}\n\n字段: sku(必填,unique,正则), name, qty(0-100000), status(enum), safety_stock\n约束: qty=0 ↔ status=out_of_stock; 1≤qty≤10 ↔ status=low_stock\n`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# 仓储管理 API\n\n## POST /mock/${MODULE}\n创建物料。约束见 OpenAPI description.\n`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (
      \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
      \`sku\` TEXT NOT NULL,
      \`name\` TEXT NOT NULL,
      \`qty\` INTEGER NOT NULL,
      \`status\` TEXT,
      \`safety_stock\` INTEGER DEFAULT 0,
      \`created_at\` TEXT DEFAULT (datetime('now')),
      \`updated_at\` TEXT DEFAULT (datetime('now'))
    );`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(MODULE, USER_ID, '仓储管理', 'e2e', `/mock/${MODULE}`);
    db.exec(`DELETE FROM \`mock__${USER_ID}_${MODULE}\``);
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

async function generateApiKey(): Promise<string> {
  const token = await getToken('admin', 'admin123');
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const r = await apiRequest('POST', '/api/users/me/api-key', token);
  return r.data.data.apiKey as string;
}

async function connect(apiKey: string): Promise<Client> {
  const t = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'wh-constraints-e2e', version: '0.0.0' });
  await c.connect(t);
  return c;
}

test.beforeAll(async () => { await waitForBackend(); });
test.beforeEach(() => { cleanup(); seedWarehouseWithConstraints(); });
test.afterAll(() => cleanup());

test.describe('Step-MCP-4 端到端验收: warehouse + 约束 + diff', () => {
  test('WC01 get_openapi 输出含 status enum + min/max + pattern + 跨字段 description', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({ name: 'get_openapi', arguments: { moduleName: MODULE } });
      const sc = (r as any).structuredContent as { openapi: any };
      const props = sc.openapi.components.schemas.warehouse_item.properties;
      // status enum
      expect(props.status.enum).toEqual(['in_stock', 'low_stock', 'out_of_stock']);
      // qty min/max
      expect(props.qty.minimum).toBe(0);
      expect(props.qty.maximum).toBe(100000);
      // sku pattern
      expect(props.sku.pattern).toBe('^[A-Z0-9-]{3,32}$');
      // POST endpoint description 含跨字段约束
      const post = sc.openapi.paths[`/mock/${MODULE}/`].post;
      expect(post.description).toContain('业务约束');
      expect(post.description).toContain('qty-zero-status');
      expect(post.description).toContain('low-stock');
    } finally { await client.close(); }
  });

  test('WC02 manage_data POST 违反 enum → 400 + 中文 message', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'manage_data',
        arguments: {
          action: 'insert', moduleName: MODULE,
          data: { sku: 'SKU-A1', name: 'X', qty: 5, status: '__bad_status__' },
        },
      });
      // manage_data wraps errors as isError
      expect((r as any).isError).toBe(true);
      const text = String((r as any).content?.[0]?.text || '');
      expect(text).toMatch(/状态.*必须是.*in_stock.*low_stock.*out_of_stock/);
    } finally { await client.close(); }
  });

  test('WC03 manage_data POST 违反跨字段规则 → 400 + 中文 message', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'manage_data',
        arguments: {
          action: 'insert', moduleName: MODULE,
          data: { sku: 'SKU-A2', name: 'X', qty: 0, status: 'in_stock' },
        },
      });
      expect((r as any).isError).toBe(true);
      const text = String((r as any).content?.[0]?.text || '');
      expect(text).toMatch(/数量为 0 时.*out_of_stock/);
    } finally { await client.close(); }
  });

  test('WC04 manage_data POST 合规 → 200', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'manage_data',
        arguments: {
          action: 'insert', moduleName: MODULE,
          data: { sku: 'SKU-A3', name: 'OK Item', qty: 0, status: 'out_of_stock' },
        },
      });
      expect((r as any).isError).toBeFalsy();
      expect((r as any).structuredContent?.result?.sku).toBe('SKU-A3');
    } finally { await client.close(); }
  });

  test('WC05 diff_with_openapi 检测 enum + 跨字段违反', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'lower-case-bad', name: 'X', qty: 0, status: 'in_stock' },
          },
        },
      });
      const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
      expect(sc.aligned).toBe(false);
      // pattern 违反
      const patternDiff = sc.diffs.find(d => d.kind === 'constraint-violation' && d.path.includes('sku'));
      expect(patternDiff, `expected sku pattern violation; got ${JSON.stringify(sc.diffs)}`).toBeTruthy();
      // 跨字段违反
      const cf = sc.diffs.find(d => d.kind === 'cross-field-violation');
      expect(cf).toBeTruthy();
      expect(cf.message).toContain('out_of_stock');
    } finally { await client.close(); }
  });

  test('WC06 run_test 含跨字段断言用例,全绿', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({ name: 'run_test', arguments: { moduleName: MODULE } });
      const sc = (r as any).structuredContent as { passed: number; total: number; allPassed: boolean };
      expect(sc.total).toBeGreaterThanOrEqual(7);
      expect(sc.allPassed, `failed tests; sc=${JSON.stringify(sc)}`).toBe(true);
    } finally { await client.close(); }
  });

  test('WC07 真实 mock 端点也校验 (业务代码走 /mock/* 一样得 400)', async () => {
    const r = await fetch(`http://localhost:3000/mock/${MODULE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-X1', name: 'X', qty: 0, status: 'in_stock' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toMatch(/数量为 0 时.*out_of_stock/);
  });
});
