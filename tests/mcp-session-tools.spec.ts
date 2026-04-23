/**
 * Task 5.3 — get_session_status + cancel_session MCP tools.
 *
 * ST01 get_session_status 对 running session 返回 status='running' + stage
 * ST02 get_session_status 对不存在 session 返 SESSION_NOT_FOUND
 * ST03 get_session_status 对 done session 拿到 status='done' + recentEvents
 * ST04 cancel_session 对 live runner 把它 abort 掉
 * ST05 cancel_session 对已经 terminal 的 session 是 no-op
 * ST06 cancel_session 对不存在 session 返 SESSION_NOT_FOUND
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MCP_URL = new URL('http://localhost:3000/mcp');
const MODULE = 'session_tools_test_mod';

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
  const c = new Client({ name: 'mcp-session-tools-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function ensureModuleRow() {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(MODULE);
    db.prepare(
      `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, 1, ?, '', ?, 'active')`,
    ).run(MODULE, MODULE, `/mock/${MODULE}`);
  } finally { db.close(); }
}

function forceTerminalAll() {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(MODULE);
  } finally { db.close(); }
}

function countRunning(): number {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE module_name = ? AND run_status = 'running'`).get(MODULE) as { n: number };
    return row.n;
  } finally { db.close(); }
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task 5.3 — session tools', () => {
  test.afterEach(() => forceTerminalAll());

  test('ST01 get_session_status 对 running session 返回 status=running', async () => {
    test.setTimeout(60_000);
    ensureModuleRow();
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      // Kick off slow update
      const p1 = c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake_slow__ slow', waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      // Wait for running
      let waited = 0;
      while (waited < 5000) {
        if (countRunning() > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      const sessionId = getLatestRunningSessionId();
      expect(sessionId).toBeTruthy();

      const r = await c.callTool({
        name: 'get_session_status',
        arguments: { sessionId },
      }, undefined, { timeout: 10000 });

      const sc = (r as any).structuredContent as any;
      expect(sc.sessionId).toBe(sessionId);
      expect(sc.status).toBe('running');
      expect(sc.stage).toBeTruthy();
      expect(sc.lastEventSeq).toBeGreaterThan(0);
      expect(Array.isArray(sc.recentEvents)).toBe(true);
      expect(sc.moduleName).toBe(MODULE);

      await p1;
    } finally {
      await c.close();
    }
  });

  test('ST02 get_session_status 对不存在 session 返 SESSION_NOT_FOUND', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'get_session_status',
        arguments: { sessionId: 'nonexistent-fake-sid-12345' },
      }, undefined, { timeout: 5000 });

      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_SESSION_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally {
      await c.close();
    }
  });

  test('ST03 get_session_status 对 done session 拿到 status=done', async () => {
    test.setTimeout(60_000);
    ensureModuleRow();
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r1 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake__ quick', waitMaxSec: 30 },
      }, undefined, { timeout: 60000 });

      const sc1 = (r1 as any).structuredContent as any;
      expect(sc1.status).toBe('updated');
      const sessionId = sc1.sessionId;

      const r2 = await c.callTool({
        name: 'get_session_status',
        arguments: { sessionId },
      }, undefined, { timeout: 5000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.sessionId).toBe(sessionId);
      expect(sc2.status).toBe('done');
      expect(sc2.recentEvents.length).toBeGreaterThan(0);
      expect(sc2.recentEvents.some((e: any) => e.type === 'done')).toBe(true);
    } finally {
      await c.close();
    }
  });

  test('ST04 cancel_session 对 live runner abort 它', async () => {
    test.setTimeout(60_000);
    ensureModuleRow();
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const p1 = c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake_slow__ will be cancelled', waitMaxSec: 1 },
      }, undefined, { timeout: 60000 });

      let waited = 0;
      while (waited < 5000) {
        if (countRunning() > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      const sessionId = getLatestRunningSessionId();

      const r = await c.callTool({
        name: 'cancel_session',
        arguments: { sessionId },
      }, undefined, { timeout: 30000 });

      const sc = (r as any).structuredContent as any;
      expect(sc.sessionId).toBe(sessionId);
      expect(sc.wasLive).toBe(true);
      expect(['aborted', 'paused']).toContain(sc.status);
      expect(typeof sc.elapsedBeforeCancel).toBe('number');

      await p1.catch(() => null);
    } finally {
      await c.close();
    }
  });

  test('ST05 cancel_session 对已经 terminal 的 session 是 no-op', async () => {
    test.setTimeout(60_000);
    ensureModuleRow();
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      // Run to completion first
      const r1 = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: MODULE, instruction: '__fake__ quick for cancel noop', waitMaxSec: 30 },
      }, undefined, { timeout: 60000 });
      const sessionId = (r1 as any).structuredContent.sessionId;

      const r2 = await c.callTool({
        name: 'cancel_session',
        arguments: { sessionId },
      }, undefined, { timeout: 5000 });

      const sc2 = (r2 as any).structuredContent as any;
      expect(sc2.sessionId).toBe(sessionId);
      expect(sc2.wasLive).toBe(false);
    } finally {
      await c.close();
    }
  });

  test('ST06 cancel_session 对不存在 session 返 SESSION_NOT_FOUND', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'cancel_session',
        arguments: { sessionId: 'nonexistent-sid-abc-xyz' },
      }, undefined, { timeout: 5000 });

      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_SESSION_NOT_FOUND');
    } finally {
      await c.close();
    }
  });
});

function getLatestRunningSessionId(): string | null {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT id FROM sessions WHERE module_name = ? AND run_status = 'running' ORDER BY created_at DESC LIMIT 1`,
    ).get(MODULE) as { id: string } | undefined;
    return row?.id ?? null;
  } finally { db.close(); }
}
