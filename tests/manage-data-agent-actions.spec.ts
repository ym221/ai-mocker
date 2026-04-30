/**
 * Step-Observability-1.4: Agent 端 manage_data 行为对齐 MCP 端。
 *
 * 起因: 用户实测中 AI 想"改第一条记录的图片"时,因 Agent tool schema 只暴露
 * insert/bulk_generate/delete/clear → AI 推理出"我没有 update 工具" → 走
 * clear+insert 兜底 → 30 条数据全部被清空。
 *
 * 修复: Agent 暴露完整 7 action (list/insert/update/delete/batch_delete/
 * clear/bulk_generate),system-prompt 加硬规则禁止 clear+insert 兜底。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { ensureUserModule, waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => {
  await waitForBackend();
  await ensureUserModule();
});

function fakeRunner(sessionId: string) {
  return { sessionId } as any;
}

function newSession(): string {
  const id = randomUUID();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
    ).run(id, '[MD-AGT-TEST]', 1);
    return id;
  } finally { db.close(); }
}
function deleteSession(id: string) {
  const db = new Database(DB_PATH);
  try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id); } finally { db.close(); }
}

test.describe('Agent manage_data 完整 action (Step-Observability-1.4)', () => {
  test('MD-AGT01 action enum 包含所有 7 个 (回归之前缺 update/list/batch_delete)', async () => {
    // 读源文件字符串验证 enum,避免依赖 AI SDK schema introspection 形态
    const { readFile } = await import('fs/promises');
    const { resolve: r } = await import('path');
    const src = await readFile(r(process.cwd(), 'src/server/agent/tool-registry.ts'), 'utf-8');
    // 抓取 manage_data 的 z.enum([...]) 这一行
    const m = src.match(/manage_data:[\s\S]+?action:\s*z\.enum\(\[([^\]]+)\]\)/);
    expect(m).not.toBeNull();
    const enumStr = m![1];
    for (const v of ['list', 'insert', 'update', 'delete', 'batch_delete', 'clear', 'bulk_generate']) {
      expect(enumStr).toContain(`'${v}'`);
    }
  });

  test('MD-AGT02 list 通过 Agent 工具正常返回分页结果', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = newSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));
      const result = await (tools as any).manage_data.execute(
        { action: 'list', moduleName: 'user', page: 1, pageSize: 5 },
        { toolCallId: 'l1', messages: [] },
      );
      expect(result).toBeTruthy();
      // BaseModel.findAll 返回 { list, total, page, pageSize }
      expect(Array.isArray(result.list)).toBe(true);
      expect(typeof result.total).toBe('number');
    } finally { deleteSession(sid); }
  });

  test('MD-AGT03 update 通过 Agent 工具正确 patch 单字段', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = newSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));
      // 先 insert 一条用作 fixture
      const insertRes = await (tools as any).manage_data.execute(
        { action: 'insert', moduleName: 'user', data: { username: `agt03_${Date.now()}`, email: `agt03${Date.now()}@x.com`, password: 'pw' } },
        { toolCallId: 'i', messages: [] },
      );
      const id = insertRes.id as number;
      expect(typeof id).toBe('number');

      // 再用 update 改 role — partial patch (其他必填字段 username/email/password 应保留)
      const updateRes = await (tools as any).manage_data.execute(
        { action: 'update', moduleName: 'user', id, data: { role: 'admin' } },
        { toolCallId: 'u', messages: [] },
      );
      expect(updateRes).toBeTruthy();
      expect(updateRes.role).toBe('admin');
      // 其他必填字段保留
      expect(updateRes.email).toContain('@x.com');

      // 清理
      await (tools as any).manage_data.execute(
        { action: 'delete', moduleName: 'user', id },
        { toolCallId: 'd', messages: [] },
      );
    } finally { deleteSession(sid); }
  });

  test('MD-AGT04 batch_delete 通过 Agent 工具删除多条', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = newSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));
      const created: number[] = [];
      const ts = Date.now();
      for (let i = 0; i < 3; i++) {
        const r = await (tools as any).manage_data.execute(
          { action: 'insert', moduleName: 'user', data: { username: `agt04_${ts}_${i}`, email: `agt04_${ts}_${i}@x.com`, password: 'pw' } },
          { toolCallId: `i${i}`, messages: [] },
        );
        created.push(r.id as number);
      }

      const result = await (tools as any).manage_data.execute(
        { action: 'batch_delete', moduleName: 'user', ids: created },
        { toolCallId: 'bd', messages: [] },
      );
      expect(result.deleted).toBe(3);
    } finally { deleteSession(sid); }
  });
});

test.describe('system-prompt 数据修改硬规则 (Step-Observability-1.4)', () => {
  test('MD-AGT05 system-prompt 必须含"先 list 拿 id 再 update"的硬规则', async () => {
    const { buildSystemPrompt } = await import('../src/server/agent/system-prompt.js');
    const prompt = buildSystemPrompt({ userId: 1, moduleList: [] });
    // 关键约束词必须出现 (原"硬规则"压缩成了"铁律",意思一样)
    expect(prompt).toContain('数据修改铁律');
    expect(prompt).toContain('list 拿 id');
    expect(prompt).toContain('禁'); // "禁用" or "禁止" 都行
    // manage_data 工具说明已更新到 7 action
    expect(prompt).toContain('list/insert/**update**/delete/batch_delete/clear/bulk_generate');
  });

  test('MD-AGT06 system-prompt 明确禁止 clear+insert / clear+bulk_generate 兜底', async () => {
    const { buildSystemPrompt } = await import('../src/server/agent/system-prompt.js');
    const prompt = buildSystemPrompt({ userId: 1, moduleList: [] });
    expect(prompt).toContain('clear');
    expect(prompt).toContain('原地修改');
    // 严重错误措辞,让 LLM 把这条当硬规则看
    expect(prompt.toLowerCase()).toContain('严重错误');
  });
});
