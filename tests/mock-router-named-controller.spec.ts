/**
 * Step-Fix-1.1: mock-router supports `endpoint.controller` named-handler dispatch.
 *
 * Fixes the multi-entity blind spot: historical type-based switch only knows
 * `ctrl.list/getById/create/update/remove`, so a module with 3 entities cannot be
 * dispatched (all 3 entities' list endpoints would race for `ctrl.list`).
 *
 * New contract: if `_meta.endpoints[].controller = "listItems"`, mock-router calls
 * `ctrl.listItems({ body, query, params })` — a req-like single arg that matches
 * what LLMs naturally generate.
 *
 * Back-compat: endpoints without `controller` still use legacy type switch.
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
const MODULE = 'multient';

const META = {
  name: MODULE,
  displayName: '多实体路由测试',
  description: 'F1.1 named-controller dispatch',
  basePath: `/mock/${MODULE}`,
  version: 1,
  status: 'active',
  entities: [
    { name: 'Foo', tableName: `mock__${MODULE}_Foo`, fields: [] },
    { name: 'Bar', tableName: `mock__${MODULE}_Bar`, fields: [] },
  ],
  endpoints: [
    // Entity Foo — named controller per endpoint
    { method: 'GET',    path: '/foos',      name: 'listFoos',     type: 'list',   controller: 'listFoos' },
    { method: 'GET',    path: '/foos/:id',  name: 'getFoo',       type: 'detail', controller: 'getFooById' },
    { method: 'POST',   path: '/foos',      name: 'createFoo',    type: 'create', controller: 'createFoo' },
    { method: 'PUT',    path: '/foos/:id',  name: 'updateFoo',    type: 'update', controller: 'updateFoo' },
    { method: 'DELETE', path: '/foos/:id',  name: 'removeFoo',    type: 'delete', controller: 'removeFoo' },
    // Entity Bar — also named, to prove no ctrl.list ambiguity
    { method: 'GET',    path: '/bars',      name: 'listBars',     type: 'list',   controller: 'listBars' },
    { method: 'POST',   path: '/bars',      name: 'createBar',    type: 'create', controller: 'createBar' },
    // Error case: endpoint points to non-existent export
    { method: 'GET',    path: '/missing',   name: 'missing',      type: 'list',   controller: 'iDoNotExist' },
    // Legacy: no controller field, falls back to type-based ctrl.list
    { method: 'GET',    path: '/legacy',    name: 'legacyList',   type: 'list' },
  ],
  config: { delay: { min: 0, max: 0 }, errorRate: 0 },
};

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}_Foo\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS \`mock__${MODULE}_Bar\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);`;

// Controller exports named per-entity handlers. Each receives req-like { body, query, params }.
const CONTROLLER_TS = `export const listFoos = (req: any) => ({ code: 0, data: { which: 'Foo', kind: 'list', q: req.query } });
export const getFooById = (req: any) => ({ code: 0, data: { which: 'Foo', kind: 'detail', id: req.params.id } });
export const createFoo = (req: any) => ({ code: 0, data: { which: 'Foo', kind: 'create', body: req.body } });
export const updateFoo = (req: any) => ({ code: 0, data: { which: 'Foo', kind: 'update', id: req.params.id, body: req.body } });
export const removeFoo = (req: any) => ({ code: 0, data: { which: 'Foo', kind: 'delete', id: req.params.id } });
export const listBars = (req: any) => ({ code: 0, data: { which: 'Bar', kind: 'list' } });
export const createBar = (req: any) => ({ code: 0, data: { which: 'Bar', kind: 'create', body: req.body } });
// Legacy type-based: also exports generic list so the /legacy endpoint works
export const list = (_q: any) => ({ code: 0, data: { which: 'legacy-type-dispatch', kind: 'list' } });
`;

function ensureFixtureModule() {
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
  ensureFixtureModule();
  await new Promise((r) => setTimeout(r, 200));
});

test.describe('mock-router named-controller dispatch (Step-Fix-1.1)', () => {
  test('NC01 list named → ctrl.listFoos with req.query', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/foos?page=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.which).toBe('Foo');
    expect(body.data.kind).toBe('list');
    expect(body.data.q).toMatchObject({ page: '2' });
  });

  test('NC02 detail named → req.params.id populated', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/foos/42`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ which: 'Foo', kind: 'detail', id: '42' });
  });

  test('NC03 create named → req.body received', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/foos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alpha' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ which: 'Foo', kind: 'create', body: { name: 'alpha' } });
  });

  test('NC04 update named → id + body', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/foos/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'beta' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ which: 'Foo', kind: 'update', id: '7', body: { name: 'beta' } });
  });

  test('NC05 delete named → id passed', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/foos/99`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ which: 'Foo', kind: 'delete', id: '99' });
  });

  test('NC06 second entity disambiguated — listBars routes to ctrl.listBars, not ctrl.listFoos', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/bars`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.which).toBe('Bar');
    expect(body.data.kind).toBe('list');
  });

  test('NC07 second entity create — separate handler', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/bars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ which: 'Bar', kind: 'create', body: { x: 1 } });
  });

  test('NC08 missing named export → 500 with actionable message', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/missing`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain('iDoNotExist');
    expect(body.message).toContain('Available');
  });

  test('NC09 legacy endpoint without controller field still uses type-based ctrl.list', async () => {
    const res = await fetch(`${API}/mock/${MODULE}/legacy`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.which).toBe('legacy-type-dispatch');
  });
});
