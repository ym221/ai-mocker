/**
 * generate-template — 把 tier 1/2 classifier 结果转成 5 个文件内容,落盘。
 *
 * tier 1:全程 deterministic,无 LLM,几秒返回。
 * tier 2:由调用方先用 LLM 单次填充字段约束 + 跨字段规则,再调本模块产出文件。
 *
 * 输出后必须由调用方跑:
 *   - writeFiles → 落盘 + DB sync(已含原子事务回滚)
 *   - computeModuleHealth → 验文件齐全 + 表存在
 *   - probeControllerLoadable → 验 controller 能 import
 *   - runSmokeTest → 验首个 GET 能返合法响应
 * 任一失败 → fallback 到 tier 3(走 ChatRunner)。
 */

import type { DetectedEntity, DetectedEndpoint, DetectedField } from './spec-classifier.js';

export interface GenerateInput {
  moduleName: string;
  displayName?: string;
  description?: string;
  entity: DetectedEntity;
  endpoints: DetectedEndpoint[];
}

export interface GeneratedFile {
  path: string;
  content: string;
}

// ============================================================================
// Field type → SQLite type
// ============================================================================

function sqliteType(field: DetectedField): string {
  switch (field.type) {
    case 'integer':
    case 'int':
    case 'boolean':
      return 'INTEGER';
    case 'number':
    case 'decimal':
    case 'float':
      return 'REAL';
    default:
      return 'TEXT';
  }
}

function sqliteDefault(field: DetectedField): string {
  // Defaults from spec — none in tier 1 detection unless explicitly set
  return '';
}

// ============================================================================
// _meta.json
// ============================================================================

function buildMeta(input: GenerateInput): string {
  const metaEndpoints = input.endpoints.map(ep => ({
    method: ep.method,
    path: normalizeEndpointPath(ep.path, input.entity.name),
    name: endpointDefaultName(ep),
    type: ep.type,
  }));

  const meta = {
    name: input.moduleName,
    displayName: input.displayName ?? input.moduleName,
    description: input.description ?? '',
    basePath: `/mock/${input.moduleName}`,
    version: 1,
    status: 'active',
    entities: [{
      name: input.entity.name,
      tableName: `mock__${input.entity.name}`,
      displayName: input.entity.name,
      fields: input.entity.fields.map(f => {
        const out: Record<string, unknown> = { name: f.name, type: f.type };
        if (f.required) out.required = true;
        if (f.enum) out.enum = f.enum;
        if (f.min != null) out.min = f.min;
        if (f.max != null) out.max = f.max;
        if (f.pattern) out.pattern = f.pattern;
        if (f.minLength != null) out.minLength = f.minLength;
        if (f.maxLength != null) out.maxLength = f.maxLength;
        return out;
      }),
    }],
    endpoints: metaEndpoints,
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  };
  return JSON.stringify(meta, null, 2);
}

/**
 * Normalize OpenAPI-style path (e.g. /items/{id}) to MockForge-style (/:id).
 * Strip the leading /<entity-base>/ since basePath already covers that — the
 * endpoint.path should be a module-internal sub-path.
 */
function normalizeEndpointPath(path: string, entityName: string): string {
  // /items/{id} → /:id;  /items → /
  let p = path.replace(/\{([^}]+)\}/g, ':$1');
  // Strip /<entity>/ prefix:  /items/:id → /:id ;  /items → /
  // Match the OpenAPI base segment first; if it equals the plural of entityName, strip it.
  const entityPlural = entityName.endsWith('s') ? entityName : entityName + 's';
  const lc = p.toLowerCase();
  if (lc === `/${entityPlural.toLowerCase()}` || lc === `/${entityName.toLowerCase()}`) {
    return '/';
  }
  if (lc.startsWith(`/${entityPlural.toLowerCase()}/`) || lc.startsWith(`/${entityName.toLowerCase()}/`)) {
    return p.replace(/^\/[^/]+/, '');
  }
  // Otherwise return as-is (with /:param normalized)
  return p;
}

function endpointDefaultName(ep: DetectedEndpoint): string {
  switch (ep.type) {
    case 'list': return '列表';
    case 'detail': return '详情';
    case 'create': return '创建';
    case 'update': return '更新';
    case 'delete': return '删除';
    default: return ep.method + ' ' + ep.path;
  }
}

// ============================================================================
// schema.sql
// ============================================================================

function buildSchema(input: GenerateInput): string {
  const lines = [`CREATE TABLE IF NOT EXISTS \`mock__${input.entity.name}\` (`];
  lines.push(`  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,`);
  const colLines: string[] = [];
  for (const f of input.entity.fields) {
    const type = sqliteType(f);
    const nn = f.required && !f.enum ? ' NOT NULL' : '';
    colLines.push(`  \`${f.name}\` ${type}${nn}`);
  }
  lines.push(colLines.join(',\n'));
  lines.push(`);`);
  return lines.join('\n');
}

// ============================================================================
// controller.ts
// ============================================================================

function buildController(input: GenerateInput): string {
  const entityName = input.entity.name;
  const tableName = `mock__${entityName}`;
  return `import { BaseModel, ValidationError } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';

const model = new BaseModel('${tableName}').withMeta('${input.moduleName}');

function asValidationFail(e: unknown) {
  if (e instanceof ValidationError) {
    return { success: false, message: e.message, statusCode: 400 };
  }
  throw e;
}

export const list = async (req: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 20;
  const result = model.findAll({ page, pageSize });
  return paginated(result.list, result.total, result.page, result.pageSize);
};

export const getById = async (req: any) => {
  const item = model.findById(Number(req.params.id));
  if (!item) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(item);
};

export const create = async (req: any) => {
  try { return success(model.create(req.body), '创建成功'); }
  catch (e) { return asValidationFail(e); }
};

export const update = async (req: any) => {
  const id = Number(req.params.id);
  const existing = model.findById(id);
  if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  try { return success(model.update(id, req.body), '更新成功'); }
  catch (e) { return asValidationFail(e); }
};

export const remove = async (req: any) => {
  const deleted = model.delete(Number(req.params.id));
  if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(null, '删除成功');
};
`;
}

// ============================================================================
// test.ts
// ============================================================================

function buildTest(input: GenerateInput): string {
  const moduleName = input.moduleName;
  const fields = input.entity.fields;
  // Build sample body: pick fields, use type-appropriate placeholder
  const sampleBody: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.enum && f.enum.length > 0) sampleBody[f.name] = f.enum[0];
    else if (f.type === 'integer' || f.type === 'int') sampleBody[f.name] = f.min ?? 1;
    else if (f.type === 'number' || f.type === 'float' || f.type === 'decimal') sampleBody[f.name] = 1.0;
    else if (f.type === 'boolean') sampleBody[f.name] = false;
    else sampleBody[f.name] = 'test_' + f.name;
  }
  const sampleJson = JSON.stringify(sampleBody, null, 2);

  return `import { test, assert, request } from '@core/test-runner.js';

test('创建 ${moduleName}', async (ctx) => {
  const res = await request.post('/mock/${moduleName}', ${sampleJson});
  assert.eq(res.status, 200);
  assert.ok(res.body.success);
  ctx.lastId = res.body.data.id;
});

test('获取列表', async () => {
  const res = await request.get('/mock/${moduleName}');
  assert.eq(res.status, 200);
  assert.ok(res.body.data.list.length > 0);
});

test('获取详情', async (ctx) => {
  const res = await request.get(\`/mock/${moduleName}/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
  assert.exists(res.body.data);
});

test('删除', async (ctx) => {
  const res = await request.delete(\`/mock/${moduleName}/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
});
`;
}

// ============================================================================
// api-doc.md
// ============================================================================

function buildApiDoc(input: GenerateInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.displayName ?? input.moduleName} API`);
  lines.push('');
  lines.push(input.description ?? '');
  lines.push('');
  for (const ep of input.endpoints) {
    const p = normalizeEndpointPath(ep.path, input.entity.name);
    lines.push(`## ${ep.method} /mock/${input.moduleName}${p}`);
    lines.push('');
    lines.push(`类型:${endpointDefaultName(ep)}`);
    lines.push('');
    lines.push('### 字段');
    lines.push('| 字段 | 类型 | 必填 | 说明 |');
    lines.push('|------|------|------|------|');
    for (const f of input.entity.fields) {
      const required = f.required ? '是' : '否';
      const constraints: string[] = [];
      if (f.enum) constraints.push(`枚举: ${f.enum.join('|')}`);
      if (f.min != null) constraints.push(`min: ${f.min}`);
      if (f.max != null) constraints.push(`max: ${f.max}`);
      if (f.pattern) constraints.push(`pattern: ${f.pattern}`);
      lines.push(`| ${f.name} | ${f.type} | ${required} | ${constraints.join(', ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// Public API
// ============================================================================

export function generateTier1Files(input: GenerateInput): GeneratedFile[] {
  const m = input.moduleName;
  return [
    { path: `${m}/_meta.json`, content: buildMeta(input) },
    { path: `${m}/schema.sql`, content: buildSchema(input) },
    { path: `${m}/controller.ts`, content: buildController(input) },
    { path: `${m}/test.ts`, content: buildTest(input) },
    { path: `${m}/api-doc.md`, content: buildApiDoc(input) },
  ];
}
