/**
 * validator unit tests + BaseModel auto-validate 集成。
 */
import { test, expect } from '@playwright/test';
import { validate, ValidationError, matchCondition } from '../src/server/core/validator';
import type { MetaEntity } from '../src/server/core/meta-schema';

test.describe('validator: 单字段约束', () => {
  test('V01 enum: 不在列表里 → ValidationError', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'status', type: 'string', enum: ['a', 'b', 'c'] }],
    };
    expect(() => validate(e, { status: 'd' }, { context: 'create' }))
      .toThrow(/status的值必须是.*a \/ b \/ c/);
  });

  test('V02 enum: 在列表里 → 通过', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'status', type: 'string', enum: ['a', 'b'] }],
    };
    expect(() => validate(e, { status: 'a' }, { context: 'create' })).not.toThrow();
  });

  test('V03 required: create 缺字段 → 报错', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'sku', type: 'string', required: true, displayName: 'SKU' }],
    };
    expect(() => validate(e, {}, { context: 'create' })).toThrow(/SKU是必填项/);
  });

  test('V04 required: update 缺字段 → 不报错(部分更新)', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'sku', type: 'string', required: true }],
    };
    expect(() => validate(e, { other: 1 } as any, { context: 'update' })).not.toThrow();
  });

  test('V05 min/max: 数值越界 → 报错', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'qty', type: 'integer', min: 0, max: 100 }],
    };
    expect(() => validate(e, { qty: -1 }, { context: 'create' })).toThrow(/qty不能小于 0/);
    expect(() => validate(e, { qty: 101 }, { context: 'create' })).toThrow(/qty不能大于 100/);
    expect(() => validate(e, { qty: 50 }, { context: 'create' })).not.toThrow();
  });

  test('V06 pattern: 字符串不匹配 → 报错', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'sku', type: 'string', pattern: '^[A-Z]{3}$' }],
    };
    expect(() => validate(e, { sku: 'abc' }, { context: 'create' })).toThrow(/格式不正确/);
    expect(() => validate(e, { sku: 'ABC' }, { context: 'create' })).not.toThrow();
  });

  test('V07 minLength/maxLength: 字符串长度越界', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 's', type: 'string', minLength: 3, maxLength: 5 }],
    };
    expect(() => validate(e, { s: 'ab' }, { context: 'create' })).toThrow(/长度不能小于 3/);
    expect(() => validate(e, { s: 'abcdef' }, { context: 'create' })).toThrow(/长度不能大于 5/);
    expect(() => validate(e, { s: 'abcd' }, { context: 'create' })).not.toThrow();
  });

  test('V08 null/undefined 在 create 非 required 时 → 通过', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'note', type: 'string', enum: ['a', 'b'] }],
    };
    expect(() => validate(e, { note: null }, { context: 'create' })).not.toThrow();
    expect(() => validate(e, {}, { context: 'create' })).not.toThrow();
  });
});

test.describe('validator: 跨字段规则', () => {
  test('V09 跨字段: when 命中且 must 不命中 → 报错', () => {
    const e: MetaEntity = {
      name: 'x',
      fields: [
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string', enum: ['a', 'b', 'out_of_stock'] },
      ],
      constraints: [{
        when: { qty: 0 },
        must: { status: 'out_of_stock' },
        message: '数量为 0 时必须 out_of_stock',
      }],
    };
    expect(() => validate(e, { qty: 0, status: 'a' }, { context: 'create' }))
      .toThrow(/数量为 0 时必须 out_of_stock/);
  });

  test('V10 跨字段: when 命中且 must 命中 → 通过', () => {
    const e: MetaEntity = {
      name: 'x',
      fields: [
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string', enum: ['a', 'out_of_stock'] },
      ],
      constraints: [{
        when: { qty: 0 },
        must: { status: 'out_of_stock' },
        message: '...',
      }],
    };
    expect(() => validate(e, { qty: 0, status: 'out_of_stock' }, { context: 'create' })).not.toThrow();
  });

  test('V11 跨字段: when 不命中 → 任意 must 都不检查', () => {
    const e: MetaEntity = {
      name: 'x',
      fields: [
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string' },
      ],
      constraints: [{
        when: { qty: 0 },
        must: { status: 'out_of_stock' },
        message: '...',
      }],
    };
    expect(() => validate(e, { qty: 5, status: 'whatever' }, { context: 'create' })).not.toThrow();
  });

  test('V12 跨字段在 update 时与 existingRow 合并校验 (PATCH 语义)', () => {
    const e: MetaEntity = {
      name: 'x',
      fields: [
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string' },
      ],
      constraints: [{
        when: { qty: 0 },
        must: { status: 'out_of_stock' },
        message: '数量为 0 时必须 out_of_stock',
      }],
    };
    // 现有行 status=in_stock; PATCH 把 qty 改为 0,合并后应触发约束
    expect(() => validate(e, { qty: 0 }, {
      context: 'update', existingRow: { qty: 5, status: 'in_stock' },
    })).toThrow(/数量为 0 时必须 out_of_stock/);
    // 但同时把 status 改为 out_of_stock → 通过
    expect(() => validate(e, { qty: 0, status: 'out_of_stock' }, {
      context: 'update', existingRow: { qty: 5, status: 'in_stock' },
    })).not.toThrow();
  });

  test('V13 范围条件 (gt/lte) 在 when 里能正确匹配', () => {
    const e: MetaEntity = {
      name: 'x',
      fields: [
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string', enum: ['low_stock', 'in_stock'] },
      ],
      constraints: [{
        when: { qty: { gt: 0, lte: 10 } },
        must: { status: 'low_stock' },
        message: '数量 (0,10] 时必须 low_stock',
      }],
    };
    expect(() => validate(e, { qty: 5, status: 'in_stock' }, { context: 'create' }))
      .toThrow(/数量 \(0,10\] 时必须 low_stock/);
    expect(() => validate(e, { qty: 5, status: 'low_stock' }, { context: 'create' })).not.toThrow();
    expect(() => validate(e, { qty: 11, status: 'in_stock' }, { context: 'create' })).not.toThrow();
    expect(() => validate(e, { qty: 0, status: 'in_stock' }, { context: 'create' })).not.toThrow();
  });
});

test.describe('matchCondition 工具', () => {
  test('V14 字面量等值', () => {
    expect(matchCondition('a', 'a')).toBe(true);
    expect(matchCondition('a', 'b')).toBe(false);
    expect(matchCondition(0, 0)).toBe(true);
  });

  test('V15 范围 + in', () => {
    expect(matchCondition(5, { gt: 0, lt: 10 })).toBe(true);
    expect(matchCondition(10, { gt: 0, lt: 10 })).toBe(false);
    expect(matchCondition('a', { in: ['a', 'b'] })).toBe(true);
    expect(matchCondition('c', { in: ['a', 'b'] })).toBe(false);
  });
});

test.describe('ValidationError 暴露 .field', () => {
  test('V16 错误对象带 field name 便于 controller 路由错误', () => {
    const e: MetaEntity = {
      name: 'x', fields: [{ name: 'status', type: 'string', enum: ['a'] }],
    };
    try {
      validate(e, { status: 'z' }, { context: 'create' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('status');
    }
  });
});
