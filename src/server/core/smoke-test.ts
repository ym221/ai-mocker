/**
 * Smoke test — deterministic post-generation sanity check.
 *
 * 不调 AI、不跑 run_test 全套。只挑一个最简单的 GET endpoint 真打一次,
 * 验证:controller 能加载 + handler 能执行不抛 + 返回值是合法 JSON。
 *
 * 用途:chat-runner.ts finalize 路径 + patch_module_* 工具 + 模板生成路径
 * 都用这个统一兜底,代替"run_test 全 pass = done"的严格门槛。
 *
 * 失败不一定代表模块不可用 — 但通过基本上代表能调用。
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { sqlite } from './database.js';
import { mockContext } from './base-model.js';
import { getEntities, type MetaEndpoint } from './meta-schema.js';
import { resolveHandlerName, candidateHandlerNames, type DispatchEndpoint } from './handler-dispatch.js';

const GENERATED_DIR = resolve('generated');

export interface SmokeResult {
  passed: boolean;
  /** True 表示模块没有合适的 GET endpoint 来 smoke test(跳过,但不算失败) */
  skipped: boolean;
  skipReason?: string;
  /** Chosen endpoint for smoke test, e.g. "GET /items" */
  endpoint?: string;
  /** Response is non-null, serializable JSON */
  responseValid?: boolean;
  /** Resolved status code (default 200) */
  statusCode?: number;
  error?: string;
  durationMs: number;
}

/**
 * Pick the best endpoint for a smoke test:
 *   1. GET 列表(无 path param)— 最稳,空表也能返
 *   2. GET 任何无 path param 的 endpoint(custom GET)
 *   3. GET 带 path param — 需要 id,从 DB 取一行
 *   4. 无 GET → skip
 *
 * POST/PUT/DELETE 都有副作用,smoke test 不应 mutate 数据。
 */
function pickSmokeEndpoint(endpoints: MetaEndpoint[]): MetaEndpoint | null {
  const gets = endpoints.filter(e => (e.method ?? '').toUpperCase() === 'GET');
  if (gets.length === 0) return null;
  // Tier 1: GET 无 path param,且 type 是 list — 最稳
  const listGet = gets.find(e => e.type === 'list' && e.path && !e.path.includes(':') && !e.path.includes('{'));
  if (listGet) return listGet;
  // Tier 2: GET 无 path param
  const noParam = gets.find(e => e.path && !e.path.includes(':') && !e.path.includes('{'));
  if (noParam) return noParam;
  // Tier 3: GET 带 path param — 兜底,但需要 id 注入
  return gets[0];
}

async function loadController(userId: number, moduleName: string): Promise<Record<string, any>> {
  const controllerPath = join(GENERATED_DIR, String(userId), moduleName, 'controller.ts');
  if (!existsSync(controllerPath)) {
    throw new Error(`controller.ts not found at ${controllerPath}`);
  }
  const url = pathToFileURL(controllerPath).href + `?smoke=${Date.now()}`;
  return await mockContext.run({ userId }, () => import(url));
}

function buildReqForEndpoint(
  endpoint: MetaEndpoint,
  userId: number,
  moduleName: string,
  tableName: string | null,
): { body: Record<string, any>; query: Record<string, any>; params: Record<string, any> } {
  const body: Record<string, any> = {};
  const query: Record<string, any> = {};
  const params: Record<string, any> = {};

  // Inject path params from `:name` markers
  const path = endpoint.path ?? '';
  const segments = path.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      // For :id try to fetch a real row id from DB; fallback to "1"
      if (name === 'id' && tableName) {
        try {
          const injected = `mock__${userId}_${tableName.replace(/^mock__/, '')}`;
          const row = sqlite.prepare(`SELECT id FROM \`${injected}\` LIMIT 1`).get() as { id: number | string } | undefined;
          params[name] = row?.id ?? 1;
        } catch {
          params[name] = 1;
        }
      } else {
        params[name] = 1;
      }
    } else if (seg.startsWith('{') && seg.endsWith('}')) {
      const name = seg.slice(1, -1);
      params[name] = 1;
    }
  }

  // Common pagination defaults so list endpoints don't blow up on undefined
  query.page = 1;
  query.pageSize = 10;
  query.pageNumber = 1;
  query.itemsPerPage = 10;

  return { body, query, params };
}

function dispatchHandler(
  ctrl: Record<string, any>,
  endpoint: MetaEndpoint,
  req: { body: any; query: any; params: any },
): any {
  // 关键:**不要**在这里包 mockContext.run。外层 runSmokeTest 已经 `mockContext.run({ userId }, ...)`
  // 包了正确 userId;AsyncLocalStorage 嵌套时内层会覆盖外层,如果这里包 userId=0
  // 会导致 controller 里 new BaseModel(...) 拼出 mock__0_<table> 永远找不到表。
  //
  // Use the SAME resolver as the live mock-router. Previously this had its own
  // weaker dispatch (only ctrl.list/getById), so it false-failed multi-entity
  // modules whose exports follow <verb><Entity> (listProducts/getStats/payOrder) —
  // the smoke gate would reject modules the router actually serves fine.
  const name = resolveHandlerName(ctrl, endpoint as DispatchEndpoint);
  if (name) return ctrl[name](req);
  throw new Error(
    `Cannot dispatch handler for endpoint type="${endpoint.type}" path="${endpoint.path}". `
    + `Tried: [${candidateHandlerNames(endpoint as DispatchEndpoint).join(', ')}]. `
    + `Available exports: [${Object.keys(ctrl).filter(k => typeof ctrl[k] === 'function').join(', ') || '(none)'}].`,
  );
}

function validateResponse(result: unknown): { valid: boolean; statusCode: number; reason?: string } {
  if (result == null) return { valid: false, statusCode: 0, reason: 'handler returned null/undefined' };
  if (typeof result !== 'object') return { valid: false, statusCode: 0, reason: `handler returned ${typeof result}, not object` };
  // statusCode extraction
  const sc = (result as any).statusCode;
  const statusCode = typeof sc === 'number' ? sc : 200;
  // __mock__ shape — fully custom; trust the status field
  const mock = (result as any).__mock__;
  if (mock && typeof mock === 'object') {
    const ms = typeof mock.status === 'number' ? mock.status : 200;
    return { valid: ms >= 200 && ms < 500, statusCode: ms };  // accept 4xx as "valid response shape"
  }
  // JSON serializable?
  try {
    JSON.stringify(result);
  } catch (err) {
    return { valid: false, statusCode, reason: `response is not JSON-serializable: ${(err as Error).message}` };
  }
  return { valid: statusCode >= 200 && statusCode < 500, statusCode };
}

export async function runSmokeTest(userId: number, moduleName: string): Promise<SmokeResult> {
  const startedAt = Date.now();

  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (!existsSync(metaPath)) {
    return { passed: false, skipped: false, error: '_meta.json missing', durationMs: Date.now() - startedAt };
  }

  let meta: any;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    return { passed: false, skipped: false, error: `_meta.json parse failed: ${(err as Error).message}`, durationMs: Date.now() - startedAt };
  }

  const endpoints = Array.isArray(meta.endpoints) ? (meta.endpoints as MetaEndpoint[]) : [];
  if (endpoints.length === 0) {
    return { passed: false, skipped: false, error: 'no endpoints in _meta.json', durationMs: Date.now() - startedAt };
  }

  const chosen = pickSmokeEndpoint(endpoints);
  if (!chosen) {
    return {
      passed: true, // 没 GET 不视为失败,只是无法 smoke
      skipped: true,
      skipReason: 'no GET endpoint available for smoke test',
      durationMs: Date.now() - startedAt,
    };
  }

  const epLabel = `${(chosen.method ?? 'GET').toUpperCase()} ${chosen.path}`;

  let ctrl: Record<string, any>;
  try {
    ctrl = await loadController(userId, moduleName);
  } catch (err) {
    return {
      passed: false, skipped: false,
      endpoint: epLabel,
      error: `controller load failed: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
    };
  }

  const entities = getEntities(meta);
  const primaryTable = entities[0]?.tableName ?? null;
  const req = buildReqForEndpoint(chosen, userId, moduleName, primaryTable);

  let result: any;
  try {
    result = await mockContext.run({ userId }, () => dispatchHandler(ctrl, chosen, req));
  } catch (err) {
    return {
      passed: false, skipped: false,
      endpoint: epLabel,
      error: `handler threw: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
    };
  }

  const validation = validateResponse(result);
  return {
    passed: validation.valid,
    skipped: false,
    endpoint: epLabel,
    responseValid: validation.valid,
    statusCode: validation.statusCode,
    ...(validation.reason ? { error: validation.reason } : {}),
    durationMs: Date.now() - startedAt,
  };
}
