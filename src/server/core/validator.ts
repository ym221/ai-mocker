/**
 * 字段 + 跨字段约束校验 (供 BaseModel.withMeta 自动调用)。
 *
 * 设计原则:
 *  - 静默忽略未定义的约束(向后兼容老 _meta.json — 没 enum/min 就不检查)
 *  - 失败抛 ValidationError(message 中文,带字段名),controller 转 4xx
 *  - 跨字段规则(entity.constraints)在所有单字段校验之后再跑,避免双重报错
 *  - 'create' vs 'update' 两种上下文:
 *    * create: required 字段缺失 → 报错;default 自动填充
 *    * update: 未传字段不报 required(部分更新);仅校验已传字段
 */

import type { MetaEntity, MetaField, FieldCondition, EntityConstraint } from './meta-schema.js';

export class ValidationError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** 把 boolean 归一化为 SQLite 兼容的 0/1,与 BaseModel.normalizeBindValue 对齐。 */
function coerce(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function fieldDisplayName(f: MetaField): string {
  return f.displayName || f.name;
}

/** 单字段校验:enum / pattern / min / max / minLength / maxLength。 */
function validateOneField(field: MetaField, raw: unknown, ctx: 'create' | 'update'): void {
  const value = coerce(raw);

  // null / undefined: 仅在 create + required 时报错(update 允许部分更新)
  if (value === null || value === undefined) {
    if (ctx === 'create' && field.required) {
      throw new ValidationError(`${fieldDisplayName(field)}是必填项`, field.name);
    }
    return;
  }

  // enum
  if (Array.isArray(field.enum) && field.enum.length > 0) {
    if (!field.enum.includes(value as string | number)) {
      throw new ValidationError(
        `${fieldDisplayName(field)}的值必须是: ${field.enum.join(' / ')}(收到: ${String(value)})`,
        field.name,
      );
    }
  }

  // pattern (string only)
  if (typeof field.pattern === 'string' && typeof value === 'string') {
    let re: RegExp;
    try { re = new RegExp(field.pattern); }
    catch { return; /* invalid pattern in meta — skip silently */ }
    if (!re.test(value)) {
      throw new ValidationError(
        `${fieldDisplayName(field)}格式不正确(应满足 ${field.pattern})`,
        field.name,
      );
    }
  }

  // length (string only)
  if (typeof value === 'string') {
    if (typeof field.minLength === 'number' && value.length < field.minLength) {
      throw new ValidationError(
        `${fieldDisplayName(field)}长度不能小于 ${field.minLength}`,
        field.name,
      );
    }
    if (typeof field.maxLength === 'number' && value.length > field.maxLength) {
      throw new ValidationError(
        `${fieldDisplayName(field)}长度不能大于 ${field.maxLength}`,
        field.name,
      );
    }
  }

  // min / max (numbers)
  if (typeof value === 'number') {
    if (typeof field.min === 'number' && value < field.min) {
      throw new ValidationError(
        `${fieldDisplayName(field)}不能小于 ${field.min}`,
        field.name,
      );
    }
    if (typeof field.max === 'number' && value > field.max) {
      throw new ValidationError(
        `${fieldDisplayName(field)}不能大于 ${field.max}`,
        field.name,
      );
    }
  }
}

/** 求一个 FieldCondition 是否与 actual 匹配。 */
export function matchCondition(actual: unknown, cond: FieldCondition): boolean {
  const a = coerce(actual);

  // 字面量(string/number/boolean/null)
  if (cond === null || typeof cond !== 'object') {
    return a === coerce(cond);
  }

  const c = cond as Exclude<FieldCondition, string | number | boolean | null>;
  if (c.eq !== undefined && a !== coerce(c.eq)) return false;
  if (c.neq !== undefined && a === coerce(c.neq)) return false;
  if (c.gt !== undefined && !(typeof a === 'number' && a > Number(c.gt))) return false;
  if (c.gte !== undefined && !(typeof a === 'number' && a >= Number(c.gte))) return false;
  if (c.lt !== undefined && !(typeof a === 'number' && a < Number(c.lt))) return false;
  if (c.lte !== undefined && !(typeof a === 'number' && a <= Number(c.lte))) return false;
  if (Array.isArray(c.in) && !c.in.some(v => coerce(v) === a)) return false;
  return true;
}

/** 跨字段规则: 当所有 when 条件命中,则所有 must 必须命中。 */
function matchesWhen(record: Record<string, unknown>, when: Record<string, FieldCondition>): boolean {
  for (const [field, cond] of Object.entries(when)) {
    if (!matchCondition(record[field], cond)) return false;
  }
  return true;
}

function violatesMust(record: Record<string, unknown>, must: Record<string, FieldCondition>): string | null {
  for (const [field, cond] of Object.entries(must)) {
    if (!matchCondition(record[field], cond)) return field;
  }
  return null;
}

function checkConstraints(record: Record<string, unknown>, constraints: EntityConstraint[]): void {
  for (const c of constraints) {
    if (matchesWhen(record, c.when)) {
      const violated = violatesMust(record, c.must);
      if (violated) {
        throw new ValidationError(c.message, violated);
      }
    }
  }
}

/**
 * 校验入口。 'create' 上下文走完整校验(含 required 检查 + 跨字段检查); 'update'
 * 上下文 *预先与现有行合并* 后再做跨字段检查,这样 PUT/PATCH 部分更新也能正确触发约束。
 */
export interface ValidateOptions {
  context: 'create' | 'update';
  /** update 时传入数据库当前行,与 data 合并后再校验。 */
  existingRow?: Record<string, unknown> | null;
}

export function validate(
  entity: MetaEntity,
  data: Record<string, unknown>,
  opts: ValidateOptions,
): void {
  const fields = entity.fields || [];

  // 1) 单字段
  for (const f of fields) {
    if (opts.context === 'create' || f.name in data) {
      validateOneField(f, data[f.name], opts.context);
    }
  }

  // 2) 跨字段(constraints)
  if (entity.constraints && entity.constraints.length > 0) {
    const merged = opts.context === 'update' && opts.existingRow
      ? { ...opts.existingRow, ...data }
      : data;
    checkConstraints(merged, entity.constraints);
  }
}
