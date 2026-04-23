/**
 * _meta.json 的规范类型定义 + 归一化解析。
 *
 * Step-MCP-4 起,字段层加 enum/min/max/pattern/unique/description/default
 * 等约束;实体层加 constraints[] 表达跨字段规则。所有约束都在以下三处使用:
 *   1) openapi-export.ts → 映射到 OpenAPI schema
 *   2) BaseModel.withMeta → 自动校验
 *   3) diff_with_openapi → 检测 actual 违反
 *
 * 兼容:旧 `enumValues` 字段被识别为 `enum` 的别名。
 */

/** 单值比较条件:可以是字面值,也可以是 { eq, neq, gt, gte, lt, lte, in } 对象。 */
export type FieldCondition =
  | string | number | boolean | null
  | {
    eq?: string | number | boolean | null;
    neq?: string | number | boolean | null;
    gt?: number | string;
    gte?: number | string;
    lt?: number | string;
    lte?: number | string;
    in?: Array<string | number>;
  };

/** 跨字段规则: 当 `when` 全部命中,则 `must` 必须全部命中,否则报 message。 */
export interface EntityConstraint {
  /** 可选稳定 id,便于 diff (`+constraint qty-zero`) */
  id?: string;
  when: Record<string, FieldCondition>;
  must: Record<string, FieldCondition>;
  message: string;
}

/** 字段级约束 + 元信息。 */
export interface MetaField {
  name: string;
  type?: string;            // string/text/integer/int/number/decimal/float/boolean/date/datetime/enum
  displayName?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  defaultValue?: unknown;   // 旧别名

  // 字符串约束
  enum?: Array<string | number>;
  enumValues?: Array<string | number>;  // 旧别名
  pattern?: string;
  minLength?: number;
  maxLength?: number;

  // 数值约束
  min?: number;
  max?: number;

  // 唯一性
  unique?: boolean;
}

export interface MetaEntity {
  name: string;
  tableName?: string;
  displayName?: string;
  fields?: MetaField[];
  constraints?: EntityConstraint[];
}

export interface MetaEndpoint {
  name?: string;
  type?: string;
  method?: string;
  path?: string;
  handler?: string;
}

export interface ModuleMeta {
  name?: string;
  displayName?: string;
  description?: string;
  version?: number | string;
  basePath?: string;
  status?: string;
  entities?: MetaEntity[];
  endpoints?: MetaEndpoint[];
  config?: Record<string, unknown>;
}

/**
 * 把字段定义归一化:把旧别名(enumValues, defaultValue)转成新名字(enum, default)。
 * 保留旧字段(以免外部 reader 还在读),但新代码读 `enum` / `default` 即可。
 */
export function normalizeField(f: MetaField): MetaField {
  const out: MetaField = { ...f };
  if (out.enum == null && Array.isArray(out.enumValues)) {
    out.enum = out.enumValues;
  }
  if (out.default === undefined && out.defaultValue !== undefined) {
    out.default = out.defaultValue;
  }
  return out;
}

export function normalizeEntity(e: MetaEntity): MetaEntity {
  return {
    ...e,
    fields: (e.fields || []).map(normalizeField),
    constraints: e.constraints || [],
  };
}

export function normalizeMeta(m: ModuleMeta): ModuleMeta {
  return {
    ...m,
    entities: (m.entities || []).map(normalizeEntity),
  };
}
