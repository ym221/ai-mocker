/**
 * 回归测试: manage-data resolveTableName 必须尊重 entity.tableName 字段。
 *
 * 起因: AI 生成的 _meta.json 可能出现 entity.name 和 entity.tableName 不一致的情况
 *   (例如 name="warehouse_item", tableName="mock__warehouse")，schema.sql 的 CREATE
 *   TABLE 与 tableName 配对。resolveTableName 必须以 tableName 为准才能找到物理表。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'rtn_test';

function setupFixture(opts: { entityName: string; tableName: string; physicalTable: string }) {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const meta = {
    name: MODULE,
    displayName: 'resolveTableName 测试',
    description: 'test',
    basePath: `/mock/${MODULE}`,
    version: 1,
    status: 'active',
    entities: [{
      name: opts.entityName,
      tableName: opts.tableName,
      displayName: 'E',
      fields: [
        { name: 'title', type: 'string', displayName: 'Title', required: true },
        { name: 'note', type: 'string', displayName: 'Note', required: false },
      ],
    }],
    endpoints: [
      { method: 'GET', path: '/', name: '列表', type: 'list' },
      { method: 'POST', path: '/', name: '创建', type: 'create' },
    ],
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  };
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS \`${opts.tableName}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT NOT NULL,
  \`note\` TEXT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`, 'utf-8');
  writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const model = new BaseModel('${opts.tableName}');
export function list(query: Record<string, string>) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const r = model.findAll({ page, pageSize });
  return paginated(r.list, r.total, r.page, r.pageSize);
}
export function create(body: Record<string, unknown>) { return success(model.create(body)); }
`, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('noop', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE}`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS \`${opts.physicalTable}\` (
      \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
      \`title\` TEXT NOT NULL,
      \`note\` TEXT,
      \`created_at\` TEXT DEFAULT (datetime('now')),
      \`updated_at\` TEXT DEFAULT (datetime('now'))
    );`);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.prepare(
      `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(MODULE, USER_ID, 'RTN', 'test', `/mock/${MODULE}`);
  } finally { db.close(); }
}

function cleanupFixture(physicalTable: string) {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const db = new Database(DB_PATH);
  try {
    db.exec(`DROP TABLE IF EXISTS \`${physicalTable}\``);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('manage-data resolveTableName honors entity.tableName', () => {
  test.afterEach(() => cleanupFixture('mock__1_rtn_actual'));

  test('RTN01 entity.name 与 tableName 不一致时，用 tableName 找到物理表', async () => {
    // name="rtn_entity_logical" 但 tableName="mock__rtn_actual"
    // 物理表是 mock__1_rtn_actual（write-file.ts 的 userId 注入逻辑）
    setupFixture({
      entityName: 'rtn_entity_logical',
      tableName: 'mock__rtn_actual',
      physicalTable: 'mock__1_rtn_actual',
    });

    const token = await getToken();
    // list 应该 200（空列表也 OK，关键是能找到表不报 "表不存在"）
    const res = await apiRequest('GET', `/api/data/${MODULE}?page=1&pageSize=5`, token);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data.list)).toBe(true);

    // bulk-generate 也应能找到表
    const gen = await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, token, { count: 2 });
    expect(gen.status).toBe(200);
    expect(gen.data.data.generated).toBe(2);
  });

  test('RTN02 缺 tableName 字段时回退到 mock__{name} 约定', async () => {
    const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // 这次 meta 里故意不带 tableName，只有 name
    const meta = {
      name: MODULE, displayName: 'no-tableName', description: '', basePath: `/mock/${MODULE}`,
      version: 1, status: 'active',
      entities: [{
        name: 'rtn_actual',  // name 将被转成 mock__rtn_actual (兜底)
        displayName: 'E',
        fields: [{ name: 'title', type: 'string', displayName: 'Title', required: true }],
      }],
      endpoints: [{ method: 'GET', path: '/', name: '列表', type: 'list' }],
      config: { delay: { min: 0, max: 0 }, errorRate: 0 },
    };
    writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
    writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS \`mock__rtn_actual\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT NOT NULL,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`, 'utf-8');
    writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';
const m = new BaseModel('mock__rtn_actual');
export function list(q: Record<string, string>) { const r = m.findAll({ page: 1, pageSize: 20 }); return paginated(r.list, r.total, r.page, r.pageSize); }
export function create(b: Record<string, unknown>) { return success(m.create(b)); }
`, 'utf-8');
    writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('n', async () => { assert.ok(true); });\n`, 'utf-8');
    writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
    writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE}`, 'utf-8');

    const db = new Database(DB_PATH);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS \`mock__1_rtn_actual\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`title\` TEXT NOT NULL,
        \`created_at\` TEXT DEFAULT (datetime('now')),
        \`updated_at\` TEXT DEFAULT (datetime('now'))
      );`);
      db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
      db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(MODULE, USER_ID, 'RTN', 'test', `/mock/${MODULE}`);
    } finally { db.close(); }

    const token = await getToken();
    const res = await apiRequest('GET', `/api/data/${MODULE}?page=1&pageSize=5`, token);
    expect(res.status).toBe(200);
  });
});
