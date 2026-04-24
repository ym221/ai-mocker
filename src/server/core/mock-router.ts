import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { mockContext } from './base-model.js';
import { db } from './database.js';
import { users } from './schema.js';
import { eq } from 'drizzle-orm';
import { recordMockAccess } from './access-log.js';

const GENERATED_DIR = resolve('generated');

interface MetaEndpoint {
  method: string;
  path: string;
  name: string;
  type: string;
  handler?: string;
  /**
   * Named controller export to dispatch to (Step-Fix-1.1).
   * When set, mock-router calls `ctrl[controller]({ body, query, params })` instead of
   * the legacy type-based `ctrl.list/getById/create/update/remove(...)` positional dispatch.
   * Enables multi-entity modules (e.g. warehouse has listWarehouse / listItems / listInventory).
   */
  controller?: string;
}

interface ModuleMeta {
  name: string;
  endpoints: MetaEndpoint[];
  config?: {
    delay?: { min: number; max: number };
    errorRate?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Match a URL sub-path against an endpoint pattern */
function matchPath(pattern: string, subPath: string): { matched: boolean; params: Record<string, string> } {
  const params: Record<string, string> = {};

  // Normalize: ensure both start with /
  const p = pattern.startsWith('/') ? pattern : '/' + pattern;
  const s = subPath.startsWith('/') ? subPath : '/' + subPath;

  const patternParts = p.split('/').filter(Boolean);
  const subParts = s.split('/').filter(Boolean);

  // Root path matching
  if (patternParts.length === 0 && subParts.length === 0) {
    return { matched: true, params };
  }

  if (patternParts.length !== subParts.length) {
    return { matched: false, params };
  }

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = subParts[i];
    } else if (patternParts[i] !== subParts[i]) {
      return { matched: false, params };
    }
  }

  return { matched: true, params };
}

export default async function mockRouter(app: FastifyInstance) {
  app.all('/mock/*', async (request, reply) => {
    const startTime = Date.now();
    const method = request.method.toUpperCase();
    const fullPath = request.url.split('?')[0];

    let loggedUserId = 0;
    let loggedModuleName = 'unknown';
    let loggedResponseBody: unknown = null;

    const finalize = () => {
      recordMockAccess({
        userId: loggedUserId,
        moduleName: loggedModuleName,
        method,
        path: fullPath,
        statusCode: reply.raw.statusCode || 200,
        durationMs: Date.now() - startTime,
        requestBody: request.body,
        responseBody: loggedResponseBody,
      });
    };
    reply.raw.on('close', finalize);

    // 0. Determine userId
    const uidHeader = request.headers['x-mock-user'] as string | undefined;
    const uidQuery = (request.query as Record<string, string>)?._uid;
    let userId = Number(uidHeader || uidQuery);

    if (!userId || isNaN(userId)) {
      // Default to admin user (id=1)
      const admin = db.select().from(users).where(eq(users.role, 'admin')).get();
      userId = admin?.id || 1;
    }
    loggedUserId = userId;

    // 1. Parse URL → moduleName + subPath
    const url = (request.params as { '*': string })['*'];
    const parts = url.split('/');
    const moduleName = parts[0];
    const subPath = '/' + parts.slice(1).join('/');
    if (moduleName) loggedModuleName = moduleName;

    if (!moduleName) {
      return reply.status(404).send({ success: false, message: 'Module name required' });
    }

    // 2. Read _meta.json
    const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
    if (!existsSync(metaPath)) {
      return reply.status(404).send({ success: false, message: `Module "${moduleName}" not found` });
    }

    let meta: ModuleMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
      return reply.status(500).send({ success: false, message: 'Failed to read module metadata' });
    }

    // 3. Match endpoint — fixed paths first, then parameterized
    let matchedEndpoint: MetaEndpoint | null = null;
    let matchedParams: Record<string, string> = {};

    // First pass: exact/fixed paths
    for (const ep of meta.endpoints) {
      if (ep.method.toUpperCase() !== method) continue;
      if (!ep.path.includes(':')) {
        const result = matchPath(ep.path, subPath);
        if (result.matched) {
          matchedEndpoint = ep;
          matchedParams = result.params;
          break;
        }
      }
    }

    // Second pass: parameterized paths
    if (!matchedEndpoint) {
      for (const ep of meta.endpoints) {
        if (ep.method.toUpperCase() !== method) continue;
        if (ep.path.includes(':')) {
          const result = matchPath(ep.path, subPath);
          if (result.matched) {
            matchedEndpoint = ep;
            matchedParams = result.params;
            break;
          }
        }
      }
    }

    if (!matchedEndpoint) {
      return reply.status(404).send({ success: false, message: `No endpoint matches ${method} /mock/${moduleName}${subPath}` });
    }

    // 4. Apply delay & error simulation
    const config = meta.config || {};
    if (config.delay && (config.delay.min > 0 || config.delay.max > 0)) {
      const min = config.delay.min || 0;
      const max = config.delay.max || min;
      const delay = min + Math.random() * (max - min);
      if (delay > 0) await sleep(delay);
    }
    if (config.errorRate && Math.random() < config.errorRate) {
      return reply.status(500).send({ success: false, message: 'Simulated server error' });
    }

    // 5. Dynamic import controller
    const controllerPath = join(GENERATED_DIR, String(userId), moduleName, 'controller.ts');
    if (!existsSync(controllerPath)) {
      return reply.status(500).send({ success: false, message: 'Controller not found' });
    }

    let ctrl: Record<string, Function>;
    try {
      const fileUrl = pathToFileURL(controllerPath).href + `?t=${Date.now()}`;
      ctrl = await mockContext.run({ userId }, () => import(fileUrl));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, message: `Controller load error: ${msg}` });
    }

    // 6. Call handler within mockContext so BaseModel knows the userId
    try {
      const query = request.query as Record<string, string>;
      const body = request.body as Record<string, unknown>;

      const result = mockContext.run({ userId }, () => {
        // Preferred: explicit named controller export (multi-entity modules).
        // _meta.endpoints[].controller = "listItems" → ctrl.listItems({ body, query, params })
        const namedHandler = matchedEndpoint!.controller;
        if (namedHandler) {
          if (typeof ctrl[namedHandler] !== 'function') {
            const available = Object.keys(ctrl).filter(k => typeof ctrl[k] === 'function').join(', ') || '(none)';
            throw new Error(
              `Controller export "${namedHandler}" not found (from _meta.endpoints[].controller). `
              + `Available exports: ${available}`
            );
          }
          return ctrl[namedHandler]({ body, query, params: matchedParams });
        }

        // Legacy type-based dispatch (single-entity modules).
        switch (matchedEndpoint!.type) {
          case 'list':
            return ctrl.list(query);
          case 'detail':
            return ctrl.getById(matchedParams.id);
          case 'create':
            return ctrl.create(body);
          case 'update':
            return ctrl.update(matchedParams.id, body);
          case 'delete':
            return ctrl.remove(matchedParams.id);
          case 'custom': {
            const handlerName = matchedEndpoint!.handler || matchedEndpoint!.name;
            if (!ctrl[handlerName]) {
              throw new Error(`Handler "${handlerName}" not found in controller`);
            }
            return ctrl[handlerName](body, query, matchedParams);
          }
          default:
            throw new Error(`Unknown endpoint type: ${matchedEndpoint!.type}`);
        }
      });

      // ========== Response processing (priority order) ==========
      // 1) __mock__ escape hatch — fully custom response
      // 2) statusCode field — explicit status override
      // 3) default — 200 with body as-is
      //
      // NOTE: controller's return value is AUTHORITATIVE. mock-router does not
      // interpret `success:false` as an error — business-validation failures,
      // conflicts, not-found etc. are all decided by controller via statusCode.

      if (result && typeof result === 'object' && '__mock__' in result) {
        const mock = (result as { __mock__: { status?: number; headers?: Record<string, string>; body?: unknown } }).__mock__;
        const status = mock.status ?? 200;
        if (mock.headers) {
          for (const [k, v] of Object.entries(mock.headers)) reply.header(k, v);
        }
        // Only set default Content-Type if caller didn't set one
        if (!reply.getHeader('Content-Type')) {
          reply.header('Content-Type', 'application/json; charset=utf-8');
        }
        loggedResponseBody = mock.body ?? null;
        return reply.status(status).send(mock.body ?? null);
      }

      // Default content type for JSON responses
      reply.header('Content-Type', 'application/json; charset=utf-8');

      if (result && typeof result === 'object' && 'statusCode' in result) {
        const status = Number((result as { statusCode: unknown }).statusCode);
        if (!isNaN(status) && status >= 100 && status < 600) {
          // Strip statusCode from body so it doesn't leak into the JSON payload
          const { statusCode: _sc, ...body } = result as Record<string, unknown>;
          loggedResponseBody = body;
          return reply.status(status).send(body);
        }
      }

      loggedResponseBody = result;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const body = { success: false, message: `Controller error: ${msg}` };
      loggedResponseBody = body;
      return reply.status(500).send(body);
    }
  });
}
