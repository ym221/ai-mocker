/**
 * emit_params — Step-Workflow-1 强制工作流的第一步。
 *
 * 阶段 1:让 AI 在写任何文件之前,先输出严格 schema 的"模块参数"。框架收到后:
 *   1) zod 强校验结构 + 内部一致性(端点 entity 必须存在等)
 *   2) 存到 ChatRunner.params 内存
 *   3) 后续 write_files / write_file / run_test 等工具加 gate — 没 emit_params 就 reject
 *
 * 思想:把"AI 一次想清楚整体设计"从思考阶段落地到机器可校验的结构,后续 write 时
 *      就能用 params 校验 AI 真写出来的内容是否一致(字段名漂移 / 信封不一致都能抓)。
 */

import { z } from 'zod';

// ============================================================================
// Zod schemas (导出给 chat-runner / write 工具校验用)
// ============================================================================

export const fieldSchema = z.object({
  name: z.string().min(1),
  // json/array/object: 数组或对象字段。schema.sql 存为 TEXT,框架写入时自动 JSON 序列化、
  // 读取时自动解析回数组/对象(见 BaseModel.hydrateRow),controller 无需手动 stringify/parse。
  type: z.enum(['string', 'integer', 'int', 'number', 'decimal', 'float', 'boolean', 'date', 'datetime', 'text', 'json', 'array', 'object']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  unique: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  description: z.string().optional(),
});

export const entitySchema = z.object({
  name: z.string().min(1).describe('Entity name. e.g. "Order", "DirectHotelFinance"'),
  tableName: z.string().min(1).describe('Bare table name without mock__ prefix. e.g. "Order"'),
  primaryKey: z.object({
    name: z.string().min(1),
    type: z.enum(['INTEGER', 'TEXT']),
    autoIncrement: z.boolean().optional(),
  }),
  fields: z.array(fieldSchema).min(1),
  seedCount: z.number().int().min(0).optional().describe('Number of seed rows required per spec'),
  constraints: z.array(z.object({
    id: z.string().optional(),
    when: z.record(z.string(), z.unknown()),
    must: z.record(z.string(), z.unknown()),
    message: z.string(),
  })).optional(),
});

export const envelopeSchema = z.object({
  /**
   * 默认信封结构,用键名形式描述。e.g.
   *   { successFlag: 'success', dataField: 'data', messageField: 'message' }
   *   { successFlag: 'Success', dataField: 'Data', messageField: 'Message', paginationField: 'paginationInfo' }
   */
  default: z.object({
    successFlag: z.string().min(1).describe('字段名,如 "success" / "Success" / "IsSuccess"'),
    dataField: z.string().min(1).describe('字段名,如 "data" / "Data"'),
    messageField: z.string().optional(),
    paginationField: z.string().optional(),
  }),
  /**
   * 端点级例外。e.g. API-007 用 IsSuccess 替代 Success:
   *   exceptions: [{ endpointPath: '/api/get_exporders_list/...', envelope: { successFlag: 'IsSuccess', dataField: 'Data' } }]
   */
  exceptions: z.array(z.object({
    endpointPath: z.string(),
    envelope: z.object({
      successFlag: z.string(),
      dataField: z.string(),
      messageField: z.string().optional(),
    }),
  })).optional(),
});

export const endpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).describe('Module-internal path, must start with /. Framework auto-prepends /mock/<moduleName>'),
  type: z.enum(['list', 'detail', 'create', 'update', 'delete', 'custom']),
  entity: z.string().min(1).describe('Must match an entities[].name'),
  customLogic: z.string().optional().describe('Non-CRUD business logic in plain language. e.g. "查 SupplierHotel 后带出字段". null 表示纯 CRUD'),
});

export const paginationSchema = z.object({
  /** 请求侧分页字段名 + 默认值 */
  pageField: z.string().describe('e.g. "page" / "pageNumber"'),
  pageSizeField: z.string().describe('e.g. "pageSize" / "itemsPerPage"'),
  defaultPageSize: z.number().int().positive().optional(),
  /** 嵌套位置:flat = body 顶层;nested = body.paginationInfo */
  position: z.enum(['flat', 'nested']).optional(),
  nestedKey: z.string().optional().describe('When position=nested, e.g. "paginationInfo"'),
});

export const paramsSchema = z.object({
  moduleName: z.string().min(1),
  fieldNaming: z.enum(['snake_case', 'camelCase', 'PascalCase']),
  envelope: envelopeSchema,
  pagination: paginationSchema.optional(),
  entities: z.array(entitySchema).min(1),
  endpoints: z.array(endpointSchema).min(1),
});

export type ModuleParams = z.infer<typeof paramsSchema>;

// ============================================================================
// Internal consistency validation
// ============================================================================

export interface ConsistencyError {
  field: string;
  message: string;
}

/**
 * 跨字段一致性校验:每个 endpoint.entity 必须在 entities 里;
 * exceptions.endpointPath 必须能在 endpoints 里找到。
 */
export function checkConsistency(params: ModuleParams): ConsistencyError[] {
  const errors: ConsistencyError[] = [];
  const entityNames = new Set(params.entities.map(e => e.name));
  const endpointPaths = new Set(params.endpoints.map(e => e.path));

  params.endpoints.forEach((ep, i) => {
    if (!entityNames.has(ep.entity)) {
      errors.push({
        field: `endpoints[${i}].entity`,
        message: `endpoints[${i}].entity = "${ep.entity}" 不在 entities 列表中。entities 现有:[${[...entityNames].join(', ')}]`,
      });
    }
  });

  if (params.envelope.exceptions) {
    params.envelope.exceptions.forEach((exc, i) => {
      if (!endpointPaths.has(exc.endpointPath)) {
        errors.push({
          field: `envelope.exceptions[${i}].endpointPath`,
          message: `endpointPath = "${exc.endpointPath}" 不在 endpoints 列表中。`,
        });
      }
    });
  }

  // primaryKey 字段必须在 fields 列表中(用户可声明 id 是 PK 但 fields 里也得列)
  // 或:PK 是 id INTEGER AUTOINCREMENT 时,fields 不强制包含(框架默认有 id)
  params.entities.forEach((entity, i) => {
    const isDefaultId = entity.primaryKey.name === 'id'
      && entity.primaryKey.type === 'INTEGER'
      && entity.primaryKey.autoIncrement;
    if (!isDefaultId) {
      const fieldNames = new Set(entity.fields.map(f => f.name));
      if (!fieldNames.has(entity.primaryKey.name)) {
        errors.push({
          field: `entities[${i}].fields`,
          message: `entity "${entity.name}" 的 primaryKey="${entity.primaryKey.name}" 不在 fields 里。非 id INTEGER AUTOINCREMENT 的 PK 必须在 fields 中显式列出。`,
        });
      }
    }
  });

  return errors;
}

// ============================================================================
// Public API
// ============================================================================

export interface EmitParamsResult {
  success: boolean;
  message: string;
  params?: ModuleParams;
  errors?: Array<{ field: string; message: string }>;
}

/**
 * Coerce the many shapes weak models emit into the canonical params object,
 * BEFORE strict validation. This is parse-then-validate, not validation-skipping:
 * the result still goes through paramsSchema + consistency checks unchanged.
 *
 * Handles (all observed from real deepseek runs):
 *   - the whole payload as a JSON string
 *   - nested under a `params` key: { params: {...} } or { params: "{...}" }
 *   - individual sub-fields stringified: { envelope: "{...}", entities: "[...]" }
 * Without this, a weak model can burn its entire time budget failing emit_params
 * on shape/encoding alone and never reach the file-writing stage.
 */
function coerceRawParams(raw: unknown): unknown {
  let obj: any = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return raw; }
  }
  if (!obj || typeof obj !== 'object') return raw;
  // Unwrap a single `params` wrapper if the real payload is nested there.
  if ('params' in obj && !('moduleName' in obj)) {
    let inner = obj.params;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* keep */ } }
    if (inner && typeof inner === 'object') obj = inner;
  }
  // Parse any stringified sub-fields.
  const out: any = { ...obj };
  for (const key of ['envelope', 'entities', 'endpoints', 'pagination']) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { /* leave for validation to report */ }
    }
  }
  return out;
}

/**
 * 校验 raw input → 通过则返 normalized params。
 */
export function emitParams(raw: unknown): EmitParamsResult {
  const parsed = paramsSchema.safeParse(coerceRawParams(raw));
  if (!parsed.success) {
    const errors = parsed.error.issues.map(iss => ({
      field: iss.path.join('.'),
      message: iss.message,
    }));
    return {
      success: false,
      message: 'emit_params schema 校验失败:\n' + errors.map(e => `  - ${e.field}: ${e.message}`).join('\n'),
      errors,
    };
  }
  const params = parsed.data;
  const consistencyErrors = checkConsistency(params);
  if (consistencyErrors.length > 0) {
    return {
      success: false,
      message: 'emit_params 跨字段一致性校验失败:\n' + consistencyErrors.map(e => `  - ${e.field}: ${e.message}`).join('\n'),
      errors: consistencyErrors,
    };
  }
  return {
    success: true,
    message:
      `参数已接收 + 校验通过。entities=${params.entities.length}, endpoints=${params.endpoints.length}, fieldNaming=${params.fieldNaming}。\n`
      + `下一步:write_files 一次批写 5 个文件(必须严格符合本 params)。\n`
      + `**重要提醒**:\n`
      + `1. emit_params 的输出是给框架看的"结构化计划",不是任何文件的内容。_meta.json / schema.sql / controller.ts 都有各自的格式,见 get_module_template('crud-basic')\n`
      + `2. schema.sql 的 CREATE TABLE 必须用 \`mock__<tableName>\` 前缀(裸名前加 mock__),框架自动注入 userId 变 \`mock__<userId>_<tableName>\`。例:tableName="Order" → CREATE TABLE \`mock__Order\` (...)\n`
      + `3. 若 spec 说 "enum N 个值" 但没列出具体值 → **根据上下文推断业务合理的值**(如 supplierName=EBooking,signingEntity 应为 "EBooking SG"/"EBooking HK"/"EBooking CN"/"EBooking MY"/"EBooking Global"),**禁止用 entity1/entity2 这类占位符**`,
    params,
  };
}
