import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  normalizeMeta,
  getEntities,
  pickEntityForEndpoint,
  type ModuleMeta,
  type MetaField,
  type MetaEntity,
  type EntityConstraint,
} from './meta-schema.js';

const GENERATED_DIR = resolve('generated');

function fieldTypeToOpenApi(t: string): { type: string; format?: string } {
  switch (t) {
    case 'integer': case 'number': return { type: 'integer', format: 'int64' };
    case 'float': case 'decimal': return { type: 'number', format: 'float' };
    case 'boolean': return { type: 'boolean' };
    case 'date': return { type: 'string', format: 'date' };
    case 'datetime': case 'timestamp': return { type: 'string', format: 'date-time' };
    case 'text': case 'string': default: return { type: 'string' };
  }
}

/**
 * Map a single MetaField to an OpenAPI schema fragment.
 * Includes type/format + every applicable constraint (enum, min/max, pattern,
 * minLength/maxLength, default, description). The result is shared between
 * full entity schemas and Patch schemas — adding a constraint here propagates
 * to both POST validation and PUT validation views.
 */
function fieldToOpenApiSchema(f: MetaField): Record<string, unknown> {
  const oapi: Record<string, unknown> = {
    ...fieldTypeToOpenApi(String(f.type || 'string')),
  };
  if (f.description) oapi.description = f.description;
  else if (f.displayName) oapi.description = f.displayName;
  if (Array.isArray(f.enum) && f.enum.length > 0) oapi.enum = [...f.enum];
  if (typeof f.min === 'number') oapi.minimum = f.min;
  if (typeof f.max === 'number') oapi.maximum = f.max;
  if (typeof f.minLength === 'number') oapi.minLength = f.minLength;
  if (typeof f.maxLength === 'number') oapi.maxLength = f.maxLength;
  if (typeof f.pattern === 'string') oapi.pattern = f.pattern;
  if (f.default !== undefined) oapi.default = f.default;
  return oapi;
}

/**
 * Render entity-level cross-field constraints into a markdown block for the
 * endpoint description. Schema-level OpenAPI cannot natively express "if X
 * then Y" rules, so we surface them in description for human readers, and
 * diff_with_openapi reads constraints directly from _meta.json (Task 4.4).
 */
function constraintsToMarkdown(constraints: EntityConstraint[]): string {
  if (!constraints.length) return '';
  const lines = ['', '## 业务约束 (Cross-field rules)'];
  for (const c of constraints) {
    const id = c.id ? ` [${c.id}]` : '';
    const whenStr = JSON.stringify(c.when);
    const mustStr = JSON.stringify(c.must);
    lines.push(`- when ${whenStr} → must ${mustStr}${id}`);
    if (c.message) lines.push(`  - ${c.message}`);
  }
  return lines.join('\n');
}

export type { ModuleMeta };

export function readModuleMeta(userId: number, moduleName: string): ModuleMeta | null {
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (!existsSync(metaPath)) return null;
  try { return normalizeMeta(JSON.parse(readFileSync(metaPath, 'utf-8')) as ModuleMeta); }
  catch { return null; }
}

/** 基于模块的 _meta.json 构造 OpenAPI 3.0.3 spec。返回 null 表示 meta 不存在。 */
export function buildOpenApi(userId: number, moduleName: string): Record<string, unknown> | null {
  const meta = readModuleMeta(userId, moduleName);
  if (!meta) return null;

  const spec: Record<string, any> = {
    openapi: '3.0.3',
    info: {
      title: meta.displayName || meta.name || moduleName,
      version: String(meta.version ?? 1),
      description: meta.description || '',
    },
    paths: {},
    components: { schemas: {} },
  };

  const entities = getEntities(meta);
  const firstEntity = entities[0];
  const firstEntityName = firstEntity?.name;
  for (const ent of entities) {
    // ===== Full schema: includes id + all fields + created_at / updated_at =====
    // Used for response bodies and POST (create) request bodies.
    const properties: Record<string, any> = {
      id: { type: 'integer', format: 'int64', description: 'Primary key (auto-increment)' },
    };
    const required: string[] = [];
    // ===== Patch schema: only user-writable fields, all OPTIONAL =====
    // Used for PUT/PATCH request bodies. Mirrors BaseModel.update() semantics
    // (partial merge — only pass the fields you want to change).
    const patchProperties: Record<string, any> = {};
    for (const f of ent.fields || []) {
      const oapiSchema = fieldToOpenApiSchema(f);
      properties[f.name] = oapiSchema;
      patchProperties[f.name] = oapiSchema;
      if (f.required) required.push(f.name);
    }
    properties.created_at = { type: 'string', format: 'date-time', description: 'Created at' };
    properties.updated_at = { type: 'string', format: 'date-time', description: 'Updated at' };
    const schemas = spec.components.schemas as Record<string, any>;
    schemas[ent.name] = {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    };
    schemas[`${ent.name}Patch`] = {
      type: 'object',
      description: `Partial update body for ${ent.name} — all fields optional.`,
      properties: patchProperties,
    };
  }

  const basePath = meta.basePath || '';

  const successEnvelope = (dataSchema: any) => ({
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: dataSchema,
    },
  });

  // Per-entity cross-field constraints surface as markdown appended to
  // write-endpoint descriptions (POST/PUT/PATCH). diff_with_openapi reads
  // constraints directly from _meta.json, so the description block is for
  // human / OpenAPI consumers.
  const constraintsMdByEntity = new Map<string, string>();
  for (const e of entities) {
    constraintsMdByEntity.set(e.name, constraintsToMarkdown(e.constraints || []));
  }

  for (const ep of meta.endpoints || []) {
    const targetEntity: MetaEntity | null = pickEntityForEndpoint(ep, entities);
    const entityName = targetEntity?.name || firstEntityName;
    const entityRef = entityName ? `#/components/schemas/${entityName}` : undefined;
    const patchRef = entityName ? `#/components/schemas/${entityName}Patch` : undefined;
    const constraintsMd = targetEntity ? (constraintsMdByEntity.get(targetEntity.name) || '') : '';
    const fullPath = (basePath + (ep.path || '')).replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
    const method = String(ep.method || 'GET').toLowerCase();
    const isWrite = method === 'post' || method === 'put' || method === 'patch';
    const op: Record<string, any> = {
      summary: ep.name || ep.type,
      tags: [meta.name || moduleName],
    };
    if (isWrite && constraintsMd) {
      op.description = constraintsMd.trimStart();
    }

    const paramNames: string[] = [];
    const re = /\{([A-Za-z0-9_]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fullPath)) !== null) paramNames.push(m[1]);
    if (paramNames.length > 0) {
      op.parameters = paramNames.map((n) => ({
        name: n,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
    }

    // POST = create: full entity schema (respects required fields).
    // PUT / PATCH = partial update: Patch schema (all fields optional) to
    // match BaseModel.update() semantics. This prevents diff_with_openapi
    // from flagging spec-correct partial updates as "missing required field".
    if (method === 'post' && entityRef) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: entityRef } } },
      };
    } else if ((method === 'put' || method === 'patch') && patchRef) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: patchRef } } },
      };
    }

    let dataSchema: any = entityRef ? { $ref: entityRef } : { type: 'object' };
    if (ep.type === 'list') {
      dataSchema = {
        type: 'object',
        properties: {
          list: { type: 'array', items: entityRef ? { $ref: entityRef } : { type: 'object' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
        },
      };
    } else if (ep.type === 'delete') {
      dataSchema = { type: 'null' };
    }

    op.responses = {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: successEnvelope(dataSchema) } },
      },
    };

    const paths = spec.paths as Record<string, any>;
    paths[fullPath] = { ...(paths[fullPath] || {}), [method]: op };
  }

  return spec;
}

/** 从 _meta.json 提取端点摘要，供 list_modules 用。 */
export function summarizeEndpoints(userId: number, moduleName: string): string[] {
  const meta = readModuleMeta(userId, moduleName);
  if (!meta) return [];
  const basePath = meta.basePath || '';
  return (meta.endpoints || []).map((ep) => {
    const p = (basePath + (ep.path || '')).replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
    return `${String(ep.method || 'GET').toUpperCase()} ${p}`;
  });
}
