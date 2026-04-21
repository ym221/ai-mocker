import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const GENERATED_DIR = resolve('generated');

interface MetaField { name: string; type?: string; displayName?: string; required?: boolean }
interface MetaEntity { name: string; fields?: MetaField[] }
interface MetaEndpoint { name?: string; type?: string; method?: string; path?: string }
interface ModuleMeta {
  name?: string;
  displayName?: string;
  description?: string;
  version?: number | string;
  basePath?: string;
  entities?: MetaEntity[];
  endpoints?: MetaEndpoint[];
}

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

export function readModuleMeta(userId: number, moduleName: string): ModuleMeta | null {
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf-8')) as ModuleMeta; } catch { return null; }
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
    const properties: Record<string, any> = {
      // 所有 Mock 实体都有自增主键 id + 自动 created_at / updated_at
      id: { type: 'integer', format: 'int64', description: 'Primary key (auto-increment)' },
    };
    const required: string[] = [];
    for (const f of ent.fields || []) {
      properties[f.name] = {
        ...fieldTypeToOpenApi(String(f.type || 'string')),
        ...(f.displayName ? { description: f.displayName } : {}),
      };
      if (f.required) required.push(f.name);
    }
    properties.created_at = { type: 'string', format: 'date-time', description: 'Created at' };
    properties.updated_at = { type: 'string', format: 'date-time', description: 'Updated at' };
    (spec.components.schemas as Record<string, any>)[ent.name] = {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    };
  }

  const firstRef = firstEntityName ? `#/components/schemas/${firstEntityName}` : undefined;
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

    if (method === 'post' || method === 'put' || method === 'patch') {
      if (firstRef) {
        op.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: firstRef } } },
        };
      }
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
