/**
 * meta-schema 类型 + 归一化测试。
 *
 * 关键: 旧 _meta.json (用 enumValues / defaultValue) 和新 _meta.json
 * (用 enum / default) 都能被正确解析,新代码统一读 enum/default。
 */
import { test, expect } from '@playwright/test';
import { normalizeField, normalizeEntity, normalizeMeta } from '../src/server/core/meta-schema';

test.describe('meta-schema 归一化', () => {
  test('MS01 enumValues → enum (旧别名兼容)', () => {
    const f = normalizeField({
      name: 'status', type: 'string',
      enumValues: ['a', 'b', 'c'],
    });
    expect(f.enum).toEqual(['a', 'b', 'c']);
  });

  test('MS02 defaultValue → default (旧别名兼容)', () => {
    const f = normalizeField({
      name: 'status', type: 'string', defaultValue: 'active',
    });
    expect(f.default).toBe('active');
  });

  test('MS03 显式 enum 优先于 enumValues', () => {
    const f = normalizeField({
      name: 'status', type: 'string',
      enum: ['x', 'y'],
      enumValues: ['old1', 'old2'],
    });
    expect(f.enum).toEqual(['x', 'y']);
  });

  test('MS04 字段约束完整传递 (min/max/pattern/unique)', () => {
    const f = normalizeField({
      name: 'sku', type: 'string',
      pattern: '^[A-Z0-9-]{3,32}$',
      minLength: 3,
      maxLength: 32,
      unique: true,
    });
    expect(f.pattern).toBe('^[A-Z0-9-]{3,32}$');
    expect(f.minLength).toBe(3);
    expect(f.maxLength).toBe(32);
    expect(f.unique).toBe(true);
  });

  test('MS05 数值约束 min/max 传递', () => {
    const f = normalizeField({
      name: 'quantity', type: 'integer', min: 0, max: 1000000,
    });
    expect(f.min).toBe(0);
    expect(f.max).toBe(1000000);
  });

  test('MS06 entity.constraints 默认空数组', () => {
    const e = normalizeEntity({ name: 'x', fields: [] });
    expect(e.constraints).toEqual([]);
  });

  test('MS07 entity.constraints 完整传递', () => {
    const e = normalizeEntity({
      name: 'warehouse_item',
      fields: [],
      constraints: [
        {
          id: 'qty-zero',
          when: { quantity: 0 },
          must: { status: 'out_of_stock' },
          message: '数量为 0 时必须 out_of_stock',
        },
      ],
    });
    expect(e.constraints).toHaveLength(1);
    expect(e.constraints![0].id).toBe('qty-zero');
    expect(e.constraints![0].when.quantity).toBe(0);
    expect(e.constraints![0].must.status).toBe('out_of_stock');
  });

  test('MS08 normalizeMeta 递归处理所有 entities', () => {
    const m = normalizeMeta({
      name: 'mod',
      entities: [
        {
          name: 'a',
          fields: [
            { name: 'f1', type: 'string', enumValues: ['x'] },
            { name: 'f2', type: 'integer', defaultValue: 0 },
          ],
        },
      ],
    });
    const fields = m.entities![0].fields!;
    expect(fields[0].enum).toEqual(['x']);
    expect(fields[1].default).toBe(0);
  });

  test('MS09 范围条件 (gt/lte) 在 EntityConstraint.when 里能传递', () => {
    const e = normalizeEntity({
      name: 'x',
      constraints: [
        { when: { quantity: { gt: 0, lte: 10 } }, must: { status: 'low_stock' }, message: 'low' },
      ],
    });
    const cond = e.constraints![0].when.quantity as Record<string, unknown>;
    expect(cond.gt).toBe(0);
    expect(cond.lte).toBe(10);
  });
});
