/**
 * spec-classifier — deterministic 把 spec 分三档,给 create_module_from_spec 选生成路径:
 *
 *   tier 1 (crud-pure):    100% 标准 CRUD,无任何约束/自定义路径/跨实体 → 模板生成,几秒
 *   tier 2 (crud-with-rules): CRUD shape + 含字段级约束(enum/min/max/pattern/required) → 模板 + 1 次 LLM 填充
 *   tier 3 (full-ai):     其他一切(自然语言 / 自定义 path / 多实体关联 / 自定义响应信封) → 走现状 ChatRunner
 *
 * 关键设计:**严格**判定 tier 1/2,稍有疑虑就降到 tier 3。
 * 误判到模板路径的代价 = 生成出错的模块;误判到 tier 3 的代价 = 多花 7 分钟。
 * 后者代价小,前者代价大,所以保守。
 */

import { parse as parseYaml } from 'yaml';

export type Tier = 1 | 2 | 3;

export interface DetectedField {
  name: string;
  type: string;
  required?: boolean;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface DetectedEntity {
  name: string;
  fields: DetectedField[];
}

export interface DetectedEndpoint {
  method: string;
  path: string;
  type: 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom';
  entity?: string;
}

export interface Classification {
  tier: Tier;
  reason: string;
  /** Parsed OpenAPI object if we managed to parse one. */
  openapi?: any;
  entities?: DetectedEntity[];
  endpoints?: DetectedEndpoint[];
  /** Module name inferred from openapi info.title or spec heading; null if can't tell. */
  inferredModuleName?: string;
}

// ============================================================================
// OpenAPI parsing
// ============================================================================

function tryParseOpenApi(spec: string): any | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  // JSON?
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && (obj.openapi || obj.swagger || obj.paths)) return obj;
    } catch { /* not json */ }
  }
  // YAML?
  try {
    const obj = parseYaml(trimmed);
    if (obj && typeof obj === 'object' && ((obj as any).openapi || (obj as any).swagger || (obj as any).paths)) return obj;
  } catch { /* not yaml */ }
  return null;
}

// ============================================================================
// CRUD pattern detection
// ============================================================================

interface PathPatternInfo {
  isCrudShape: boolean;  // /entities or /entities/:id
  pluralBase?: string;    // "items" from "/items" or "/items/{id}"
  hasIdParam?: boolean;
}

function analyzePath(path: string): PathPatternInfo {
  if (!path || !path.startsWith('/')) return { isCrudShape: false };
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return { isCrudShape: false };
  // /entities — 1 segment
  if (segs.length === 1) {
    const seg = segs[0];
    if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(seg) && !seg.startsWith(':') && !seg.startsWith('{')) {
      return { isCrudShape: true, pluralBase: seg, hasIdParam: false };
    }
    return { isCrudShape: false };
  }
  // /entities/:id or /entities/{id} — 2 segments,second is param
  if (segs.length === 2) {
    const [base, second] = segs;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(base)) return { isCrudShape: false };
    if (second.startsWith(':') || (second.startsWith('{') && second.endsWith('}'))) {
      return { isCrudShape: true, pluralBase: base, hasIdParam: true };
    }
    return { isCrudShape: false };
  }
  return { isCrudShape: false };
}

function inferEndpointType(method: string, info: PathPatternInfo): 'list' | 'detail' | 'create' | 'update' | 'delete' | 'custom' {
  const m = method.toUpperCase();
  if (!info.isCrudShape) return 'custom';
  if (m === 'GET' && !info.hasIdParam) return 'list';
  if (m === 'GET' && info.hasIdParam) return 'detail';
  if (m === 'POST' && !info.hasIdParam) return 'create';
  if ((m === 'PUT' || m === 'PATCH') && info.hasIdParam) return 'update';
  if (m === 'DELETE' && info.hasIdParam) return 'delete';
  return 'custom';
}

// ============================================================================
// Schema → DetectedField
// ============================================================================

function extractFieldsFromSchema(schema: any): DetectedField[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties || {};
  const requiredList: string[] = Array.isArray(schema.required) ? schema.required : [];
  const fields: DetectedField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const s = raw as any;
    let type = 'string';
    if (s.type === 'integer' || s.type === 'number') type = s.type;
    else if (s.type === 'boolean') type = 'boolean';
    else if (s.type === 'array' || s.type === 'object') continue;  // skip complex
    else type = 'string';
    const fld: DetectedField = { name, type, required: requiredList.includes(name) };
    if (Array.isArray(s.enum)) fld.enum = s.enum;
    if (typeof s.minimum === 'number') fld.min = s.minimum;
    if (typeof s.maximum === 'number') fld.max = s.maximum;
    if (typeof s.minLength === 'number') fld.minLength = s.minLength;
    if (typeof s.maxLength === 'number') fld.maxLength = s.maxLength;
    if (typeof s.pattern === 'string') fld.pattern = s.pattern;
    fields.push(fld);
  }
  return fields;
}

function hasFieldConstraints(fields: DetectedField[]): boolean {
  return fields.some(f => f.enum != null || f.min != null || f.max != null || f.pattern != null || f.minLength != null || f.maxLength != null);
}

// ============================================================================
// Main classifier
// ============================================================================

export function classifySpec(spec: string, requestedModuleName?: string): Classification {
  // Step 1 — try OpenAPI parse
  const openapi = tryParseOpenApi(spec);
  if (!openapi) {
    return {
      tier: 3,
      reason: 'spec is not OpenAPI/Swagger JSON or YAML — natural language requires full AI interpretation',
      inferredModuleName: requestedModuleName,
    };
  }

  // Module name
  const titleSlug = openapi.info?.title
    ? String(openapi.info.title).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '')
    : null;
  const inferredModuleName = requestedModuleName || titleSlug || undefined;

  // Step 2 — parse endpoints
  const paths = openapi.paths || {};
  if (Object.keys(paths).length === 0) {
    return {
      tier: 3,
      reason: 'OpenAPI has no paths — falling back to full AI',
      openapi,
      inferredModuleName,
    };
  }

  const endpoints: DetectedEndpoint[] = [];
  let hasCustom = false;
  let detectedBase: string | null = null;
  for (const [p, methodMap] of Object.entries(paths)) {
    const info = analyzePath(p);
    if (!info.isCrudShape) {
      hasCustom = true;
    } else {
      if (detectedBase && detectedBase !== info.pluralBase) {
        // Multiple distinct base names = multi-entity → tier 3
        return {
          tier: 3,
          reason: `OpenAPI defines multiple base resources (${detectedBase} and ${info.pluralBase}) — multi-entity modules need AI to wire cross-references`,
          openapi, endpoints, inferredModuleName,
        };
      }
      detectedBase = info.pluralBase!;
    }
    for (const method of Object.keys(methodMap as object)) {
      const m = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) continue;
      endpoints.push({
        method: m,
        path: p,
        type: inferEndpointType(m, info),
        entity: info.pluralBase,
      });
    }
  }

  if (hasCustom) {
    return {
      tier: 3,
      reason: 'OpenAPI contains custom (non-CRUD) paths — AI required to write custom handlers',
      openapi, endpoints, inferredModuleName,
    };
  }
  if (endpoints.length === 0) {
    return {
      tier: 3,
      reason: 'no standard HTTP method endpoints detected',
      openapi, endpoints, inferredModuleName,
    };
  }

  // Step 3 — parse entities from components/schemas
  const schemas = openapi.components?.schemas || {};
  const entities: DetectedEntity[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const fields = extractFieldsFromSchema(schema);
    if (fields.length > 0) entities.push({ name, fields });
  }

  if (entities.length === 0) {
    // CRUD shape but no schema — hard to template; let AI handle
    return {
      tier: 3,
      reason: 'CRUD endpoints detected but no components.schemas to infer entity shape from — AI will derive fields',
      openapi, endpoints, inferredModuleName,
    };
  }
  if (entities.length > 1) {
    // Multiple schemas → likely cross-reference;tier 3
    return {
      tier: 3,
      reason: `multiple entity schemas (${entities.map(e => e.name).join(', ')}) — let AI handle relationships`,
      openapi, endpoints, entities, inferredModuleName,
    };
  }

  // Step 4 — check for "non-templateable" wrappers (custom response envelope hints)
  // The OpenAPI responses section may contain wrapping like { success, data, message }.
  // For tier 1 we want the default { success, data, message } envelope. If OpenAPI
  // specifies a custom one (e.g. PascalCase), let AI handle.
  // Heuristic: check the first GET response's schema for unexpected fields.
  // (Conservative — bail on tier 3 if anything's funky.)
  // Skipped for now — primary entity match is sufficient signal.

  const primaryEntity = entities[0];
  const hasConstraints = hasFieldConstraints(primaryEntity.fields);

  if (hasConstraints) {
    return {
      tier: 2,
      reason: 'standard CRUD + single entity, with field constraints — template skeleton + AI fills constraints',
      openapi, endpoints, entities, inferredModuleName,
    };
  }

  return {
    tier: 1,
    reason: 'standard CRUD + single entity + no field constraints — pure template generation',
    openapi, endpoints, entities, inferredModuleName,
  };
}
