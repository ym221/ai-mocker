import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { mockContext } from './base-model.js';
import { db } from './database.js';
import { users } from './schema.js';
import { eq } from 'drizzle-orm';

const GENERATED_DIR = resolve('generated');

interface MetaEndpoint {
  method: string;
  path: string;
  name: string;
  type: string;
  handler?: string;
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
    // 0. Determine userId
    const uidHeader = request.headers['x-mock-user'] as string | undefined;
    const uidQuery = (request.query as Record<string, string>)?._uid;
    let userId = Number(uidHeader || uidQuery);

    if (!userId || isNaN(userId)) {
      // Default to admin user (id=1)
      const admin = db.select().from(users).where(eq(users.role, 'admin')).get();
      userId = admin?.id || 1;
    }

    // 1. Parse URL → moduleName + subPath
    const url = (request.params as { '*': string })['*'];
    const parts = url.split('/');
    const moduleName = parts[0];
    const subPath = '/' + parts.slice(1).join('/');

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
    const method = request.method.toUpperCase();
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

    // 6. Call handler
    try {
      let result: unknown;
      const query = request.query as Record<string, string>;
      const body = request.body as Record<string, unknown>;

      switch (matchedEndpoint.type) {
        case 'list':
          result = ctrl.list(query);
          break;
        case 'detail':
          result = ctrl.getById(matchedParams.id);
          break;
        case 'create':
          result = ctrl.create(body);
          break;
        case 'update':
          result = ctrl.update(matchedParams.id, body);
          break;
        case 'delete':
          result = ctrl.remove(matchedParams.id);
          break;
        case 'custom': {
          const handlerName = matchedEndpoint.handler || matchedEndpoint.name;
          if (!ctrl[handlerName]) {
            return reply.status(500).send({ success: false, message: `Handler "${handlerName}" not found in controller` });
          }
          result = ctrl[handlerName](body, query, matchedParams);
          break;
        }
        default:
          return reply.status(500).send({ success: false, message: `Unknown endpoint type: ${matchedEndpoint.type}` });
      }

      // Set response headers
      reply.header('Content-Type', 'application/json; charset=utf-8');

      // Check if result indicates an error
      if (result && typeof result === 'object' && 'success' in result && !(result as { success: boolean }).success) {
        return reply.status(404).send(result);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, message: `Controller error: ${msg}` });
    }
  });
}
