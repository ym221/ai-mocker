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

  test('M26 update_module dry_run 预览（不调 LLM）', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'update_module',
      arguments: { moduleName: 'user', instruction: '加一个 avatar 字段', dry_run: true },
    });
    const sc = (r as any).structuredContent as { status: string; currentEndpoints: string[] };
    expect(sc.status).toBe('would-update');
    expect(sc.currentEndpoints.length).toBeGreaterThan(0);
    await client.close();
  });

  test('M30 tools/list 返回所有 12 个工具名', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_module_from_spec',
      'delete_module',
      'diff_with_openapi',
      'generate_handoff_report',
      'get_api_doc',
      'get_mock_access_log',
      'get_module_health',
      'get_openapi',
      'list_modules',
      'manage_data',
      'run_test',
      'update_module',
    ]);
    await client.close();
  });

  test('M31 guide resource 已更新，提及新工具名', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const guide = await client.readResource({ uri: 'mockforge://guide' });
    const text = (guide.contents[0] as any).text as string;
    expect(text).toContain('create_module_from_spec');
    expect(text).toContain('update_module');
    expect(text).toContain('get_mock_access_log');
    expect(text).toContain('diff_with_openapi');
    expect(text).toContain('generate_handoff_report');
    // 不该再提到 "v1 只读"
    expect(text).not.toMatch(/v1[：:].*只读/);
    await client.close();
  });

  test('M28 generate_handoff_report 含核心 section', async () => {
    // 确保有几条访问记录
    await fetch('http://localhost:3000/mock/user');
    await fetch('http://localhost:3000/mock/user/99999');  // probably 404
    await new Promise((r) => setTimeout(r, 150));

    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'generate_handoff_report',
      arguments: { moduleName: 'user' },
    });
    const sc = (r as any).structuredContent as { markdown: string; stats: any };
    expect(sc.markdown).toContain('# 用户管理 Mock 交接报告');
    expect(sc.markdown).toContain('## 契约概要');
    expect(sc.markdown).toContain('## 模块健康状态');
    expect(sc.markdown).toContain('## 访问日志摘要');
    expect(sc.markdown).toContain('## 后端交接建议');
    expect(sc.stats.endpointCount).toBeGreaterThan(0);
    await client.close();
  });

  test('M29 generate_handoff_report 不存在模块返回 isError', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'generate_handoff_report',
      arguments: { moduleName: 'ghost' },
    });
    expect((r as any).isError).toBe(true);
    await client.close();
  });

  test('M27 update_module 对不存在模块返回 isError', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'update_module',
      arguments: { moduleName: 'ghost-module', instruction: 'anything', dry_run: true },
    });
    expect((r as any).isError).toBe(true);
    await client.close();
  });

  // =========== 真实 LLM：使用 admin 的 gemma provider（id=1, free）===========
  test('M25 create_module_from_spec 真实生成（调用 gemma 免费模型）', async () => {
    test.setTimeout(300_000);  // 最多 5 分钟

    // headless-session 默认选 scope=public 里 id 最小的 provider
    // = seed 的 gemma（免费），与用户要求一致

    // 如果之前测试留下了同名 fixture，先删掉
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const { existsSync, rmSync } = await import('fs');
    const testName = 'mcp_test_feedback';
    const dbc = new Database(resolve(process.cwd(), 'data', 'mockforge.db'));
    try {
      const mod = dbc.prepare('SELECT id FROM modules WHERE name = ? AND user_id = 1').get(testName) as any;
      if (mod) dbc.prepare('DELETE FROM modules WHERE id = ?').run(mod.id);
      dbc.exec(`DROP TABLE IF EXISTS mock__1_${testName}`);
    } finally { dbc.close(); }
    const dir = resolve(process.cwd(), 'generated/1', testName);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'create_module_from_spec',
      arguments: {
        moduleName: testName,
        spec: `请创建一个反馈管理模块，包含字段：content（反馈内容，文本必填）、rating（评分，1-5 整数必填）。端点需要支持列表、详情、创建、更新、删除。`,
      },
    }, undefined, { timeout: 300_000 });

    const sc = (r as any).structuredContent as any;
    if ((r as any).isError) {
      throw new Error(`create failed: ${(r as any).content?.[0]?.text}; sessionId=${sc?.sessionId}`);
    }
    expect(sc.status).toBe('created');
    expect(sc.moduleName).toBe(testName);
    expect(sc.endpoints.length).toBeGreaterThan(0);
    expect(sc.mockBaseUrl).toContain(testName);

    // 调一次生成的端点，确认真能响应
    const mockRes = await fetch(sc.mockBaseUrl);
    expect([200, 404]).toContain(mockRes.status);  // list 端点应该可访问

    await client.close();
  });

  test('M32 update_module 真实修改（延续 M25 创建的模块）', async () => {
    test.setTimeout(300_000);

    const testName = 'mcp_test_feedback';
    // M25 应已创建；若未存在则 skip
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const dbc = new Database(resolve(process.cwd(), 'data', 'mockforge.db'));
    const exists = dbc.prepare('SELECT id FROM modules WHERE name = ? AND user_id = 1').get(testName);
    dbc.close();
    test.skip(!exists, 'M25 未创建 feedback 模块，跳过');

    const key = await generateApiKey();
    const client = await connect(key);
    const r = await client.callTool({
      name: 'update_module',
      arguments: {
        moduleName: testName,
        instruction: '给 feedback 实体增加一个可选字段 tag（string 类型），不要改其他字段或端点。',
      },
    }, undefined, { timeout: 300_000 });

    const sc = (r as any).structuredContent as any;
    if ((r as any).isError) {
      throw new Error(`update failed: ${(r as any).content?.[0]?.text}; sessionId=${sc?.sessionId}`);
    }
    expect(sc.status).toBe('updated');

    await client.close();
  });
  test('M24 create_module_from_spec dry_run 返回 plan 预览（不调 LLM）', async () => {
    const key = await generateApiKey();
    const client = await connect(key);
    const spec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'feedback' },
      paths: {
        '/feedback': {
          get: { summary: 'list' },
          post: { summary: 'create' },
        },
      },
      components: {
        schemas: {
          feedback: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              rating: { type: 'integer' },
            },
          },
        },
      },
    });
    const r = await client.callTool({
      name: 'create_module_from_spec',
      arguments: { spec, moduleName: 'feedback', dry_run: true },
    });
    const sc = (r as any).structuredContent as { status: string; plan: any };
    expect(sc.status).toBe('would-create');
    expect(sc.plan.kind).toBe('openapi-derived');
    expect(sc.plan.entities.map((e: any) => e.name)).toContain('feedback');
    expect(sc.plan.endpoints.length).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  // =========== Step-MCP-3.3：provider / model / preset overrides ===========

  test('M33 create_module_from_spec preset=<id> 写入 session.presetId', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const DB = resolve(process.cwd(), 'data', 'mockforge.db');

    // 造一个属于 user=1 的 preset
    const db = new Database(DB);
    let presetId = 0;
    try {
      db.prepare(`DELETE FROM presets WHERE name = ? AND owner_id = 1`).run('m33-preset');
      const row = db.prepare(
        `INSERT INTO presets (name, description, content, scope, owner_id, is_active)
         VALUES (?, ?, ?, 'private', 1, 1) RETURNING id`
      ).get('m33-preset', 'test', JSON.stringify({ fieldNaming: 'snake_case' })) as { id: number };
      presetId = row.id;
    } finally { db.close(); }

    const result = await runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] M33 override preset by id',
      presetId,
    });
    expect(result.status).toBe('done');

    const db2 = new Database(DB);
    try {
      const sess = db2.prepare(`SELECT preset_id FROM sessions WHERE id = ?`).get(result.sessionId) as { preset_id: number | null };
      expect(sess.preset_id).toBe(presetId);
    } finally { db2.close(); }
  });

  test('M34 create_module_from_spec preset=<name> 按名字查到并绑定', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const DB = resolve(process.cwd(), 'data', 'mockforge.db');

    const db = new Database(DB);
    let presetId = 0;
    try {
      db.prepare(`DELETE FROM presets WHERE name = ? AND owner_id = 1`).run('m34-preset-byname');
      const row = db.prepare(
        `INSERT INTO presets (name, description, content, scope, owner_id, is_active)
         VALUES (?, ?, ?, 'private', 1, 1) RETURNING id`
      ).get('m34-preset-byname', 'test', JSON.stringify({ fieldNaming: 'camelCase' })) as { id: number };
      presetId = row.id;
    } finally { db.close(); }

    const result = await runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] M34 override preset by name',
      presetName: 'm34-preset-byname',
    });
    expect(result.status).toBe('done');

    const db2 = new Database(DB);
    try {
      const sess = db2.prepare(`SELECT preset_id FROM sessions WHERE id = ?`).get(result.sessionId) as { preset_id: number | null };
      expect(sess.preset_id).toBe(presetId);
    } finally { db2.close(); }
  });

  test('M35 create_module_from_spec model=<str> 覆盖 session.model', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');
    const Database = (await import('better-sqlite3')).default;
    const { resolve } = await import('path');
    const DB = resolve(process.cwd(), 'data', 'mockforge.db');

    const customModel = 'my-custom-model-id-for-test';
    const result = await runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] M35 override model',
      model: customModel,
    });
    expect(result.status).toBe('done');

    const db = new Database(DB);
    try {
      const sess = db.prepare(`SELECT model FROM sessions WHERE id = ?`).get(result.sessionId) as { model: string | null };
      expect(sess.model).toBe(customModel);
    } finally { db.close(); }
  });

  test('M36 unknown presetName 抛友好错误', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');
    await expect(runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] M36',
      presetName: '__absolutely-does-not-exist-preset__',
    })).rejects.toThrow(/not found/);
  });

  test('M37 unknown providerId 抛友好错误', async () => {
    const { runHeadlessSession } = await import('../src/server/mcp/lib/headless-session.js');
    await expect(runHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[MCP-TEST] M37',
      providerId: 999999,
    })).rejects.toThrow(/not found|not owned/);
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
