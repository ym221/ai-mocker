/**
 * Step-Fix-1.6: BaseModel outward-facing aliases.
 *
 * mock-router exposes controllers named list/getById/create/update/remove; AI
 * naturally mirrors this naming on BaseModel itself. Historical BaseModel only
 * had inward DB-style names (findAll/findById/delete), creating a foot-gun
 * where AI-generated multi-entity controllers 500 at runtime.
 *
 * These aliases make both naming conventions work and also coerce string IDs
 * (URL params arrive as strings from Fastify).
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend } from './helpers';

const API = 'http://localhost:3000';
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'bmalias';

const META = {
  name: MODULE,
  displayName: 'BM alias test',
  description: 'Step-Fix-1.6',
  basePath: `/mock/${MODULE}`,
  version: 1,
  status: 'active',
  entities: [{ name: 'Thing', tableName: `mock__${MODULE}_thing`, fields: [{ name: 'title', type: 'string' }] }],
  endpoints: [
    { method: 'GET',    path: '/',     name: 'list',   type: 'list' },
    { method: 'GET',    path: '/:id',  name: 'detail', type: 'detail' },
    { method: 'POST',   path: '/',     name: 'create', type: 'create' },
    { method: 'PUT',    path: '/:id',  name: 'update', type: 'update' },
    { method: 'DELETE', path: '/:id',  name: 'delete', type: 'delete' },
  ],
  config: { delay: { min: 0, max: 0 }, errorRate: 0 },
};

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}_thing\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`;

// Controller uses the NEW outward-facing alias names (list/getById/remove) on BaseModel.
// 签名统一 `async (req) => ...`,其中 req = { body, query, params }。
const CONTROLLER_TS = `import { BaseModel } from '@core/base-model.js';

const model = new BaseModel('${MODULE}_thing');

export const list = async (req: any) => {
  const q = req.query || {};
  const r = model.list({ page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20 });
  return { code: 0, data: r };
};

export const getById = async (req: any) => {
  const item = model.getById(req.params.id);
  if (!item) return { code: 1, message: 'not found', statusCode: 404 };
  return { code: 0, data: item };
};

export const create = async (req: any) => ({ code: 0, data: model.create(req.body) });
export const update = async (req: any) => ({ code: 0, data: model.update(req.params.id, req.body) });
export const remove = async (req: any) => ({ code: 0, data: { deleted: model.remove(req.params.id) } });
`;

function ensureModule() {
  if (!existsSync(DB_PATH)) throw new Error('Backend must run at least once first');

  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, '_meta.json'), JSON.stringify(META, null, 2), 'utf-8');
  writeFileSync(join(dir, 'schema.sql'), SCHEMA_SQL, 'utf-8');
  writeFileSync(join(dir, 'controller.ts'), CONTROLLER_TS, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('noop', async () => { assert.ok(true); });\n`, 'utf-8');
  writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE}\n`, 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    const injectedSql = SCHEMA_SQL.replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${USER_ID}_$1\``);
    db.exec(injectedSql);
    const existing = db.prepare('SELECT id FROM modules WHERE name = ? AND user_id = ?').get(MODULE, USER_ID) as { id: number } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(MODULE, USER_ID, META.displayName, META.description, META.basePath);
    } else {
      db.prepare(`UPDATE modules SET status='active', error_message=NULL WHERE id=?`).run(existing.id);
    }
    db.exec(`DELETE FROM \`mock__${USER_ID}_${MODULE}_thing\``);
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  await waitForBackend();
  ensureModule();
  await new Promise((r) => setTimeout(r, 200));
});

test.describe('BaseModel outward aliases (Step-Fix-1.6)', () => {
  test('BA01 model.list() returns { list, total, page, pageSize }', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/?page=1&pageSize=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.list)).toBe(true);
    expect(typeof body.data.total).toBe('number');
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(10);
  });

  test('BA02 create → list → getById → update → remove (string id) all succeed', async () => {
    const createRes = await fetch(`${API}/mock/${MODULE}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).data;
    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('hello');

    const listRes = await fetch(`${API}/mock/${MODULE}/`);
    const list = (await listRes.json()).data;
    expect(list.total).toBeGreaterThanOrEqual(1);

    const getRes = await fetch(`${API}/mock/${MODULE}/${created.id}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).data.id).toBe(created.id);

    const updRes = await fetch(`${API}/mock/${MODULE}/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'hello2' }),
    });
    expect(updRes.status).toBe(200);
    expect((await updRes.json()).data.title).toBe('hello2');

    const delRes = await fetch(`${API}/mock/${MODULE}/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()).data.deleted).toBe(true);
  });

  test('BA03 getById accepts string id and returns 404 for non-existent (via statusCode)', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/999999`);
    // Controller returns { code:1, message:'not found', statusCode:404 }; mock-router
    // extracts statusCode and returns 404
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe(1);
  });
});
