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
