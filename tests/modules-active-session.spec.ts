/**
 * Bug-fix coverage for the "module shows ready but conversation still timing"
 * complaint. The modules list/detail API now exposes `hasActiveSession` so the
 * UI can show a "active · 生成中" indicator while a chat session is mid-run
 * against the module. Self-heal of stale DB status is also deferred while a
 * session is running, so the chat-card status doesn't flip to active before
 * the conversation actually finishes.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getToken, waitForBackend } from './helpers';

const API = 'http://localhost:3000';
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated', '1');

test.beforeAll(async () => { await waitForBackend(); });

async function authedGet(path: string) {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

/** Create a fully-healthy module on disk + DB row + table. */
function createHealthyModule(name: string) {
  const dir = join(GENERATED_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_meta.json'), JSON.stringify({
    name, displayName: name, basePath: `/mock/${name}`, version: 1,
    entities: [{
      name: 'item',
      tableName: `mock__${name}`, // health check requires this
      fields: [{ name: 'id', type: 'integer' }, { name: 'qty', type: 'integer' }],
    }],
    endpoints: [{ method: 'GET', path: '/items', name: 'list', type: 'list' }],
  }));
  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS mock__${name} (id INTEGER PRIMARY KEY, qty INTEGER);`);
  writeFileSync(join(dir, 'seed.sql'), '');
  writeFileSync(join(dir, 'controller.ts'), 'export default {};');
  writeFileSync(join(dir, 'test.ts'), 'export default async function () { return { ok: true }; }');
  writeFileSync(join(dir, 'api-doc.md'), `# ${name}\n`);
  const db = new Database(DB_PATH);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS \`mock__1_${name}\` (id INTEGER PRIMARY KEY, qty INTEGER)`);
    db.prepare(
      `INSERT OR REPLACE INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, 1, ?, '', ?, 'active')`
    ).run(name, name, `/mock/${name}`);
  } finally { db.close(); }
}

function teardownModule(name: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(name);
    db.exec(`DROP TABLE IF EXISTS \`mock__1_${name}\``);
    db.prepare(`DELETE FROM sessions WHERE module_name = ?`).run(name);
  } finally { db.close(); }
  const dir = join(GENERATED_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function makeRunningSession(moduleName: string): string {
  const sid = randomUUID();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, module_name, run_status, last_seq) VALUES (?, ?, 1, ?, 'running', 0)`
    ).run(sid, '[MOD-FIX] running', moduleName);
  } finally { db.close(); }
  return sid;
}

test.describe('modules API hasActiveSession (Bug 2)', () => {
  test('MOD-FIX01 GET /api/modules sets hasActiveSession when a session is running', async () => {
    const name = `mfix01_${Date.now()}`;
    createHealthyModule(name);
    const sid = makeRunningSession(name);
    try {
      const { status, body } = await authedGet('/api/modules');
      expect(status).toBe(200);
      const m = body.data.find((x: any) => x.name === name);
      expect(m).toBeTruthy();
      expect(m.hasActiveSession).toBe(true);
    } finally {
      const db = new Database(DB_PATH);
      try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { db.close(); }
      teardownModule(name);
    }
  });

  test('MOD-FIX02 GET /api/modules/:name sets hasActiveSession', async () => {
    const name = `mfix02_${Date.now()}`;
    createHealthyModule(name);
    const sid = makeRunningSession(name);
    try {
      const { status, body } = await authedGet(`/api/modules/${name}`);
      expect(status).toBe(200);
      expect(body.data.hasActiveSession).toBe(true);
    } finally {
      const db = new Database(DB_PATH);
      try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { db.close(); }
      teardownModule(name);
    }
  });

  test('MOD-FIX03 hasActiveSession=false when no running session', async () => {
    const name = `mfix03_${Date.now()}`;
    createHealthyModule(name);
    try {
      const { body } = await authedGet(`/api/modules/${name}`);
      expect(body.data.hasActiveSession).toBe(false);
    } finally {
      teardownModule(name);
    }
  });

  test('MOD-FIX04 self-heal does NOT persist DB status flip while session is running', async () => {
    // Create a healthy module BUT with stale DB status='creating' + a running session.
    // Endpoint should return effective status='active' (UI stays usable) but the
    // DB row should remain 'creating' so the chat-card / completion banner can
    // stay accurate until finalize() runs.
    const name = `mfix04_${Date.now()}`;
    createHealthyModule(name);
    const db = new Database(DB_PATH);
    try {
      db.prepare(`UPDATE modules SET status = 'creating' WHERE name = ? AND user_id = 1`).run(name);
    } finally { db.close(); }
    const sid = makeRunningSession(name);
    try {
      const { body } = await authedGet(`/api/modules/${name}`);
      expect(body.data.status).toBe('active');         // effective status
      expect(body.data.hasActiveSession).toBe(true);   // session still running
      // DB row should NOT have been auto-flipped while session is running
      const after = new Database(DB_PATH);
      try {
        const row = after.prepare(`SELECT status FROM modules WHERE name = ? AND user_id = 1`).get(name) as { status: string };
        expect(row.status).toBe('creating');
      } finally { after.close(); }
    } finally {
      const cleanup = new Database(DB_PATH);
      try { cleanup.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { cleanup.close(); }
      teardownModule(name);
    }
  });

  test('MOD-FIX05 self-heal DOES persist DB flip when no session is running', async () => {
    const name = `mfix05_${Date.now()}`;
    createHealthyModule(name);
    const db = new Database(DB_PATH);
    try {
      db.prepare(`UPDATE modules SET status = 'creating' WHERE name = ? AND user_id = 1`).run(name);
    } finally { db.close(); }
    try {
      const { body } = await authedGet(`/api/modules/${name}`);
      expect(body.data.status).toBe('active');
      expect(body.data.hasActiveSession).toBe(false);
      // DB row should be persisted now (no session blocking)
      const after = new Database(DB_PATH);
      try {
        const row = after.prepare(`SELECT status FROM modules WHERE name = ? AND user_id = 1`).get(name) as { status: string };
        expect(row.status).toBe('active');
      } finally { after.close(); }
    } finally {
      teardownModule(name);
    }
  });
});
