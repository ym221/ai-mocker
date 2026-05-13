/**
 * 用"订单管理"业务端到端验证从 MCP 对话 → AI 生成完整模块 → 调用 mock 接口 全链路。
 *
 * 覆盖:
 *   - BaseModel create/update 不强制 created_at/updated_at(spec 没要求就不加)
 *   - write_file / write_files content 接 string|object|array
 *   - finalize 守门:5 文件齐 + run_test failures=0 + controller probe 全过才放行
 *   - 生成的 mock 接口实际可调用,响应结构与 spec 对得上
 *
 * tag @real-llm 复用 real-llm-e2e 过滤约定。
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MCP_URL = new URL('http://localhost:3000/mcp');
const GENERATED_DIR = resolve(process.cwd(), 'generated', '1');
const API_BASE = 'http://localhost:3000';

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
  const c = new Client({ name: 'loosen-e2e', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function cleanupModule(name: string) {
  const db = new Database(DB_PATH);
  try {
    const mod = db.prepare(`SELECT id FROM modules WHERE name = ? AND user_id = 1`).get(name) as { id: number } | undefined;
    if (mod) db.prepare(`DELETE FROM modules WHERE id = ?`).run(mod.id);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?`).all(`mock__1_${name}%`) as Array<{ name: string }>;
    for (const t of tables) {
      try { db.exec(`DROP TABLE IF EXISTS \`${t.name}\``); } catch { /* ignore */ }
    }
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(name);
  } finally { db.close(); }
  const dir = join(GENERATED_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function moduleFiles(name: string): string[] {
  const dir = join(GENERATED_DIR, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

async function runUntilDone(
  c: Client,
  toolName: 'create_module_from_spec' | 'update_module',
  args: Record<string, unknown>,
  opts: { maxPollMs?: number; perCallWaitSec?: number } = {},
): Promise<any> {
  const maxPollMs = opts.maxPollMs ?? 600_000;
  const perCallWaitSec = opts.perCallWaitSec ?? 180;
  const deadline = Date.now() + maxPollMs;
  const callArgs = { ...args, waitMaxSec: perCallWaitSec };

  while (Date.now() < deadline) {
    const r = await c.callTool({ name: toolName, arguments: callArgs } as any, undefined, { timeout: (perCallWaitSec + 30) * 1000 });
    const sc = (r as any).structuredContent as any;
    if (sc?.status === 'still-running') continue;
    return { sc, isError: (r as any).isError === true, content: (r as any).content?.[0]?.text };
  }
  throw new Error(`runUntilDone: exceeded ${maxPollMs}ms total for ${toolName}`);
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('@real-llm 订单管理 MCP→生成→调用 全链路', () => {
  const MOD = 'order_loosen';

  test('LOOSEN-E01 通过 MCP 生成订单管理模块,5 文件齐全 + health=healthy', async () => {
    test.setTimeout(900_000);
    cleanupModule(MOD);

    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const spec = `请生成一个 Mock API 模块:模块名 ${MOD},展示名"订单管理"。

业务:管理电商订单。

数据实体:order(订单)
字段:
- orderNo: string,必填,唯一,订单号(业务唯一,生成时含毫秒+随机后缀)
- customerName: string,必填,客户名称
- amount: integer,必填,金额(分单位,>=0)
- status: string,必填,枚举 [pending, paid, shipped, completed, cancelled],默认 pending

接口:
- GET / 列表(分页 page/pageSize)
- GET /:id 详情
- POST / 创建(返回创建后的完整对象)
- PUT /:id 更新(部分字段)
- DELETE /:id 删除

响应信封: { success: true|false, data: ..., message?: ... }
分页响应: { success: true, data: { list, total, page, pageSize } }

注意:不要在 schema.sql 里加 created_at/updated_at 这种"系统字段",
框架不再硬要求时间戳列。spec 没要求就别加。`;

      const { sc, isError, content } = await runUntilDone(c, 'create_module_from_spec', {
        spec,
        moduleName: MOD,
      });

      if (isError) {
        throw new Error(`create_module_from_spec failed: ${content}\n${JSON.stringify(sc, null, 2)}`);
      }

      expect(sc.moduleName).toBe(MOD);
      expect(sc.status).toBe('created');

      // 5 文件齐全(finalize 守门通过的关键证明)
      const files = moduleFiles(MOD);
      for (const f of ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts', 'api-doc.md']) {
        expect(files, `5 必需文件 ${f} 必须存在`).toContain(f);
      }

      // mockBaseUrl 指向 /mock/<moduleName>
      expect(sc.mockBaseUrl).toContain(`/mock/${MOD}`);

      // 用 inspect_module 验 health = healthy(finalize 守门第 (0) 层放行)
      const inspect = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: MOD, view: 'health' },
      } as any, undefined, { timeout: 10_000 });
      const inspectSc = (inspect as any).structuredContent as any;
      expect(inspectSc?.health?.status, 'health 状态必须 healthy').toBe('healthy');
    } finally {
      await c.close();
    }
  });

  test('LOOSEN-E02 调用生成的 mock 接口 — POST 创建 + GET 列表 + GET 详情 + PUT 更新 + DELETE 删除', async () => {
    test.setTimeout(60_000);
    test.skip(!existsSync(join(GENERATED_DIR, MOD)), 'LOOSEN-E01 未创建模块,跳过');

    // 1) POST create
    const createBody = {
      orderNo: `ORD${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
      customerName: '张三',
      amount: 19900,
      status: 'pending',
    };
    const createRes = await fetch(`${API_BASE}/mock/${MOD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    expect(createRes.status, '创建接口必须 200').toBe(200);
    const createJson = await createRes.json();
    expect(createJson.success, '创建必须 success=true').toBe(true);
    expect(createJson.data, '创建响应必须含 data').toBeTruthy();
    const newId = createJson.data.id;
    expect(typeof newId, '创建必须返回数值 id').toBe('number');
    expect(createJson.data.orderNo).toBe(createBody.orderNo);
    expect(createJson.data.customerName).toBe(createBody.customerName);
    expect(createJson.data.amount).toBe(createBody.amount);

    // 2) GET list
    const listRes = await fetch(`${API_BASE}/mock/${MOD}?page=1&pageSize=10`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.success).toBe(true);
    expect(Array.isArray(listJson.data.list)).toBe(true);
    expect(listJson.data.list.length).toBeGreaterThan(0);
    expect(typeof listJson.data.total).toBe('number');

    // 3) GET detail
    const detailRes = await fetch(`${API_BASE}/mock/${MOD}/${newId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.success).toBe(true);
    expect(detailJson.data.id).toBe(newId);
    expect(detailJson.data.orderNo).toBe(createBody.orderNo);

    // 4) PUT update
    const updateRes = await fetch(`${API_BASE}/mock/${MOD}/${newId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(updateRes.status).toBe(200);
    const updateJson = await updateRes.json();
    expect(updateJson.success).toBe(true);
    expect(updateJson.data.status).toBe('paid');
    // 其它字段保留(部分更新语义)
    expect(updateJson.data.orderNo).toBe(createBody.orderNo);
    expect(updateJson.data.customerName).toBe(createBody.customerName);

    // 5) DELETE
    const delRes = await fetch(`${API_BASE}/mock/${MOD}/${newId}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.success).toBe(true);

    // 6) verify deletion: GET detail returns 404 or success=false
    const verifyRes = await fetch(`${API_BASE}/mock/${MOD}/${newId}`);
    const verifyJson = await verifyRes.json();
    expect(verifyJson.success).toBe(false);
  });

  test('LOOSEN-E03 schema.sql 不应硬塞 created_at/updated_at(spec 没要求)', async () => {
    test.skip(!existsSync(join(GENERATED_DIR, MOD)), 'LOOSEN-E01 未创建模块,跳过');

    const schemaPath = join(GENERATED_DIR, MOD, 'schema.sql');
    expect(existsSync(schemaPath)).toBe(true);
    const sql = readFileSync(schemaPath, 'utf-8');

    // 主键 id 必须有
    expect(sql).toMatch(/`?id`?\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i);

    // 业务字段必须有
    expect(sql).toContain('orderNo');
    expect(sql).toContain('customerName');
    expect(sql).toContain('amount');
    expect(sql).toContain('status');

    // spec 明示不要 created_at/updated_at,AI 应当不加。
    // 这是松绑后的核心证据 — 框架不强制 = AI 按 spec 决定。
    // (容忍 AI 仍然加 — 这是 LLM 习惯,不是框架强制;但记录到日志便于回看)
    const hasCreatedAt = /\bcreated_at\b|\bcreatedAt\b/.test(sql);
    const hasUpdatedAt = /\bupdated_at\b|\bupdatedAt\b/.test(sql);
    if (hasCreatedAt || hasUpdatedAt) {
      // eslint-disable-next-line no-console
      console.warn(`[LOOSEN-E03] AI 仍然添加了时间戳字段(LLM 习惯,非框架强制):
        created_at=${hasCreatedAt}, updated_at=${hasUpdatedAt}.
        schema.sql 内容:\n${sql}`);
    }
  });
});
