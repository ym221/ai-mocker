/**
 * Task 5.2 — 写工具 waitMaxSec + onConflict + attach-on-resume 语义。
 *
 * 场景:
 * - AR01: 默认 attach (instruction 一致,无 warning)
 * - AR02: attach (instruction 不一致,带 warning + actualInstruction)
 * - AR03: onConflict='reject' 返 ALREADY_PROCESSING
 * - AR04: onConflict='replace' cancel 旧的启新的
 * - AR05: waitMaxSec short 返 still-running
 * - AR06: attached:true 字段对外暴露
 * - AR07: normalize 比较 (空白、大小写不影响 attach 路径)
 * - AR08: 没 in-flight 时正常启新 session
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
  const c = new Client({ name: 'mcp-attach-resume-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function countRunning(moduleName: string): number {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE module_name = ? AND run_status = 'running'`,
    ).get(moduleName) as { n: number };
    return row.n;
  } finally { db.close(); }
}

function forceTerminalAll(moduleName: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(moduleName);
  } finally { db.close(); }
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task 5.2 — write tools attach-on-resend', () => {
  const MODULE = 'attach_resume_test_mod';

  // Actively cancel any running sessions between tests so the backend's
  // concurrency gate releases slots before the next test runs.
  test.afterEach(async () => {
    const db = new Database(DB_PATH);
    let running: Array<{ id: string }> = [];
    try {
      running = db.prepare(
        `SELECT id FROM sessions WHERE user_id = 1 AND run_status = 'running'`,
      ).all() as Array<{ id: string }>;
    } finally { db.close(); }
    if (running.length > 0) {
      const key = await generateApiKey();
      const c = await connect(key);
      try {
        for (const s of running) {
          try {
            await c.callTool({ name: 'cancel_session', arguments: { sessionId: s.id } }, undefined, { timeout: 20000 });
          } catch { /* ignore */ }
        }
      } finally { await c.close(); }
    }
    forceTerminalAll(MODULE);
  });

  test('AR01 默认 attach (instruction 一致) + 无 warning', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      // Ensure module exists (quick: use create with fake spec to build a stub module row in DB)
      // Simpler: insert directly via SQL since we only need the row + meta
      const db = new Database(DB_PATH);
      try {
        db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(MODULE);
        db.prepare(
          `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
           VALUES (?, 1, ?, '', ?, 'active')`,
        ).run(MODULE, MODULE, `/mock/${MODULE}`);
      } finally { db.close(); }

      const instr = '__fake_slow__ please add a field called extra';
      // Kick off first update — don't await (still running with waitMaxSec=1)
      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      // Wait until the session appears as running
      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      // Second call with SAME instruction → attach, still-running (short wait)
      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.status).toBe('still-running');
      expect(sc2.attached).toBe(true);
      // No drift warning for identical instruction
      expect(sc2.warning).toBeUndefined();

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR02 attach (instruction 不一致) + warning + actualInstruction', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      const instr1 = '__fake_slow__ add a field called extra';
      const instr2 = 'add a different field called bogus';  // same module, different instruction

      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr1, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr2, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.attached).toBe(true);
      // actualInstruction should match the extract of the in-flight session's first user content
      expect(sc2.actualInstruction).toContain('add a field called extra');
      expect(sc2.yourInstruction).toContain('add a different field called bogus');
      expect(sc2.warning).toBeTruthy();

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR03 onConflict=reject 返 ALREADY_PROCESSING', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      const instr = '__fake_slow__ some change';
      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, onConflict: 'reject' },
      }, undefined, { timeout: 10000 });

      expect((r2 as any).isError).toBe(true);
      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.code).toBe('MOCKFORGE_ALREADY_PROCESSING');
      expect(sc2.existingSessionId).toBeTruthy();
      expect(sc2.hint).toBeTruthy();

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR04 onConflict=replace cancel 旧的启新的', async () => {
    test.setTimeout(180_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      const instr1 = '__fake_slow__ old instruction';
      const instr2 = '__fake__ brand new instruction';

      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr1, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      const sidFromFirst = await getFirstRunningSessionId(MODULE);

      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr2, onConflict: 'replace', waitMaxSec: 60 },
      }, undefined, { timeout: 120000 });

      const sc2 = (r2 as any).structuredContent as any;
      // Should be a fresh session, NOT attached to sidFromFirst
      expect(sc2.attached).toBe(false);
      expect(sc2.sessionId).toBeTruthy();
      expect(sc2.sessionId).not.toBe(sidFromFirst);
      expect(['updated', 'still-running']).toContain(sc2.status);

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR05 waitMaxSec short 返 still-running', async () => {
    test.setTimeout(60_000);
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const db = new Database(DB_PATH);
      try {
        db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(MODULE);
        db.prepare(
          `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
           VALUES (?, 1, ?, '', ?, 'active')`,
        ).run(MODULE, MODULE, `/mock/${MODULE}`);
      } finally { db.close(); }

      const r = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake_slow__ short wait test', waitMaxSec: 1 },
      }, undefined, { timeout: 30000 });

      const sc = (r as any).structuredContent as any;
      expect(sc.status).toBe('still-running');
      expect(sc.sessionId).toBeTruthy();
      expect(sc.stage).toBeTruthy();
      expect(typeof sc.elapsedSec).toBe('number');
      expect(sc.hint).toBeTruthy();
    } finally {
      await c.close();
    }
  });

  test('AR06 attached:true 字段对外暴露', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      const instr = '__fake_slow__ attached flag test';
      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.attached).toBe(true);

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR07 normalize 比较 (空白、大小写不触发 warning)', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c1 = await connect(key);
    const c2 = await connect(key);
    try {
      const instr1 = '__fake_slow__ Add A Field';
      const instr2 = '  __fake_slow__  add a   field  ';

      const p1 = c1.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr1, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning(MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunning(MODULE)).toBe(1);

      const r2 = await c2.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: instr2, waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.attached).toBe(true);
      // After normalize, should not trigger drift warning
      expect(sc2.warning).toBeUndefined();

      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  test('AR08 没 in-flight 时正常启新 session', async () => {
    test.setTimeout(120_000);
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const db = new Database(DB_PATH);
      try {
        db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(MODULE);
        db.prepare(
          `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
           VALUES (?, 1, ?, '', ?, 'active')`,
        ).run(MODULE, MODULE, `/mock/${MODULE}`);
      } finally { db.close(); }

      const r = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake__ fast test', waitMaxSec: 30 },
      }, undefined, { timeout: 60000 });

      const sc = (r as any).structuredContent as any;
      expect(['updated', 'still-running']).toContain(sc.status);
      expect(sc.attached).toBe(false);
      expect(sc.sessionId).toBeTruthy();
    } finally {
      await c.close();
    }
  });
});

function getFirstRunningSessionId(moduleName: string): string | null {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT id FROM sessions WHERE module_name = ? AND run_status = 'running' ORDER BY created_at DESC LIMIT 1`,
    ).get(moduleName) as { id: string } | undefined;
    return row?.id ?? null;
  } finally { db.close(); }
}
