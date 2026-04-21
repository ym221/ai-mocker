/**
 * MCP Server v2 (Step-MCP-2) 集成测试
 *
 * 累积式：各 Task 完成时往这里追加用例。最终 Task 2.11 会检查覆盖完整性。
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const MCP_URL = new URL('http://localhost:3000/mcp');

async function generateApiKey(username = 'admin', password = 'admin123'): Promise<string> {
  const token = await getToken(username, password);
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function connect(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'mcp-v2-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

// =============== Task 2.2：get_mock_access_log / get_module_health ===============

test.describe('MCP v2 — 只读增强工具', () => {
  test('M11 get_mock_access_log 返回最近 /mock/user 的请求', async () => {
    // 先造几条访问记录
    await fetch('http://localhost:3000/mock/user');
    await fetch('http://localhost:3000/mock/user?page=1');
    await fetch('http://localhost:3000/mock/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'access_log_test', email: 'a@t.com', password: 'x' }),
    });
    await new Promise((r) => setTimeout(r, 150));

    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'get_mock_access_log',
      arguments: { moduleName: 'user', limit: 10 },
    });
    const sc = (r as any).structuredContent as { logs: any[]; total: number };
    expect(sc.logs.length).toBeGreaterThanOrEqual(3);
    expect(sc.total).toBeGreaterThanOrEqual(3);
    expect(sc.logs[0].method).toMatch(/GET|POST/);
    expect(sc.logs[0].path).toContain('/mock/user');
    await client.close();
  });

  test('M12 get_mock_access_log limit clamp 到 100', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'get_mock_access_log',
      arguments: { moduleName: 'user', limit: 500 },
    });
    const sc = (r as any).structuredContent as { logs: any[]; returned: number };
    expect(sc.returned).toBeLessThanOrEqual(100);
    await client.close();
  });

  test('M13 get_module_health: user 模块健康', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'get_module_health',
      arguments: { moduleName: 'user' },
    });
    const sc = (r as any).structuredContent as { health: string; missingFiles: string[] };
    expect(sc.health).toBe('healthy');
    expect(sc.missingFiles.length).toBe(0);
    await client.close();
  });

  test('M14 get_module_health: 不存在模块返回 missing', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'get_module_health',
      arguments: { moduleName: 'absolutely-does-not-exist-xyz' },
    });
    const sc = (r as any).structuredContent as { health: string };
    expect(sc.health).toBe('missing');
    await client.close();
  });
});

// =============== Task 2.3：diff_with_openapi ===============

test.describe('MCP v2 — diff_with_openapi', () => {
  test('M15 对齐场景：完整符合 spec 返回 aligned=true', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'diff_with_openapi',
      arguments: {
        moduleName: 'user',
        actualRequest: {
          method: 'POST',
          path: '/mock/user',
          body: { username: 'alice', email: 'a@b.com', password: 'secret' },
        },
        actualResponse: {
          statusCode: 200,
          body: {
            success: true,
            data: { id: 1, username: 'alice', email: 'a@b.com', password: 'secret' },
          },
        },
      },
    });
    const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
    expect(sc.aligned).toBe(true);
    expect(sc.diffs.length).toBe(0);
    await client.close();
  });

  test('M16 缺字段：actual 缺必填 username', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'diff_with_openapi',
      arguments: {
        moduleName: 'user',
        actualRequest: {
          method: 'POST',
          path: '/mock/user',
          body: { email: 'a@b.com', password: 'secret' }, // 缺 username
        },
      },
    });
    const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
    expect(sc.aligned).toBe(false);
    const usernameDiff = sc.diffs.find((d: any) => d.path.includes('username'));
    expect(usernameDiff).toBeTruthy();
    expect(usernameDiff.kind).toBe('missing-in-actual');
    await client.close();
  });

  test('M17 多字段：actual 多了 spec 没有的字段', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'diff_with_openapi',
      arguments: {
        moduleName: 'user',
        actualRequest: {
          method: 'POST',
          path: '/mock/user',
          body: { username: 'alice', email: 'a@b.com', password: 'x', bonusField: 42 },
        },
      },
    });
    const sc = (r as any).structuredContent as { aligned: boolean; diffs: any[] };
    const extra = sc.diffs.find((d: any) => d.path.includes('bonusField'));
    expect(extra).toBeTruthy();
    expect(extra.kind).toBe('missing-in-spec');
    await client.close();
  });

  test('M18 端点不存在：POST 到 /mock/user/:id 返回 endpoint-not-in-spec', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'diff_with_openapi',
      arguments: {
        moduleName: 'user',
        actualRequest: {
          method: 'POST', // spec 里 POST 只有 /mock/user，没有 /mock/user/:id
          path: '/mock/user/999',
          body: {},
        },
      },
    });
    const sc = (r as any).structuredContent as { diffs: any[] };
    expect(sc.diffs.some((d: any) => d.kind === 'endpoint-not-in-spec')).toBe(true);
    await client.close();
  });
});

// =============== Task 2.4：delete_module / run_test / manage_data ===============

test.describe('MCP v2 — 轻量写工具', () => {
  test('M19 manage_data bulk_generate + list 基础往返', async () => {
    const key = await generateApiKey();
    const client = await connect(key);

    // clear first
    await client.callTool({ name: 'manage_data', arguments: { action: 'clear', moduleName: 'user' } });

    // bulk generate 5 条
    const gen = await client.callTool({
      name: 'manage_data',
      arguments: { action: 'bulk_generate', moduleName: 'user', count: 5 },
    });
    expect((gen as any).isError).toBeFalsy();

    // list
    const listed = await client.callTool({
      name: 'manage_data',
      arguments: { action: 'list', moduleName: 'user', pageSize: 10 },
    });
    const sc = (listed as any).structuredContent as { result: any };
    expect(sc.result.total).toBeGreaterThanOrEqual(5);

    await client.close();
  });

  test('M20 manage_data insert + update + delete 完整 CRUD', async () => {
    const key = await generateApiKey();
    const client = await connect(key);

    // clear
    await client.callTool({ name: 'manage_data', arguments: { action: 'clear', moduleName: 'user' } });

    // insert
    const ins = await client.callTool({
      name: 'manage_data',
      arguments: {
        action: 'insert',
        moduleName: 'user',
        data: { username: 'mcp_crud', email: 'm@c.com', password: 'x' },
      },
    });
    if ((ins as any).isError) {
      throw new Error(`insert failed: ${(ins as any).content?.[0]?.text}`);
    }
    const insResult = (ins as any).structuredContent?.result as any;
    expect(insResult, `insert structuredContent missing; raw=${JSON.stringify(ins)}`).toBeTruthy();
    const newId = insResult.id;
    expect(newId).toBeGreaterThan(0);

    // update
    const upd = await client.callTool({
      name: 'manage_data',
      arguments: {
        action: 'update',
        moduleName: 'user',
        id: newId,
        data: { role: 'admin' },
      },
    });
    expect((upd as any).isError).toBeFalsy();

    // delete
    const del = await client.callTool({
      name: 'manage_data',
      arguments: { action: 'delete', moduleName: 'user', id: newId },
    });
    expect((del as any).isError).toBeFalsy();

    await client.close();
  });

  test('M21 run_test 跑 user 模块回归', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({ name: 'run_test', arguments: { moduleName: 'user' } });
    const sc = (r as any).structuredContent as { passed: number; total: number; allPassed: boolean };
    // user fixture 的 test.ts 应该全绿
    expect(sc.total).toBeGreaterThan(0);
    expect(sc.allPassed).toBe(true);
    await client.close();
  });

  test('M22 delete_module 对不存在模块返回友好错误', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'delete_module',
      arguments: { moduleName: 'absolutely-does-not-exist' },
    });
    expect((r as any).isError).toBe(true);
    await client.close();
  });

  test('M23 delete_module 实际删除（造一个临时模块再删）', async () => {
    // 通过直接写 DB 造一个最小模块（无文件，只用 modules 表记录 + delete 验证 DB 清理）
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const db = new Database(resolve(process.cwd(), 'data', 'mockforge.db'));
    const tmpName = 'mcp_tmp_delete_target';
    try {
      db.prepare('DELETE FROM modules WHERE name = ? AND user_id = ?').run(tmpName, 1);
      db.prepare(
        'INSERT INTO modules (name, user_id, display_name, base_path, status) VALUES (?, ?, ?, ?, ?)'
      ).run(tmpName, 1, 'tmp', `/mock/${tmpName}`, 'active');
    } finally {
      db.close();
    }

    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({ name: 'delete_module', arguments: { moduleName: tmpName } });
    expect((r as any).isError).toBeFalsy();
    const sc = (r as any).structuredContent as { deleted: boolean };
    expect(sc.deleted).toBe(true);
    await client.close();

    // 验证 DB 里确实删了
    const db2 = new Database(resolve(process.cwd(), 'data', 'mockforge.db'));
    try {
      const row = db2.prepare('SELECT id FROM modules WHERE name = ? AND user_id = ?').get(tmpName, 1);
      expect(row).toBeFalsy();
    } finally {
      db2.close();
    }
  });
});
