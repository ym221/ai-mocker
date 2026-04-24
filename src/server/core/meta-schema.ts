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
  /** Step-Fix-1.1: explicit handler name for multi-entity dispatch. */
  controller?: string;
}

export interface ModuleMeta {
  name?: string;
  displayName?: string;
  description?: string;
  version?: number | string;
  basePath?: string;
  status?: string;
  /**
   * Canonical entity list. New code SHOULD read via `getEntities(meta)` which also
   * folds in legacy top-level `entity` (single-entity historical schema).
   */
  entities?: MetaEntity[];
  /**
   * Legacy: some AI outputs put the primary entity here and additional ones in
   * `entities[]`. `getEntities()` merges both. Do NOT emit this field in new code.
   */
  entity?: MetaEntity;
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

/**
 * Canonical read for the entity list.
 *
 * Folds the legacy top-level `entity` field into the list so downstream code
 * (openapi-export, manage_data, module-health, run-test, delete-module,
 * update-diff, handoff-report, BaseModel) no longer needs to know about the
 * split. The legacy entity is prepended as primary when present and not a dup.
 *
 * Normalizes every entity (enumValues → enum, defaultValue → default).
 */
export function getEntities(meta: ModuleMeta | null | undefined): MetaEntity[] {
  if (!meta) return [];
  const out = (meta.entities || []).map(normalizeEntity);
  const legacy = meta.entity;
  if (legacy && typeof legacy.name === 'string' && legacy.name.length > 0) {
    const dup = out.some(e => e.name === legacy.name);
    if (!dup) out.unshift(normalizeEntity(legacy));
  }
  return out;
}

/** First entity (legacy-compat primary). Null if module has no entities. */
export function getPrimaryEntity(meta: ModuleMeta | null | undefined): MetaEntity | null {
  return getEntities(meta)[0] || null;
}

/** Stored bare tableName of the primary entity (pre-userId-injection). */
export function getPrimaryTableName(meta: ModuleMeta | null | undefined): string | null {
  const e = getPrimaryEntity(meta);
  return (e && typeof e.tableName === 'string' && e.tableName.length > 0) ? e.tableName : null;
}

/**
 * Pair an endpoint to its owning entity. Used by openapi-export to pick the
 * right `$ref` schema per endpoint (multi-entity modules need per-endpoint
 * entity resolution, not one-size-fits-all firstEntity).
 *
 * Priority:
 *   1) endpoint.entity (explicit, future-proof)
 *   2) endpoint.controller name — strip verb prefix / ById suffix, match entity.name
 *   3) endpoint.path segments — match literal segment or trailing-s-singularized
 *   4) fallback: primary entity
 */
export function pickEntityForEndpoint(
  ep: MetaEndpoint & { entity?: string },
  entities: MetaEntity[]
): MetaEntity | null {
  if (!entities.length) return null;

  // 1) explicit `entity` reference on the endpoint
  if (ep.entity) {
    const hit = entities.find(e => e.name === ep.entity);
    if (hit) return hit;
  }

  // 2) controller name heuristic:  listWarehouses / getItemById / createInventory → Warehouse / Item / Inventory
  if (ep.controller) {
    const stripped = ep.controller
      .replace(/^(list|get|create|update|remove|delete)/i, '')
      .replace(/ById$/i, '')
      .replace(/s$/i, '');
    if (stripped) {
      const hit = entities.find(e => e.name.toLowerCase() === stripped.toLowerCase());
      if (hit) return hit;
    }
  }

  // 3) path segment heuristic: /items → Item, /inventory → Inventory, /warehouses → Warehouse
  if (ep.path) {
    const segs = ep.path.split('/').filter(Boolean).filter(s => !s.startsWith(':') && !s.startsWith('{'));
    for (const seg of segs) {
      const lc = seg.toLowerCase();
      const singular = lc.replace(/s$/, '');
      const hit = entities.find(e => {
        const n = e.name.toLowerCase();
        return n === lc || n === singular;
      });
      if (hit) return hit;
    }
  }

  // 4) fallback
  return entities[0];
}
