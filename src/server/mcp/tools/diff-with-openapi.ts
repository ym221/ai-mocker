import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { buildOpenApi, readModuleMeta } from '../../core/openapi-export.js';
import { matchCondition } from '../../core/validator.js';
import { getMcpUserId } from '../context.js';

type DiffKind =
  | 'endpoint-not-in-spec'
  | 'status-mismatch'
  | 'missing-in-actual'
  | 'missing-in-spec'
  | 'type-mismatch'
  | 'constraint-violation'
  | 'cross-field-violation';

interface Diff {
  path: string;
  kind: DiffKind;
  spec?: unknown;
  actual?: unknown;
  message?: string;
}

function jsTypeFamily(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return typeof v;
}

function specTypeFamily(schema: any): string {
  if (!schema) return 'unknown';
  if (schema.type) return schema.type;
  if (schema.$ref) return 'ref';
  return 'unknown';
}

function resolveRef(spec: any, ref: string): any {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur || null;
}

function resolveSchema(spec: any, schema: any): any {
  if (!schema) return null;
  if (schema.$ref) return resolveRef(spec, schema.$ref);
  return schema;
}

/**
 * Check leaf-value constraints against the resolved schema (enum, min/max,
 * minLength/maxLength, pattern). Each violation produces a constraint-
 * violation diff. Walked at object property leaves and at root primitives.
 */
function checkLeafConstraints(schema: any, actual: unknown, path: string, diffs: Diff[]): void {
  if (actual === null || actual === undefined) return;

  // enum
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.includes(actual)) {
      diffs.push({
        path: path || '(root)',
        kind: 'constraint-violation',
        spec: { enum: schema.enum },
        actual,
        message: `value not in enum [${schema.enum.join(', ')}]`,
      });
    }
  }

  // numeric range
  if (typeof actual === 'number') {
    if (typeof schema.minimum === 'number' && actual < schema.minimum) {
      diffs.push({
        path: path || '(root)', kind: 'constraint-violation',
        spec: { minimum: schema.minimum }, actual,
        message: `value < minimum ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === 'number' && actual > schema.maximum) {
      diffs.push({
        path: path || '(root)', kind: 'constraint-violation',
        spec: { maximum: schema.maximum }, actual,
        message: `value > maximum ${schema.maximum}`,
      });
    }
  }

  // string length + pattern
  if (typeof actual === 'string') {
    if (typeof schema.minLength === 'number' && actual.length < schema.minLength) {
      diffs.push({
        path: path || '(root)', kind: 'constraint-violation',
        spec: { minLength: schema.minLength }, actual: `len=${actual.length}`,
        message: `string shorter than minLength ${schema.minLength}`,
      });
    }
    if (typeof schema.maxLength === 'number' && actual.length > schema.maxLength) {
      diffs.push({
        path: path || '(root)', kind: 'constraint-violation',
        spec: { maxLength: schema.maxLength }, actual: `len=${actual.length}`,
        message: `string longer than maxLength ${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === 'string') {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(actual)) {
          diffs.push({
            path: path || '(root)', kind: 'constraint-violation',
            spec: { pattern: schema.pattern }, actual,
            message: `string does not match pattern`,
          });
        }
      } catch { /* invalid regex in spec — skip */ }
    }
  }
}

/** 递归对比实际值 vs spec schema。返回 diffs 数组。 */
function diffValueAgainstSchema(spec: any, schema: any, actual: unknown, pathPrefix: string, diffs: Diff[]): void {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) return;

  const specType = specTypeFamily(resolved);
  const actualType = jsTypeFamily(actual);

  // 类型不匹配（number/integer 兼容处理）
  const compat = specType === actualType
    || (specType === 'integer' && actualType === 'integer')
    || (specType === 'number' && (actualType === 'integer' || actualType === 'number'));
  if (!compat && actualType !== 'null') {
    diffs.push({
      path: pathPrefix || '(root)',
      kind: 'type-mismatch',
      spec: specType,
      actual: actualType,
    });
    return;
  }

  if (specType === 'object' && actualType === 'object' && actual && typeof actual === 'object') {
    const actualObj = actual as Record<string, unknown>;
    const properties = resolved.properties || {};
    const required: string[] = resolved.required || [];

    // spec 必填字段缺失
    for (const field of required) {
      if (!(field in actualObj)) {
        diffs.push({
          path: pathPrefix ? `${pathPrefix}.${field}` : field,
          kind: 'missing-in-actual',
          spec: properties[field] ? specTypeFamily(resolveSchema(spec, properties[field])) : 'unknown',
        });
      }
    }

    // actual 有而 spec 没描述的字段
    for (const k of Object.keys(actualObj)) {
      if (!(k in properties)) {
        diffs.push({
          path: pathPrefix ? `${pathPrefix}.${k}` : k,
          kind: 'missing-in-spec',
          actual: jsTypeFamily(actualObj[k]),
        });
      } else {
        diffValueAgainstSchema(spec, properties[k], actualObj[k], pathPrefix ? `${pathPrefix}.${k}` : k, diffs);
      }
    }
  } else if (specType === 'array' && actualType === 'array' && Array.isArray(actual)) {
    // 只对比第一个元素，假设数组元素同构
    if (actual.length > 0 && resolved.items) {
      diffValueAgainstSchema(spec, resolved.items, actual[0], pathPrefix ? `${pathPrefix}[0]` : '[0]', diffs);
    }
  } else {
    // Leaf value: check constraint annotations on the resolved schema
    checkLeafConstraints(resolved, actual, pathPrefix, diffs);
  }
}

/**
 * Cross-field check: read entity.constraints from _meta.json (OpenAPI cannot
 * natively express "if X then Y" rules, so we go straight to the source of
 * truth). For each constraint whose `when` matches, every `must` field is
 * checked against the actual record; failures produce cross-field-violation
 * diffs.
 */
function checkCrossFieldConstraints(
  userId: number,
  moduleName: string,
  actual: Record<string, unknown>,
  pathPrefix: string,
  diffs: Diff[],
): void {
  const meta = readModuleMeta(userId, moduleName);
  const entity = meta?.entities?.[0];
  const constraints = entity?.constraints || [];
  if (constraints.length === 0) return;

  for (const c of constraints) {
    const whenHit = Object.entries(c.when).every(([f, cond]) => matchCondition(actual[f], cond));
    if (!whenHit) continue;
    for (const [field, cond] of Object.entries(c.must)) {
      if (!matchCondition(actual[field], cond)) {
        diffs.push({
          path: pathPrefix ? `${pathPrefix}.${field}` : field,
          kind: 'cross-field-violation',
          spec: { when: c.when, must: { [field]: cond } },
          actual: actual[field],
          message: c.message,
        });
      }
    }
  }
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** 根据 method+path 从 OpenAPI 匹配对应 operation。忽略尾斜杠差异。 */
function matchOperation(openapi: any, method: string, actualPath: string): { operation: any; pathTemplate: string } | null {
  const methodLower = method.toLowerCase();
  const paths = openapi.paths || {};
  const cleanPath = stripTrailingSlash(actualPath.split('?')[0]);

  // 先遍历寻找精确字面匹配
  for (const [template, methods] of Object.entries(paths)) {
    if (!methods || !(methods as any)[methodLower]) continue;
    if (stripTrailingSlash(template) === cleanPath) {
      return { operation: (methods as any)[methodLower], pathTemplate: template };
    }
  }

  // 再遍历带 {param} 的模板匹配
  for (const [template, methods] of Object.entries(paths)) {
    if (!methods || !(methods as any)[methodLower]) continue;
    const normalizedTemplate = stripTrailingSlash(template);
    if (!normalizedTemplate.includes('{')) continue;
    const re = new RegExp('^' + normalizedTemplate.replace(/\{[^}]+\}/g, '[^/]+') + '$');
    if (re.test(cleanPath)) {
      return { operation: (methods as any)[methodLower], pathTemplate: template };
    }
  }

  return null;
}

export function registerDiffWithOpenApiTool(server: McpServer): void {
  server.registerTool(
    'diff_with_openapi',
    {
      title: 'Diff Actual Request/Response Against OpenAPI',
      description:
        'Compare an actual request/response (typically captured from get_mock_access_log) against the module\'s OpenAPI contract. Returns structured diffs: missing fields, extra fields, type mismatches, status code mismatches. Use this to quickly pinpoint whether the Mock is off-contract or the business code is off-contract.',
      inputSchema: {
        moduleName: z.string(),
        actualRequest: z
          .object({
            method: z.string(),
            path: z.string().describe('Full URL path e.g. /mock/order/123'),
            body: z.unknown().optional(),
          })
          .optional(),
        actualResponse: z
          .object({
            statusCode: z.number().optional(),
            body: z.unknown().optional(),
          })
          .optional(),
      },
    },
    async ({ moduleName, actualRequest, actualResponse }) => {
      const userId = getMcpUserId();
      const mod = db.select().from(modules)
        .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
        .get();
      if (!mod) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Module '${moduleName}' not found.` }],
        };
      }

      const spec = buildOpenApi(userId, moduleName);
      if (!spec) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Cannot build OpenAPI for '${moduleName}'.` }],
        };
      }

      const diffs: Diff[] = [];

      if (actualRequest) {
        const matched = matchOperation(spec, actualRequest.method, actualRequest.path);
        if (!matched) {
          diffs.push({
            path: `${actualRequest.method.toUpperCase()} ${actualRequest.path}`,
            kind: 'endpoint-not-in-spec',
            message: 'No operation in spec matches this method+path',
          });
        } else {
          const op = matched.operation;

          // 请求体 diff
          if (actualRequest.body !== undefined) {
            const reqSchema = op.requestBody?.content?.['application/json']?.schema;
            if (reqSchema) {
              diffValueAgainstSchema(spec, reqSchema, actualRequest.body, 'request.body', diffs);
            }
            // Cross-field constraints (read from _meta.json directly; OpenAPI
            // cannot natively express them). Only meaningful for write methods.
            const m = actualRequest.method.toUpperCase();
            if ((m === 'POST' || m === 'PUT' || m === 'PATCH') && typeof actualRequest.body === 'object' && actualRequest.body !== null) {
              checkCrossFieldConstraints(
                userId, moduleName,
                actualRequest.body as Record<string, unknown>,
                'request.body', diffs,
              );
            }
          }

          // 响应 status + body diff
          if (actualResponse) {
            const responses = op.responses || {};
            const actualStatus = actualResponse.statusCode ?? 200;
            const respKey = String(actualStatus) in responses ? String(actualStatus) : null;
            if (!respKey && responses['200']) {
              diffs.push({
                path: 'response.status',
                kind: 'status-mismatch',
                spec: Object.keys(responses),
                actual: actualStatus,
              });
            }
            if (actualResponse.body !== undefined) {
              const respForStatus = respKey ? responses[respKey] : responses['200'];
              const respSchema = respForStatus?.content?.['application/json']?.schema;
              if (respSchema) {
                diffValueAgainstSchema(spec, respSchema, actualResponse.body, 'response.body', diffs);
              }
            }
          }
        }
      }

      const aligned = diffs.length === 0;
      return {
        content: [
          {
            type: 'text',
            text: aligned
              ? `${moduleName}: aligned with spec (no diffs).`
              : `${moduleName}: ${diffs.length} diff(s):\n` +
                diffs.map((d) => `- [${d.kind}] ${d.path}`).join('\n'),
          },
        ],
        structuredContent: { moduleName, aligned, diffs },
      };
    }
  );
}
