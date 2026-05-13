/**
 * tool-registry 复合参数 preprocess 单元测试 — Step-Loosen-3。
 *
 * 验证修复: LLM 经常把 array/object 整个 JSON.stringify 后传过来,严格 zod
 * 会拒绝触发反复 retry。这里直接构造和 tool-registry 同款的 zod schema 验
 * 证 preprocess 行为,不需要起 LLM 真实通路。
 */
import { test, expect } from '@playwright/test';
import { z } from 'zod';

function parseIfStringified(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  return val;
}

// 跟 src/server/agent/tool-registry.ts 的 write_files.parameters 一致
const writeFilesSchema = z.object({
  files: z.preprocess(
    parseIfStringified,
    z.array(z.object({
      path: z.string(),
      content: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    })).min(1),
  ),
});

// 跟 manage_data.parameters 一致(精简)
const manageDataSchema = z.object({
  action: z.enum(['list', 'insert', 'update', 'delete', 'batch_delete', 'clear', 'bulk_generate']),
  data: z.preprocess(parseIfStringified, z.record(z.string(), z.unknown()).optional()),
  ids: z.preprocess(parseIfStringified, z.array(z.number()).optional()),
  where: z.preprocess(parseIfStringified, z.record(z.string(), z.unknown()).optional()),
});

test.describe('tool args preprocess (Step-Loosen-3)', () => {
  test('PP01 write_files.files 接 stringified JSON array (LLM 实测反模式)', () => {
    const r = writeFilesSchema.safeParse({
      files: '[{"path":"tm_reconcile/_meta.json","content":{"name":"tm_reconcile"}}]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Array.isArray(r.data.files)).toBe(true);
      expect(r.data.files[0].path).toBe('tm_reconcile/_meta.json');
      expect((r.data.files[0].content as any).name).toBe('tm_reconcile');
    }
  });

  test('PP02 write_files.files 接真实 array (回归)', () => {
    const r = writeFilesSchema.safeParse({
      files: [{ path: 'a.txt', content: 'hello' }],
    });
    expect(r.success).toBe(true);
  });

  test('PP03 write_files.files[i].content 接 object (#12 + Step-Loosen-3)', () => {
    const r = writeFilesSchema.safeParse({
      files: [{ path: 'a.json', content: { nested: { x: 1, y: [2, 3] } } }],
    });
    expect(r.success).toBe(true);
  });

  test('PP04 write_files.files 字符串非合法 JSON → 仍触发 zod 报错', () => {
    const r = writeFilesSchema.safeParse({ files: 'not valid json at all' });
    expect(r.success).toBe(false);
  });

  test('PP05 manage_data.data 接 stringified object', () => {
    const r = manageDataSchema.safeParse({
      action: 'insert',
      data: '{"name":"Alice","age":30}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.data as any)?.name).toBe('Alice');
      expect((r.data.data as any)?.age).toBe(30);
    }
  });

  test('PP06 manage_data.where 接 stringified object', () => {
    const r = manageDataSchema.safeParse({
      action: 'list',
      where: '{"status":"active"}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.where as any)?.status).toBe('active');
    }
  });

  test('PP07 manage_data.ids 接 stringified array', () => {
    const r = manageDataSchema.safeParse({
      action: 'batch_delete',
      ids: '[1,2,3]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ids).toEqual([1, 2, 3]);
    }
  });

  test('PP08 manage_data optional 字段不传仍能解析', () => {
    const r = manageDataSchema.safeParse({ action: 'clear' });
    expect(r.success).toBe(true);
  });
});
