/**
 * MCP Server 集成测试。
 *
 * 复用 Playwright test runner，但不启浏览器 —— 直接用 MCP SDK 的 Client 连后端。
 * 覆盖 Step-MCP-1 的 10 条用例 (M01-M10)。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const MCP_URL = new URL('http://localhost:3000/mcp');
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

async function generateApiKeyFor(username: string, password: string): Promise<string> {
  const token = await getToken(username, password);
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function ensureSecondUser() {
  // Create 'mcpuser2' if missing. Uses registration endpoint when open.
  // Fallback: insert directly via DB (bcrypt hash below is for password 'pass123456').
  const db = new Database(DB_PATH);
  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('mcpuser2') as { id: number } | undefined;
    if (existing) return existing.id;
  } finally {
    db.close();
  }
  // Register via public endpoint
  const res = await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mcpuser2', password: 'pass123456' }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create mcpuser2: ${res.status}`);
  }
  const db2 = new Database(DB_PATH);
  try {
    const row = db2.prepare('SELECT id FROM users WHERE username = ?').get('mcpuser2') as { id: number };
    return row.id;
  } finally {
    db2.close();
  }
}

async function connectClient(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const client = new Client({ name: 'mcp-spec', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test.beforeAll(async () => {
  await waitForBackend();
  // 确保 admin 有 'user' 模块 fixture
  const token = await getToken();
  await ensureUserModule(token);
});

// ================= 鉴权 =================

test.describe('MCP Server — 鉴权', () => {
  test('M01 缺失或错误 key 返回 401', async () => {
    // 不带 key
    const res1 = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res1.status).toBe(401);

    // 错误 key
    const res2 = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-API-Key': 'mf_this_key_does_not_exist_xxxxxxxxxxxxxxx',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res2.status).toBe(401);
  });
});

// ================= 基础握手 + 工具 =================

test.describe('MCP Server — 基础协议', () => {
  test('M02 initialize 能与正确 key 完成握手', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const info = client.getServerVersion();
    expect(info?.name).toBe('mockforge');
    await client.close();
  });

  test('M03 tools/list 包含 3 个预期工具', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_api_doc', 'get_openapi', 'list_modules']);
    await client.close();
  });
});

// ================= 只读工具行为 =================

test.describe('MCP Server — 只读工具', () => {
  test('M04 list_modules 返回 admin 的 user 模块', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const r = await client.callTool({ name: 'list_modules', arguments: {} });
    const sc = (r as any).structuredContent as { modules: any[]; total: number };
    expect(sc.total).toBeGreaterThan(0);
    const userMod = sc.modules.find((m) => m.name === 'user');
    expect(userMod).toBeTruthy();
    expect(userMod.mockBaseUrl).toMatch(/\/mock\/user$/);
    expect(Array.isArray(userMod.endpoints)).toBe(true);
    expect(userMod.health).toBe('healthy');
    await client.close();
  });

  test('M05 get_api_doc 读取存在模块的文档', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const r = await client.callTool({ name: 'get_api_doc', arguments: { moduleName: 'user' } });
    expect((r as any).isError).toBeFalsy();
    const text = (r as any).content?.[0]?.text as string;
    expect(text).toContain('用户管理 API');
    await client.close();
  });

  test('M06 get_openapi 输出合法 3.0.3 spec', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const r = await client.callTool({ name: 'get_openapi', arguments: { moduleName: 'user' } });
    const sc = (r as any).structuredContent;
    expect(sc?.openapi?.openapi).toBe('3.0.3');
    expect(Object.keys(sc?.openapi?.paths || {}).length).toBeGreaterThan(0);
    expect(sc?.openapi?.components?.schemas?.user).toBeTruthy();
    await client.close();
  });

  test('M07 不存在模块返回 isError', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const r = await client.callTool({ name: 'get_api_doc', arguments: { moduleName: 'nope-xyz-404' } });
    expect((r as any).isError).toBe(true);
    expect(((r as any).content?.[0]?.text || '') as string).toContain('not found');
    await client.close();
  });
});

// ================= Resource =================

test.describe('MCP Server — Resource', () => {
  test('M08 resources/list + read 能拿到 guide', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const client = await connectClient(key);
    const list = await client.listResources();
    const guide = list.resources.find((r) => r.uri === 'mockforge://guide');
    expect(guide).toBeTruthy();

    const read = await client.readResource({ uri: 'mockforge://guide' });
    const text = (read.contents[0] as any).text as string;
    expect(text).toContain('MockForge MCP');
    expect(text).toContain('list_modules');
    // v1 只读边界：不能提到尚未存在的写工具
    expect(text).not.toContain('create_module_from_spec');
    await client.close();
  });
});

// ================= 副作用 & 隔离 =================

test.describe('MCP Server — 副作用 / 隔离', () => {
  test('M09 调用工具后 api_key_last_used_at 被更新', async () => {
    const key = await generateApiKeyFor('admin', 'admin123');
    const token = await getToken('admin', 'admin123');

    // 初始应为 null
    const before = await apiRequest('GET', '/api/users/me/api-key', token);
    expect(before.data.data.lastUsedAt).toBeNull();

    const client = await connectClient(key);
    await client.callTool({ name: 'list_modules', arguments: {} });
    await client.close();

    // 给 SQLite 写入留点时间
    await new Promise((r) => setTimeout(r, 100));
    const after = await apiRequest('GET', '/api/users/me/api-key', token);
    expect(after.data.data.lastUsedAt).not.toBeNull();
  });

  test('M10 用户隔离：userB 的 key 看不到 userA 的模块', async () => {
    await ensureSecondUser();
    const keyA = await generateApiKeyFor('admin', 'admin123');
    const keyB = await generateApiKeyFor('mcpuser2', 'pass123456');

    const clientA = await connectClient(keyA);
    const rA = await clientA.callTool({ name: 'list_modules', arguments: {} });
    const scA = (rA as any).structuredContent as { modules: any[]; total: number };
    const aHasUser = scA.modules.some((m) => m.name === 'user');
    expect(aHasUser).toBe(true);
    await clientA.close();

    const clientB = await connectClient(keyB);
    const rB = await clientB.callTool({ name: 'list_modules', arguments: {} });
    const scB = (rB as any).structuredContent as { modules: any[]; total: number };
    expect(scB.total).toBe(0); // user B 没有任何模块
    await clientB.close();

    // userB 直接访问 userA 的模块文档 → not found
    const clientB2 = await connectClient(keyB);
    const r = await clientB2.callTool({ name: 'get_api_doc', arguments: { moduleName: 'user' } });
    expect((r as any).isError).toBe(true);
    await clientB2.close();
  });
});
