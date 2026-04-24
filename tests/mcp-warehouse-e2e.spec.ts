/**
 * 端到端 MCP 验证 (warehouse 模块全链路)
 *
 * 覆盖用户报告的失败场景:
 *   1) AI 生成不一致的 _meta.json (entity.name vs tableName) → manage_data 仍能找到表
 *   2) update_module 后 OpenAPI 的 PUT 应引用 Patch schema (无 required)
 *   3) 部分更新请求不再被 diff_with_openapi 误报为 missing-in-actual
 *
 * 使用 MCP 客户端直连 /mcp,完整复刻用户 workflow。
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
const MODULE = 'e2e_warehouse';

async function generateApiKey(): Promise<string> {
  const token = await getToken('admin', 'admin123');
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function connect(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'e2e-warehouse', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

/** 模拟 "AI 生成了不一致 _meta.json + 正常物理表" 的场景 */
function seedInconsistentFixture() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const meta = {
    name: MODULE,
    displayName: '仓储管理 E2E',
    description: '管理仓库库存物料',
    basePath: `/mock/${MODULE}`,
    version: 1,
    status: 'active',
    entities: [{
      // 故意制造不一致: entity.name 与 tableName 的 suffix 不一致
      name: 'warehouse_item',
      tableName: `mock__${MODULE}`,  // 不是 mock__warehouse_item
      displayName: '库存物料',
      fields: [
        { name: 'material_name', type: 'string', displayName: '物料名称', required: true },
        { name: 'material_code', type: 'string', displayName: '物料编码', required: true },
        { name: 'quantity', type: 'integer', displayName: '数量', required: true },
        { name: 'unit', type: 'string', displayName: '单位', required: true },
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
  \`material_name\` TEXT NOT NULL,
  \`material_code\` TEXT NOT NULL,
  \`quantity\` INTEGER NOT NULL,
  \`unit\` TEXT NOT NULL,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`, 'utf-8');

  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const model = new BaseModel('mock__${MODULE}');
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
export function create(body: Record<string, unknown>) { return success(model.create(body), '创建成功'); }
export function update(id: string, body: Record<string, unknown>) {
  const existing = model.findById(Number(id));
  if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(model.update(Number(id), body), '更新成功');
}
export function remove(id: string) {
  const deleted = model.delete(Number(id));
  if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(null, '删除成功');
}
`, 'utf-8');

  writeFileSync(join(dir, 'test.ts'), `import { test, assert, request } from '@core/test-runner.js';
test('create', async (ctx) => {
  const r = await request.post('/mock/${MODULE}', {
    material_name: 'Item', material_code: 'SKU-1', quantity: 10, unit: 'pcs',
  });
  assert.eq(r.status, 200);
  return r.body.data.id;
});
test('list', async () => {
  const r = await request.get('/mock/${MODULE}');
  assert.eq(r.status, 200);
});
test('get', async (ctx) => {
  const r = await request.get(\`/mock/${MODULE}/\${ctx.lastId}\`);
  assert.eq(r.status, 200);
});
test('update (partial)', async (ctx) => {
  const r = await request.put(\`/mock/${MODULE}/\${ctx.lastId}\`, { quantity: 20 });
  assert.eq(r.status, 200);
});
test('delete', async (ctx) => {
  const r = await request.delete(\`/mock/${MODULE}/\${ctx.lastId}\`);
  assert.eq(r.status, 200);
});
`, 'utf-8');

  writeFileSync(join(dir, '_context.md'), `# ${MODULE}\n字段: material_name, material_code, quantity, unit\n`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE} API\n测试模块\n`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (
      \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
      \`material_name\` TEXT NOT NULL,
      \`material_code\` TEXT NOT NULL,
      \`quantity\` INTEGER NOT NULL,
      \`unit\` TEXT NOT NULL,
      \`created_at\` TEXT DEFAULT (datetime('now')),
      \`updated_at\` TEXT DEFAULT (datetime('now'))
    );`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(MODULE, USER_ID, 'Warehouse E2E', 'test', `/mock/${MODULE}`);
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

test.describe('warehouse 端到端 MCP 闭环验证', () => {
  test.beforeEach(() => { cleanup(); seedInconsistentFixture(); });
  test.afterAll(() => cleanup());

  test('W01 MCP list_modules 看到新模块, health=healthy', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({ name: 'list_modules', arguments: {} });
      const sc = (r as any).structuredContent as { modules: Array<{ name: string; health: string }> };
      const item = sc.modules.find(m => m.name === MODULE);
      expect(item).toBeTruthy();
      expect(item!.health).toBe('healthy');
    } finally { await client.close(); }
  });

  test('W02 MCP inspect_module view=openapi 返回 PUT 引用 Patch schema (无 required)', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({ name: 'inspect_module', arguments: { moduleName: MODULE, view: 'openapi' } });
      const spec = (r as any).structuredContent?.openapi?.spec as any;
      // Patch schema 必须在 components
      expect(spec.components.schemas).toHaveProperty(`warehouse_itemPatch`);
      const patch = spec.components.schemas['warehouse_itemPatch'];
      expect(patch.required ?? []).toEqual([]);
      // PUT 引用 Patch
      const putOp = spec.paths[`/mock/${MODULE}/{id}`]?.put;
      expect(putOp.requestBody.content['application/json'].schema.$ref)
        .toBe('#/components/schemas/warehouse_itemPatch');
      // POST 仍引用完整 schema
      const postOp = spec.paths[`/mock/${MODULE}/`]?.post;
      expect(postOp.requestBody.content['application/json'].schema.$ref)
        .toBe('#/components/schemas/warehouse_item');
    } finally { await client.close(); }
  });

  test('W03 MCP manage_data 可正常 CRUD (resolveTableName 用 tableName)', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      // clear 先
      await client.callTool({ name: 'manage_data', arguments: { action: 'clear', moduleName: MODULE } });

      // bulk_generate
      const gen = await client.callTool({
        name: 'manage_data',
        arguments: { action: 'bulk_generate', moduleName: MODULE, count: 3 },
      });
      expect((gen as any).isError).toBeFalsy();
      expect((gen as any).structuredContent?.result?.generated).toBe(3);

      // list
      const listed = await client.callTool({
        name: 'manage_data',
        arguments: { action: 'list', moduleName: MODULE, pageSize: 5 },
      });
      const sc = (listed as any).structuredContent as { result: { total: number; list: any[] } };
      expect(sc.result.total).toBe(3);
      expect(sc.result.list.length).toBe(3);
      const firstId = sc.result.list[0].id as number;

      // insert
      const ins = await client.callTool({
        name: 'manage_data',
        arguments: {
          action: 'insert', moduleName: MODULE,
          data: { material_name: 'E2E Item', material_code: 'E2E-001', quantity: 99, unit: 'pc' },
        },
      });
      expect((ins as any).isError).toBeFalsy();
      const newId = (ins as any).structuredContent?.result?.id as number;

      // update (partial)
      const upd = await client.callTool({
        name: 'manage_data',
        arguments: { action: 'update', moduleName: MODULE, id: newId, data: { quantity: 88 } },
      });
      expect((upd as any).isError).toBeFalsy();

      // delete
      const del = await client.callTool({
        name: 'manage_data',
        arguments: { action: 'delete', moduleName: MODULE, id: firstId },
      });
      expect((del as any).isError).toBeFalsy();
    } finally { await client.close(); }
  });

  test('W04 MCP run_test 真跑 CRUD 回归, 5/5 通过', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({ name: 'run_test', arguments: { moduleName: MODULE } });
      const sc = (r as any).structuredContent as { passed: number; total: number; allPassed: boolean };
      expect(sc.total).toBe(5);
      expect(sc.passed).toBe(5);
      expect(sc.allPassed).toBe(true);
    } finally { await client.close(); }
  });

  test('W05 MCP diff_with_openapi 对"部分 PUT"请求不再误报 missing-in-actual', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'PUT',
            path: `/mock/${MODULE}/1`,
            body: { quantity: 20 },  // 只传一个字段 — 以前会报 missing material_name/material_code 等
          },
        },
      });
      const sc = (r as any).structuredContent as { aligned: boolean; diffs: Array<{ kind: string; path: string }> };
      // 部分 PUT 不应产生 missing-in-actual diff (Patch schema 没 required)
      const missingDiffs = sc.diffs.filter(d => d.kind === 'missing-in-actual');
      expect(missingDiffs).toEqual([]);
      // path 本身应该 aligned (或最多只有 status-mismatch 之类的辅助 diff)
      expect(sc.diffs.filter(d => d.path.includes('request.body')).length).toBe(0);
    } finally { await client.close(); }
  });

  test('W06 MCP get_mock_access_log + diff_with_openapi 契约对账整条通路', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      // 造一个真实的 mock 请求
      const mockBase = `http://localhost:3000/mock/${MODULE}`;
      const createRes = await fetch(mockBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material_name: 'Diff Test', material_code: 'DF-1', quantity: 5, unit: 'pc' }),
      });
      const createdBody = await createRes.json();
      const createdId = createdBody.data.id;
      // 发一个部分 PUT
      await fetch(`${mockBase}/${createdId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 15 }),
      });

      // 等日志落库
      await new Promise(r => setTimeout(r, 150));

      // 从访问日志拿最近一条 PUT
      const logs = await client.callTool({
        name: 'get_mock_access_log',
        arguments: { moduleName: MODULE, limit: 20 },
      });
      const logList = (logs as any).structuredContent?.logs as any[];
      const lastPut = logList.find(l => l.method === 'PUT');
      expect(lastPut).toBeTruthy();

      // 喂给 diff_with_openapi
      const diff = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: lastPut.method,
            path: lastPut.path,
            body: lastPut.requestBody ?? undefined,   // already parsed by the MCP tool
          },
          actualResponse: {
            statusCode: lastPut.statusCode,
            body: lastPut.responseBody ?? undefined,
          },
        },
      });
      const diffSc = (diff as any).structuredContent as { aligned: boolean; diffs: any[] };
      // 部分 PUT 应该契约对齐
      const missingFields = diffSc.diffs.filter(d => d.kind === 'missing-in-actual');
      expect(missingFields).toEqual([]);
    } finally { await client.close(); }
  });
});
