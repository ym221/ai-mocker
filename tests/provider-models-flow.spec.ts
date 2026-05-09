/**
 * Provider 预置模型 + 用户偏好 + 新建对话流程 全链路测试
 *
 * 覆盖:
 * - PM: provider_models CRUD / 测试 / set-default / 删除 fallback / 不能删最后一个
 * - UP: 用户偏好 GET/PUT
 * - AS: session 创建时自动用默认 provider/model + 临时模型自动入库
 * - LM: MCP list_models 工具行为(按 provider 分组 + displayName 去歧)
 * - UI: 新建对话不弹 dialog,直接进
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForBackend, getToken, apiRequest } from './helpers';

const MCP_URL = new URL('http://localhost:3000/mcp');

async function generateApiKey(token: string): Promise<string> {
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function connectMcp(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'provider-models-flow-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

// ============= API: provider models CRUD =============

test.describe('PM — provider_models CRUD + 边界', () => {
  let token: string;
  let providerId: number;

  test.beforeAll(async () => {
    await waitForBackend();
    token = await getToken();
    // 创建测试 provider(defaultModel='m1' 自动 INSERT 一条 provider_models)
    const r = await apiRequest('POST', '/api/providers', token, {
      name: 'pm-flow-' + Date.now().toString(36),
      type: 'openai',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'm1',
      scope: 'private',
    });
    expect(r.status).toBe(201);
    providerId = r.data.data.id;
  });

  test.afterAll(async () => {
    if (providerId && token) await apiRequest('DELETE', `/api/providers/${providerId}`, token);
  });

  test('PM01 — 创建 provider 时自动入第一个 model 作为 default', async () => {
    const r = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(r.status).toBe(200);
    expect(r.data.data.length).toBe(1);
    expect(r.data.data[0].modelName).toBe('m1');
    expect(r.data.data[0].isDefault).toBe(true);
  });

  test('PM02 — 添加新模型(非默认) + 重复添加返 409', async () => {
    const r = await apiRequest('POST', `/api/providers/${providerId}/models`, token, {
      modelName: 'm2',
      note: '更便宜',
    });
    expect(r.status).toBe(201);
    expect(r.data.data.modelName).toBe('m2');
    expect(r.data.data.isDefault).toBe(false);
    expect(r.data.data.note).toBe('更便宜');

    const dup = await apiRequest('POST', `/api/providers/${providerId}/models`, token, { modelName: 'm2' });
    expect(dup.status).toBe(409);
  });

  test('PM03 — set-default 更新 providers.defaultModel', async () => {
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const m2 = list.data.data.find((m: any) => m.modelName === 'm2');
    expect(m2).toBeTruthy();

    await apiRequest('POST', `/api/providers/${providerId}/models/${m2.id}/set-default`, token);

    const after = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(after.data.data.find((m: any) => m.modelName === 'm2').isDefault).toBe(true);
    expect(after.data.data.find((m: any) => m.modelName === 'm1').isDefault).toBe(false);
  });

  test('PM04 — PUT 改 note', async () => {
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const m1 = list.data.data.find((m: any) => m.modelName === 'm1');
    await apiRequest('PUT', `/api/providers/${providerId}/models/${m1.id}`, token, { note: '基础款' });
    const after = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(after.data.data.find((m: any) => m.modelName === 'm1').note).toBe('基础款');
  });

  test('PM05 — 测试一个肯定不通的 model → is_verified=0 + lastVerifiedError 写回', async () => {
    test.setTimeout(60_000);
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const m1 = list.data.data.find((m: any) => m.modelName === 'm1');

    const t = await apiRequest('POST', `/api/providers/${providerId}/models/${m1.id}/test`, token);
    expect(t.status).toBe(200);
    expect(t.data.data.ok).toBe(false); // base_url 127.0.0.1:1 不通

    const after = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const updatedM1 = after.data.data.find((m: any) => m.modelName === 'm1');
    expect(updatedM1.isVerified).toBe(0);
    expect(updatedM1.lastVerifiedAt).toBeTruthy();
    expect(updatedM1.lastVerifiedError).toBeTruthy();
  });

  test('PM06 — 删除 default model → 自动 fallback 到剩余的(verified 优先 / 否则第一个)', async () => {
    // 当前 default 是 m2,删除它 → 应该 fallback 到 m1
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const m2 = list.data.data.find((m: any) => m.modelName === 'm2');
    const r = await apiRequest('DELETE', `/api/providers/${providerId}/models/${m2.id}`, token);
    expect(r.status).toBe(200);

    const after = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(after.data.data.length).toBe(1);
    const m1 = after.data.data[0];
    expect(m1.modelName).toBe('m1');
    expect(m1.isDefault).toBe(true);
  });

  test('PM07 — 只剩 1 个 model 时不能删', async () => {
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(list.data.data.length).toBe(1);
    const m1 = list.data.data[0];

    const r = await apiRequest('DELETE', `/api/providers/${providerId}/models/${m1.id}`, token);
    expect(r.status).toBe(400);
    expect(r.data.message).toMatch(/至少保留|不能删除/);

    // 仍存在
    const after = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    expect(after.data.data.length).toBe(1);
  });
});

// ============= API: 用户偏好 =============

test.describe('UP — 用户偏好(默认 provider)', () => {
  let token: string;
  let pubProviderId: number;

  test.beforeAll(async () => {
    await waitForBackend();
    token = await getToken();
    // 创建一个 public provider 用来测试
    const r = await apiRequest('POST', '/api/providers', token, {
      name: 'up-pub-' + Date.now().toString(36),
      type: 'openai',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'm1',
      scope: 'public',
    });
    pubProviderId = r.data.data.id;
  });

  test.afterAll(async () => {
    if (pubProviderId && token) await apiRequest('DELETE', `/api/providers/${pubProviderId}`, token);
    // 重置用户偏好
    await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: null });
  });

  test('UP01 — GET 默认返回 null(初始无偏好)', async () => {
    await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: null });
    const r = await apiRequest('GET', '/api/users/me/preferences', token);
    expect(r.status).toBe(200);
    expect(r.data.data.defaultProviderId).toBeNull();
  });

  test('UP02 — PUT 设置 + GET 回读', async () => {
    const r = await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: pubProviderId });
    expect(r.status).toBe(200);
    expect(r.data.data.defaultProviderId).toBe(pubProviderId);

    const r2 = await apiRequest('GET', '/api/users/me/preferences', token);
    expect(r2.data.data.defaultProviderId).toBe(pubProviderId);
  });

  test('UP03 — PUT 不存在的 provider id → 404', async () => {
    const r = await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: 999999 });
    expect(r.status).toBe(404);
  });

  test('UP04 — PUT null 取消默认', async () => {
    await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: pubProviderId });
    const r = await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: null });
    expect(r.data.data.defaultProviderId).toBeNull();
  });
});

// ============= API: session auto-default + 临时模型入库 =============

test.describe('AS — session 创建自动默认 + 临时模型入库', () => {
  let token: string;
  let providerId: number;

  test.beforeAll(async () => {
    await waitForBackend();
    token = await getToken();
    const r = await apiRequest('POST', '/api/providers', token, {
      name: 'as-' + Date.now().toString(36),
      type: 'openai',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'as-default',
      scope: 'private',
    });
    providerId = r.data.data.id;
    await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: providerId });
  });

  test.afterAll(async () => {
    if (providerId && token) await apiRequest('DELETE', `/api/providers/${providerId}`, token);
    await apiRequest('PUT', '/api/users/me/preferences', token, { defaultProviderId: null });
  });

  test('AS01 — createSession 不传 providerId → 自动用 user.defaultProviderId', async () => {
    const r = await apiRequest('POST', '/api/sessions', token, { title: 'as01' });
    expect(r.status).toBe(201);
    expect(r.data.data.providerId).toBe(providerId);
    expect(r.data.data.model).toBe('as-default');
    await apiRequest('DELETE', `/api/sessions/${r.data.data.id}`, token);
  });

  test('AS02 — createSession 传临时未知 model → 自动入 provider_models', async () => {
    const r = await apiRequest('POST', '/api/sessions', token, {
      title: 'as02',
      model: 'as-temp-model-' + Date.now().toString(36),
    });
    const tempModel = r.data.data.model;

    // 该 model 应该被自动入库
    const list = await apiRequest('GET', `/api/providers/${providerId}/models`, token);
    const found = list.data.data.find((m: any) => m.modelName === tempModel);
    expect(found).toBeTruthy();
    expect(found.note).toBe('对话中临时添加');
    expect(found.isVerified).toBe(0);

    // cleanup
    await apiRequest('DELETE', `/api/sessions/${r.data.data.id}`, token);
    await apiRequest('DELETE', `/api/providers/${providerId}/models/${found.id}`, token);
  });
});

// ============= MCP: list_models =============

test.describe('LM — MCP list_models 工具', () => {
  let token: string;
  let mcpKey: string;
  let providerAId: number;
  let providerBId: number;

  test.beforeAll(async () => {
    await waitForBackend();
    token = await getToken();
    mcpKey = await generateApiKey(token);

    // 创建两个同名 provider 触发 disambiguation:一个 public,一个 private
    const sameName = 'lm-test-' + Date.now().toString(36);
    const a = await apiRequest('POST', '/api/providers', token, {
      name: sameName, type: 'openai', apiKey: 'sk-a',
      baseUrl: 'http://x/v1', defaultModel: 'a-default', scope: 'public',
    });
    providerAId = a.data.data.id;

    const b = await apiRequest('POST', '/api/providers', token, {
      name: sameName, type: 'anthropic', apiKey: 'sk-b',
      baseUrl: 'http://y/v1', defaultModel: 'b-default', scope: 'private',
    });
    providerBId = b.data.data.id;
  });

  test.afterAll(async () => {
    if (providerAId) await apiRequest('DELETE', `/api/providers/${providerAId}`, token);
    if (providerBId) await apiRequest('DELETE', `/api/providers/${providerBId}`, token);
  });

  test('LM01 — list_models 返回按 provider 分组,含 defaultModel/models/isVerified', async () => {
    const c = await connectMcp(mcpKey);
    try {
      const r = await c.callTool({ name: 'list_models', arguments: {} });
      const sc = (r as any).structuredContent;
      expect(sc.providers).toBeDefined();
      expect(Array.isArray(sc.providers)).toBe(true);

      // 至少看到我刚创建的 2 个
      const a = sc.providers.find((p: any) => p.id === providerAId);
      const b = sc.providers.find((p: any) => p.id === providerBId);
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a.defaultModel).toBe('a-default');
      expect(a.models[0].name).toBe('a-default');
      expect(a.models[0].isDefault).toBe(true);
    } finally { await c.close(); }
  });

  test('LM02 — 同名 provider 返回 displayName 加后缀去歧', async () => {
    const c = await connectMcp(mcpKey);
    try {
      const r = await c.callTool({ name: 'list_models', arguments: {} });
      const sc = (r as any).structuredContent;
      const a = sc.providers.find((p: any) => p.id === providerAId);
      const b = sc.providers.find((p: any) => p.id === providerBId);

      // 两个同名 → 加后缀
      expect(a.displayName).toMatch(/公开|我的/);
      expect(b.displayName).toMatch(/公开|我的/);
      expect(a.displayName).not.toBe(a.name);
      expect(b.displayName).not.toBe(b.name);
      expect(a.displayName).not.toBe(b.displayName); // 一定能区分
    } finally { await c.close(); }
  });

  test('LM03 — list_models 在工具列表里(13 工具)', async () => {
    const c = await connectMcp(mcpKey);
    try {
      const { tools } = await c.listTools();
      expect(tools.length).toBe(13);
      expect(tools.find((t: any) => t.name === 'list_models')).toBeTruthy();
    } finally { await c.close(); }
  });
});

// ============= UI: 新建对话直进(无弹窗) =============

test.describe('NEW — 新建对话直接进', () => {
  test('NEW01 — 点新建对话按钮直接跳到 /chat/:id,不弹 dialog', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForSelector('[data-testid="new-session-btn"]');
    await page.click('[data-testid="new-session-btn"]');

    // 应该跳到 /chat/{uuid},而不是弹 dialog
    await page.waitForURL(/\/chat\/[\w-]+/, { timeout: 5000 });
    // 老的 dialog 不应该出现
    expect(await page.locator('[data-testid="session-config-dialog"]').count()).toBe(0);
  });
});
