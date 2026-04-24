/**
 * Task M2.4 — UX polish unit + integration tests.
 *
 * UX01 humanizeStage unit: 'tool:write_files' → 正在批量写入模块文件
 * UX02 still-running 响应含 stageDescription + expectedRemainingSec + suggestedNextAction
 * UX03 get_session_status 对 running session 返回 humanized stage
 * UX04 mcpError text 以 [CODE] 前缀
 */
import { test, expect } from '@playwright/test';
import { humanizeStage } from '../src/server/mcp/lib/stage-humanize';
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
  const c = new Client({ name: 'ux-progress-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function forceAllTerminal(name: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(name);
  } finally { db.close(); }
}

function ensureModuleRow(name: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run(name);
    db.prepare(
      `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, 1, ?, '', ?, 'active')`,
    ).run(name, name, `/mock/${name}`);
  } finally { db.close(); }
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task M2.4 — UX polish', () => {
  test('UX01 humanizeStage 各种 stage 都有中文 description + 非负 expectedRemainingSec', () => {
    expect(humanizeStage('thinking').description).toContain('思考');
    expect(humanizeStage('writing').description).toContain('生成');
    expect(humanizeStage('tool:write_files').description).toContain('批量写入');
    expect(humanizeStage('tool:run_test').description).toContain('运行');
    expect(humanizeStage('tool:inspect_module').description).toContain('inspect_module');
    expect(humanizeStage('module_update').description).toContain('模块卡片');
    expect(humanizeStage('done').expectedRemainingSec).toBe(0);
    expect(humanizeStage('thinking').expectedRemainingSec).toBeGreaterThan(0);
    expect(humanizeStage(null).description).toContain('准备');
    // All stages yield a non-empty suggestedNextAction string
    for (const s of ['thinking', 'writing', 'tool:run_test', 'done', 'error']) {
      expect(humanizeStage(s).suggestedNextAction.length).toBeGreaterThan(10);
    }
  });

  test('UX02 still-running 响应含 stageDescription + expectedRemainingSec + suggestedNextAction', async () => {
    test.setTimeout(60_000);
    const MOD = 'ux_sr_test_mod';
    ensureModuleRow(MOD);
    try {
      const key = await generateApiKey();
      const c = await connect(key);
      try {
        const r = await c.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: '__fake_slow__ ux test', waitMaxSec: 1 },
        }, undefined, { timeout: 30000 });
        const sc = (r as any).structuredContent as any;
        expect(sc.status).toBe('still-running');
        expect(sc.stageDescription).toBeTruthy();
        expect(typeof sc.expectedRemainingSec).toBe('number');
        expect(sc.suggestedNextAction).toBeTruthy();
      } finally { await c.close(); }
    } finally { forceAllTerminal(MOD); }
  });

  test('UX03 get_session_status 对 running session 返回 humanized stage', async () => {
    test.setTimeout(60_000);
    const MOD = 'ux_status_test_mod';
    ensureModuleRow(MOD);
    try {
      const key = await generateApiKey();
      const c = await connect(key);
      try {
        const p = c.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: '__fake_slow__ status test', waitMaxSec: 1 },
        }, undefined, { timeout: 30000 });
        const r1 = await p;
        const sessionId = (r1 as any).structuredContent.sessionId;

        const r2 = await c.callTool({
          name: 'get_session_status',
          arguments: { sessionId },
        }, undefined, { timeout: 5000 });
        const sc = (r2 as any).structuredContent as any;
        expect(sc.stageDescription).toBeTruthy();
        // suggestedNextAction only present when running (may be done by this point — either null or string)
        expect(sc.suggestedNextAction === null || typeof sc.suggestedNextAction === 'string').toBe(true);
      } finally { await c.close(); }
    } finally { forceAllTerminal(MOD); }
  });

  test('UX04 mcpError text 以 [CODE] 前缀 + structuredContent 含 recovery_steps', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: '__absolutely_not_exist__' },
      }, undefined, { timeout: 5000 });
      expect((r as any).isError).toBe(true);
      expect((r as any).content[0].text).toContain('[MOCKFORGE_MODULE_NOT_FOUND]');
      const sc = (r as any).structuredContent as any;
      expect(Array.isArray(sc.recovery_steps)).toBe(true);
      expect(sc.recovery_steps.length).toBeGreaterThan(0);
    } finally { await c.close(); }
  });
});
