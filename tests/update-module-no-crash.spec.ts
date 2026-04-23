/**
 * Regression: update_module 不再因为 retryWarnings is not iterable 崩溃。
 *
 * Bug 1 from MCP user testing — update_module 稳定报
 *   "retryWarnings is not iterable"
 * 因为 bumpRetryCounter 在 < threshold 时返回 undefined,而 Task 4.5 的代码
 * 直接 spread 它。
 *
 * 修复: `bumpRetryCounter(...) ?? []`
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
const MODULE = 'umnc_test';

function setupModule() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_meta.json'), JSON.stringify({
    name: MODULE, displayName: 'X', basePath: `/mock/${MODULE}`, version: 1, status: 'active',
    entities: [{ name: 'item', tableName: `mock__${MODULE}`, fields: [{ name: 'name', type: 'string', required: true }] }],
    endpoints: [{ method: 'GET', path: '/', name: '列表', type: 'list' }],
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  }, null, 2), 'utf-8');
  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE \`mock__${MODULE}\` (\`id\` INTEGER PRIMARY KEY);`, 'utf-8');
  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';\nimport { paginated } from '@core/response.js';\nconst m = new BaseModel('mock__${MODULE}');\nexport function list(q) { const r = m.findAll({ page: 1, pageSize: 20 }); return paginated(r.list, r.total, r.page, r.pageSize); }\n`, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('n', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE}`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (\`id\` INTEGER PRIMARY KEY, \`name\` TEXT);`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status) VALUES (?, ?, ?, ?, ?, 'active')`)
      .run(MODULE, USER_ID, 'UMNC', 'test', `/mock/${MODULE}`);
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
  const c = new Client({ name: 'umnc-spec', version: '0.0.0' });
  await c.connect(t);
  return c;
}

test.beforeAll(async () => { await waitForBackend(); });
test.beforeEach(() => { cleanup(); setupModule(); });
test.afterAll(() => cleanup());

test.describe('update_module 不再崩 (Bug 1 修复回归)', () => {
  test('UMNC01 update_module 完整跑通 (fake-slow spec) 不抛 retryWarnings is not iterable', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    try {
      const r = await client.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake_slow__ noop change' },
      }, undefined, { timeout: 60000 });

      // 关键断言: 不该报 "retryWarnings is not iterable"
      const text = String((r as any).content?.[0]?.text || '');
      expect(text).not.toContain('not iterable');
      expect(text).not.toContain('retryWarnings');

      // structuredContent 应该有 status='updated' (或至少不是 ended-with-error)
      const sc = (r as any).structuredContent as any;
      expect(sc).toBeTruthy();
      // fake 流不会真改文件,所以 hasChange 可能 false (但这没问题,关键是没崩)
      expect(typeof sc.hasChange).toBe('boolean');
    } finally { await client.close(); }
  });
});
