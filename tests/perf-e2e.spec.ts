/**
 * Task M3.1 — Step-Perf-1 end-to-end smoke tests (fast, deterministic via __fake__).
 *
 * These tests don't call a real LLM — that's what the user's AI-agent manual
 * verification is for. They do exercise the FULL pipeline (MCP → write-tool-
 * runner → chat-runner → tool-executor with mutex → humanized progress) to
 * make sure all the new pieces compose.
 *
 * PE01 — batch write_files + prompt cache wiring: create_module_from_spec with
 *        __fake__ spec goes through create path, runner completes, humanized
 *        stage emitted.
 * PE02 — still-running UX: waitMaxSec=1 on __fake_slow__ returns enriched
 *        still-running with stageDescription + expectedRemainingSec.
 * PE03 — error recovery_steps are surfaced to the caller on a real tool error.
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
  const c = new Client({ name: 'perf-e2e-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
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

function forceAllTerminal(name: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(name);
  } finally { db.close(); }
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task M3.1 — Step-Perf-1 smoke E2E (fake LLM)', () => {
  test('PE01 update_module __fake__ 完整跑通并返 updated', async () => {
    test.setTimeout(60_000);
    const MOD = 'perf_e2e_mod_pe01';
    ensureModuleRow(MOD);
    try {
      const key = await generateApiKey();
      const c = await connect(key);
      try {
        const r = await c.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: '__fake__ quick sanity check', waitMaxSec: 30 },
        }, undefined, { timeout: 45000 });
        const sc = (r as any).structuredContent as any;
        expect(sc.status).toBe('updated');
        expect(sc.sessionId).toBeTruthy();
        expect(sc.attached).toBe(false);
      } finally { await c.close(); }
    } finally { forceAllTerminal(MOD); }
  });

  test('PE02 还在跑时响应含 humanized stage + expectedRemainingSec', async () => {
    test.setTimeout(60_000);
    const MOD = 'perf_e2e_mod_pe02';
    ensureModuleRow(MOD);
    try {
      const key = await generateApiKey();
      const c = await connect(key);
      try {
        const r = await c.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: '__fake_slow__ still-running e2e', waitMaxSec: 1 },
        }, undefined, { timeout: 20000 });
        const sc = (r as any).structuredContent as any;
        expect(sc.status).toBe('still-running');
        expect(sc.stageDescription).toBeTruthy();
        expect(typeof sc.expectedRemainingSec).toBe('number');
        expect(sc.suggestedNextAction).toBeTruthy();
        expect(sc.hint).toContain('auto-resume');
      } finally { await c.close(); }
    } finally { forceAllTerminal(MOD); }
  });

  test('PE03 inspect_module 对不存在模块 → recovery_steps 指向 list_modules + create_module_from_spec', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: '__never_exists__' },
      }, undefined, { timeout: 5000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
      const tools = sc.recovery_steps.map((s: any) => s.tool).filter(Boolean);
      expect(tools).toContain('list_modules');
      expect(tools).toContain('create_module_from_spec');
    } finally { await c.close(); }
  });

  test('PE04 attach-on-resend 同 instruction 攻保留 attached:true + 无 warning', async () => {
    test.setTimeout(120_000);
    const MOD = 'perf_e2e_mod_pe04';
    ensureModuleRow(MOD);
    try {
      const key = await generateApiKey();
      const c1 = await connect(key);
      const c2 = await connect(key);
      try {
        const instr = '__fake_slow__ attach resend smoke';
        const p1 = c1.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: instr, waitMaxSec: 1 },
        }, undefined, { timeout: 30000 });

        // Wait for runner to actually enter running state
        const db = new Database(DB_PATH);
        let waited = 0;
        while (waited < 5000) {
          const n = (db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE module_name = ? AND run_status = 'running'`).get(MOD) as any).n;
          if (n > 0) break;
          await new Promise(r => setTimeout(r, 100));
          waited += 100;
        }
        db.close();

        const r2 = await c2.callTool({
          name: 'update_module',
          arguments: { moduleName: MOD, instruction: instr, waitMaxSec: 1 },
        }, undefined, { timeout: 30000 });
        const sc2 = (r2 as any).structuredContent as any;
        expect(sc2.attached).toBe(true);
        expect(sc2.warning).toBeUndefined();

        await p1;
      } finally {
        await c1.close();
        await c2.close();
      }
    } finally { forceAllTerminal(MOD); }
  });
});
