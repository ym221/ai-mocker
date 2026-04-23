/**
 * diff_with_openapi 检测字段约束 (enum/min/max/pattern) + 跨字段规则违反。
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'diff_constraint_test';

function setupModule() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta = {
    name: MODULE,
    displayName: 'Diff Constraint Test',
    basePath: `/mock/${MODULE}`,
    version: 1,
    status: 'active',
    entities: [{
      name: 'item',
      tableName: `mock__${MODULE}`,
      fields: [
        { name: 'sku', type: 'string', required: true, pattern: '^[A-Z0-9-]{3,32}$' },
        { name: 'qty', type: 'integer', required: true, min: 0, max: 1000 },
        { name: 'status', type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
      ],
      constraints: [
        { id: 'qty-zero', when: { qty: 0 }, must: { status: 'out_of_stock' }, message: '数量为 0 时必须 out_of_stock' },
      ],
    }],
    endpoints: [
      { method: 'GET', path: '/', name: '列表', type: 'list' },
      { method: 'POST', path: '/', name: '创建', type: 'create' },
      { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
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
  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const m = new BaseModel('mock__${MODULE}');
export function list(q: Record<string, string>) { const r = m.findAll({ page: 1, pageSize: 20 }); return paginated(r.list, r.total, r.page, r.pageSize); }
export function create(b: Record<string, unknown>) { return success(m.create(b)); }
export function update(id: string, b: Record<string, unknown>) { return success(m.update(Number(id), b)); }
`, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('n', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE}`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (
      \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
      \`sku\` TEXT NOT NULL, \`qty\` INTEGER NOT NULL, \`status\` TEXT,
      \`created_at\` TEXT DEFAULT (datetime('now')),
      \`updated_at\` TEXT DEFAULT (datetime('now'))
    );`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(MODULE, USER_ID, 'X', 'test', `/mock/${MODULE}`);
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
  const t = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'diff-constraints', version: '0.0.0' });
  await c.connect(t);
  return c;
}

test.beforeAll(async () => { await waitForBackend(); });
test.beforeEach(() => { cleanup(); setupModule(); });
test.afterAll(() => cleanup());

test.describe('diff_with_openapi 约束检测', () => {
  test('DC01 enum 越界 → constraint-violation diff', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'ABC-1', qty: 5, status: 'unknown_status' },
          },
        },
      });
      const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
      const v = sc.diffs.find(d => d.kind === 'constraint-violation' && d.path.includes('status'));
      expect(v, `expected enum violation; got ${JSON.stringify(sc.diffs)}`).toBeTruthy();
      expect(v.spec.enum).toContain('in_stock');
    } finally { await client.close(); }
  });

  test('DC02 数值越下界 → constraint-violation', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'ABC-1', qty: -5, status: 'in_stock' },
          },
        },
      });
      const sc = (r as any).structuredContent as { diffs: any[] };
      const v = sc.diffs.find(d => d.kind === 'constraint-violation' && d.path.includes('qty'));
      expect(v).toBeTruthy();
      expect(v.message).toContain('minimum');
    } finally { await client.close(); }
  });

  test('DC03 字符串 pattern 不匹配 → constraint-violation', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'lowercase', qty: 5, status: 'in_stock' },
          },
        },
      });
      const sc = (r as any).structuredContent as { diffs: any[] };
      const v = sc.diffs.find(d => d.kind === 'constraint-violation' && d.path.includes('sku'));
      expect(v).toBeTruthy();
      expect(v.message).toContain('pattern');
    } finally { await client.close(); }
  });

  test('DC04 跨字段规则违反 → cross-field-violation', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'ABC-1', qty: 0, status: 'in_stock' },  // qty=0 but status!=out_of_stock
          },
        },
      });
      const sc = (r as any).structuredContent as { diffs: any[] };
      const v = sc.diffs.find(d => d.kind === 'cross-field-violation');
      expect(v, `expected cross-field-violation; got ${JSON.stringify(sc.diffs)}`).toBeTruthy();
      expect(v.message).toContain('out_of_stock');
    } finally { await client.close(); }
  });

  test('DC05 全部合规 → aligned=true', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: {
            method: 'POST', path: `/mock/${MODULE}/`,
            body: { sku: 'ABC-1', qty: 0, status: 'out_of_stock' },
          },
        },
      });
      const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
      expect(sc.aligned).toBe(true);
      expect(sc.diffs).toEqual([]);
    } finally { await client.close(); }
  });

  test('DC06 GET 请求不触发跨字段检查 (只对 POST/PUT/PATCH)', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'diff_with_openapi',
        arguments: {
          moduleName: MODULE,
          actualRequest: { method: 'GET', path: `/mock/${MODULE}/` },
        },
      });
      const sc = (r as any).structuredContent as { diffs: any[] };
      const cf = sc.diffs.find(d => d.kind === 'cross-field-violation');
      expect(cf).toBeFalsy();
    } finally { await client.close(); }
  });
});
