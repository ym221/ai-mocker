import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { normalizeMeta, type ModuleMeta, type MetaField, type EntityConstraint } from './meta-schema.js';

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

  const firstEntityName = meta.entities?.[0]?.name;
  for (const ent of meta.entities || []) {
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
      const oapiType = {
        ...fieldTypeToOpenApi(String(f.type || 'string')),
        ...(f.displayName ? { description: f.displayName } : {}),
      };
      properties[f.name] = oapiType;
      patchProperties[f.name] = oapiType;
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

  const firstRef = firstEntityName ? `#/components/schemas/${firstEntityName}` : undefined;
  const firstPatchRef = firstEntityName ? `#/components/schemas/${firstEntityName}Patch` : undefined;
  const basePath = meta.basePath || '';

  const successEnvelope = (dataSchema: any) => ({
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: dataSchema,
    },
  });

  for (const ep of meta.endpoints || []) {
    const fullPath = (basePath + (ep.path || '')).replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
    const method = String(ep.method || 'GET').toLowerCase();
    const op: Record<string, any> = {
      summary: ep.name || ep.type,
      tags: [meta.name || moduleName],
    };

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
    if (method === 'post' && firstRef) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: firstRef } } },
      };
    } else if ((method === 'put' || method === 'patch') && firstPatchRef) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: firstPatchRef } } },
      };
    }

    let dataSchema: any = firstRef ? { $ref: firstRef } : { type: 'object' };
    if (ep.type === 'list') {
      dataSchema = {
        type: 'object',
        properties: {
          list: { type: 'array', items: firstRef ? { $ref: firstRef } : { type: 'object' } },
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
