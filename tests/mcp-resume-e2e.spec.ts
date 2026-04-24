/**
 * Task 5.6 — end-to-end acceptance for Step-MCP-5.
 *
 * Replicates the user-reported scenario: AI Agent calls update_module, client
 * transport times out, AI re-sends same request, server auto-attaches and
 * delivers the final result.
 *
 * E01 — client timeout → re-send → attach → done
 * E02 — different instruction re-attach carries warning + actualInstruction
 * E03 — per-user 3 concurrent modules; 4th returns MOCKFORGE_BUSY
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MCP_URL = new URL('http://localhost:3000/mcp');

async function generateApiKey(): Promise<string> {
  const token = await getToken();
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function connect(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'mcp-resume-e2e-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function ensureModule(name: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(name);
    db.prepare(
      `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, 1, ?, '', ?, 'active')`,
    ).run(name, name, `/mock/${name}`);
  } finally { db.close(); }
}

function forceAllTerminal() {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE run_status = 'running'`).run();
  } finally { db.close(); }
}

function countRunning(name: string): number {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE module_name = ? AND run_status = 'running'`,
    ).get(name) as { n: number };
    return row.n;
  } finally { db.close(); }
}

function countAllRunningForUser(userId: number): number {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE user_id = ? AND run_status = 'running'`,
    ).get(userId) as { n: number };
    return row.n;
  } finally { db.close(); }
}

/** Poll until there are no running sessions for the given user, up to timeoutMs. */
async function waitForIdle(userId: number, timeoutMs = 30_000): Promise<void> {
  let waited = 0;
  while (waited < timeoutMs) {
    if (countAllRunningForUser(userId) === 0) return;
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task 5.6 — resume e2e acceptance', () => {
  // actively cancel running sessions so the gate slot is released (DB UPDATE alone
  // doesn't trigger the runner's terminal event that the watcher waits on).
  test.afterEach(async () => {
    const db = new Database(DB_PATH);
    let running: Array<{ id: string }> = [];
    try {
      running = db.prepare(`SELECT id FROM sessions WHERE user_id = 1 AND run_status = 'running'`).all() as Array<{ id: string }>;
    } finally { db.close(); }
    if (running.length === 0) return;

    const key = await generateApiKey();
    const c = await connect(key);
    try {
      for (const s of running) {
        try {
          await c.callTool({ name: 'cancel_session', arguments: { sessionId: s.id } }, undefined, { timeout: 20000 });
        } catch { /* ignore */ }
      }
    } finally { await c.close(); }
    // Fallback: if anything remains, force the DB into a consistent state
    forceAllTerminal();
  });

  test('E01 client timeout → resend → attach → done', async () => {
    test.setTimeout(180_000);
    const MOD = 'e2e_resume_mod_e01';
    ensureModule(MOD);

    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const instruction = '__fake_slow__ e01 instruction';

      // 1. First call: waitMaxSec=1 → returns still-running
      const r1 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MOD, instruction, waitMaxSec: 1 },
      }, undefined, { timeout: 30000 });

      const sc1 = (r1 as any).structuredContent as any;
      expect(sc1.status).toBe('still-running');
      expect(sc1.sessionId).toBeTruthy();
      const sessionId = sc1.sessionId;

      // 2. Second call with SAME args → should attach to sessionId + wait to done
      const r2 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MOD, instruction, waitMaxSec: 90 },
      }, undefined, { timeout: 120000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(['updated', 'still-running']).toContain(sc2.status);
      expect(sc2.sessionId).toBe(sessionId);
      expect(sc2.attached).toBe(true);

      // Final: if still-running, poll once more to confirm it completes
      if (sc2.status === 'still-running') {
        const r3 = await c.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction, waitMaxSec: 120 },
        }, undefined, { timeout: 150000 });
        expect((r3 as any).structuredContent.status).toBe('updated');
      }
    } finally { await c.close(); }
  });

  test('E02 different instruction attach carries warning + actualInstruction', async () => {
    test.setTimeout(180_000);
    const MOD = 'e2e_resume_mod_e02';
    ensureModule(MOD);

    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const first = '__fake_slow__ add a location field';
      const second = 'add a status field instead';

      const r1 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MOD, instruction: first, waitMaxSec: 1 },
      }, undefined, { timeout: 30000 });
      expect((r1 as any).structuredContent.status).toBe('still-running');

      // Wait until the session's first user message is persisted (runner fired start)
      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MOD) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }

      const r2 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MOD, instruction: second, waitMaxSec: 1 },
      }, undefined, { timeout: 30000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.attached).toBe(true);
      expect(sc2.actualInstruction).toContain('location');
      expect(sc2.yourInstruction).toContain('status');
      expect(sc2.warning).toBeTruthy();
    } finally { await c.close(); }
  });

  test('E03 4 个并发模块,第 4 个返 BUSY + runningSessions', async () => {
    test.setTimeout(240_000);
    const MODS = ['e03_mod_a', 'e03_mod_b', 'e03_mod_c', 'e03_mod_d'];
    for (const m of MODS) ensureModule(m);

    // The concurrency gate lives in the backend process and is not reachable from
    // tests. Prior tests may still hold slots while their __fake_slow__ sessions
    // finalize naturally (~14s). Wait until we have a clean slate.
    await waitForIdle(1, 60_000);

    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const payload = (m: string) => ({
        name: 'update_module' as const,
        arguments: { moduleName: m, instruction: `__fake_slow__ concurrency test ${m}`, waitMaxSec: 1 },
      });

      // Fire first 3 sequentially (to ensure their running slots are acquired)
      const r1 = await c.callTool(payload(MODS[0]), undefined, { timeout: 30000 });
      expect((r1 as any).structuredContent.status).toBe('still-running');
      const r2 = await c.callTool(payload(MODS[1]), undefined, { timeout: 30000 });
      expect((r2 as any).structuredContent.status).toBe('still-running');
      const r3 = await c.callTool(payload(MODS[2]), undefined, { timeout: 30000 });
      expect((r3 as any).structuredContent.status).toBe('still-running');

      // Fourth call should return BUSY
      const r4 = await c.callTool(payload(MODS[3]), undefined, { timeout: 30000 });
      expect((r4 as any).isError).toBe(true);
      const sc4 = (r4 as any).structuredContent as any;
      expect(sc4.code).toBe('MOCKFORGE_BUSY');
      expect(sc4.scope).toBe('user');
      expect(sc4.userConcurrent).toBeGreaterThanOrEqual(3);
      expect(sc4.userLimit).toBe(3);
      expect(Array.isArray(sc4.runningSessions)).toBe(true);
      expect(sc4.runningSessions.length).toBeGreaterThanOrEqual(3);
      expect(sc4.hint).toBeTruthy();

      // Now wait for the fake_slow sessions to finish so subsequent tests don't collide.
      // Just poll the DB.
      let waited = 0;
      while (waited < 60_000) {
        const still = MODS.slice(0, 3).reduce((acc, m) => acc + countRunning(m), 0);
        if (still === 0) break;
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
    } finally { await c.close(); }
  });
});
