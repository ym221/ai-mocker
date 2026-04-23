/**
 * 并发去重回归测试: 对同一 moduleName 的并发 MCP 写调用,第二次应立刻返回
 * already-processing 错误,而不是建第二个 session + runner。
 *
 * 复刻用户看到的"两个 [MCP] create ware... 会话并存,一个卡住 7m+"场景。
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MODULE = 'dedupe_test_mod';

function countRunningSessionsFor(userId: number, moduleName: string): number {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE user_id = ? AND module_name = ? AND run_status = 'running'`
    ).get(userId, moduleName) as { n: number };
    return row.n;
  } finally { db.close(); }
}

function forceTerminalAllRunning(moduleName: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(moduleName);
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });

test.afterEach(() => forceTerminalAllRunning(MODULE));

test.describe('MCP in-flight 并发去重', () => {
  test('D01 findInFlightSession 对无活动 runner 的 moduleName 返回 inFlight=false', async () => {
    const { findInFlightSession } = await import('../src/server/mcp/lib/in-flight-lock.js');
    const r = findInFlightSession(1, '__absolutely-not-running-xyz__');
    expect(r.inFlight).toBe(false);
  });

  test('D02 存在 running session + 活动 ChatRunner 时, findInFlightSession 返回 inFlight=true', async () => {
    const { findInFlightSession } = await import('../src/server/mcp/lib/in-flight-lock.js');
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    // 启一个假流 session,FAKE_SLOW 保证 7s+ 仍处于 running 状态,给测试留窗口
    const slowPromise = runHeadlessSession({
      userId: 1,
      userContent: '__fake_slow__',
      title: '[MCP-TEST] D02 slow',
      moduleName: MODULE,
    });

    // 等 runner 真正进入 running
    let found = { inFlight: false } as any;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      found = findInFlightSession(1, MODULE);
      if (found.inFlight) break;
    }
    expect(found.inFlight).toBe(true);
    expect(found.existingSessionId).toBeTruthy();

    // 让后台 runner 跑完以便清理
    await slowPromise;
  });

  test('D03 并发两次 runHeadlessSession(同 moduleName) — 第二次不会创建第二个 running session', async () => {
    // 这个测试模拟 Cursor 重试导致的"双 session"问题
    // 注意:我们不测 MCP tool 层(那需 HTTP+认证),而是测底层 findInFlightSession 行为
    const { findInFlightSession } = await import('../src/server/mcp/lib/in-flight-lock.js');
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');

    // 第 1 次启动,用 fake_slow 延迟 finalize,模拟一个"正在跑"的 MCP create
    const first = runHeadlessSession({
      userId: 1,
      userContent: '__fake_slow__',
      title: '[MCP-TEST] D03 concurrent #1',
      moduleName: MODULE,
    });

    // 等它进入 running
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (findInFlightSession(1, MODULE).inFlight) break;
    }

    // 此时 runningSessions 应为 1
    expect(countRunningSessionsFor(1, MODULE)).toBe(1);

    // 第 2 次调用 — 在真实 MCP 工具里会被 dedupe 拒绝;这里直接验证 guard 的返回
    const { inFlight, existingSessionId } = findInFlightSession(1, MODULE);
    expect(inFlight).toBe(true);
    expect(existingSessionId).toBeTruthy();

    // 等第一个跑完
    await first;
  });

  test('D04 create_module_from_spec MCP tool 在有 in-flight session 时返回 already-processing', async () => {
    // 关键设计:必须通过 MCP HTTP 调起 server 进程内的 ChatRunner,
    // dedupe 才能在 server 的 registry 里看见 in-flight 状态。
    // 测试进程直接调 runHeadlessSession 跑出来的 runner 在另一个进程,server 看不见。

    const token = await getToken();
    await apiRequest('DELETE', '/api/users/me/api-key', token);
    const keyRes = await apiRequest('POST', '/api/users/me/api-key', token);
    const apiKey = keyRes.data.data.apiKey as string;

    const newClient = async () => {
      const t = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
        requestInit: { headers: { 'X-API-Key': apiKey } },
      });
      const c = new Client({ name: 'dedupe-spec', version: '0.0.0' });
      await c.connect(t);
      return c;
    };

    const c1 = await newClient();
    const c2 = await newClient();
    try {
      // 第一次调用: spec 含 __fake_slow__ → server 进入 fake-slow 假流
      // 不 await,先让它后台跑
      const fastSpec = '__fake_slow__ this is a fake-slow generation marker';
      const p1 = c1.callTool({
        name: 'create_module_from_spec',
        arguments: { moduleName: MODULE, spec: fastSpec },
      }, undefined, { timeout: 60000 });

      // 等 server 端的 ChatRunner 进入 running(轮询 sessions 表)
      let waited = 0;
      while (waited < 5000) {
        if (countRunningSessionsFor(1, MODULE) > 0) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      expect(countRunningSessionsFor(1, MODULE)).toBe(1);

      // 第二次调用: 应立即被 dedupe(无需等 LLM,几毫秒返回)
      const r2 = await c2.callTool({
        name: 'create_module_from_spec',
        arguments: { moduleName: MODULE, spec: '无所谓 - 应被 dedupe' },
      }, undefined, { timeout: 5000 });

      expect((r2 as any).isError).toBe(true);
      const sc = (r2 as any).structuredContent as { status: string; existingSessionId?: string };
      expect(sc.status).toBe('already-processing');
      expect(sc.existingSessionId).toBeTruthy();
      expect((r2 as any).content?.[0]?.text).toContain('already being created');

      // dedupe 期间运行的 session 仍是 1(不是 2)
      expect(countRunningSessionsFor(1, MODULE)).toBe(1);

      // 等第一个跑完
      await p1;
    } finally {
      await c1.close();
      await c2.close();
    }

    // slow runner 完成后, running session 数=0
    expect(countRunningSessionsFor(1, MODULE)).toBe(0);
  });
});
