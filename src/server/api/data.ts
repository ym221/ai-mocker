import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../core/auth.js';
import { success, error } from '../core/response.js';
import { manageData, type FieldRule } from '../agent/tools/manage-data.js';

/** Parse filter[field]=value AND filter[field][op]=v / filter[field][value]=v from query.
 *  Returns shape: { field: { op?: string, value: any } | string }.
 *  - Simple value `filter[field]=v` → string (treated as LIKE later)
 *  - With operator `filter[field][op]=gt&filter[field][value]=100` → { op: 'gt', value: '100' }
 *  - Range `filter[field][op]=between&filter[field][min]=1&filter[field][max]=10` → { op:'between', min, max }
 *  - In set `filter[field][op]=in&filter[field][value]=a,b,c` → { op:'in', value:'a,b,c' }
 */
function parseFilter(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (query.filter && typeof query.filter === 'object' && !Array.isArray(query.filter)) {
    return query.filter as Record<string, unknown>;
  }
  for (const [k, v] of Object.entries(query)) {
    // Match filter[field] or filter[field][subkey]
    const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k);
    if (!m) continue;
    const field = m[1];
    const sub = m[2];
    if (!sub) {
      out[field] = v;
    } else {
      const obj = (out[field] && typeof out[field] === 'object' && !Array.isArray(out[field])) ? out[field] as Record<string, unknown> : {};
      obj[sub] = v;
      out[field] = obj;
    }
  }
  return out;
}

function isNumericLike(s: unknown): boolean {
  return typeof s === 'string' && s !== '' && !isNaN(Number(s));
}

/** Convert filter to BaseModel.where conditions. */
function filterToWhere(filter: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(filter)) {
    if (raw === '' || raw === null || raw === undefined) continue;
    // Simple string → LIKE
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      if (typeof raw === 'string') where[k] = { like: `%${raw}%` };
      else where[k] = raw;
      continue;
    }
    if (typeof raw === 'object') {
      const cond = raw as Record<string, unknown>;
      const op = String(cond.op || 'contains');
      const value = cond.value;
      switch (op) {
        case 'eq': where[k] = isNumericLike(value) ? Number(value) : value; break;
        case 'neq': /* not supported by BaseModel directly — emulate with raw */ where[k] = value; break;
        case 'contains':
          if (value !== undefined) where[k] = { like: `%${value}%` };
          break;
        case 'startsWith':
          if (value !== undefined) where[k] = { like: `${value}%` };
          break;
        case 'endsWith':
          if (value !== undefined) where[k] = { like: `%${value}` };
          break;
        case 'gt': where[k] = { gt: isNumericLike(value) ? Number(value) : value as string }; break;
        case 'gte': where[k] = { gte: isNumericLike(value) ? Number(value) : value as string }; break;
        case 'lt': where[k] = { lt: isNumericLike(value) ? Number(value) : value as string }; break;
        case 'lte': where[k] = { lte: isNumericLike(value) ? Number(value) : value as string }; break;
        case 'between': {
          const min = cond.min;
          const max = cond.max;
          if (min !== undefined && min !== '') where[k] = { gte: isNumericLike(min) ? Number(min) : min as string };
          if (max !== undefined && max !== '') {
            const w = (where[k] as Record<string, unknown>) || {};
            w.lte = isNumericLike(max) ? Number(max) : max as string;
            where[k] = w;
          }
          break;
        }
        case 'in': {
          const arr = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
          if (arr.length) where[k] = { in: arr.map(v => isNumericLike(v) ? Number(v) : v) };
          break;
        }
      }
    }
  }
  return where;
}

export default async function dataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/data/:moduleName — list (page, pageSize, orderBy, filter[field]=v)
  app.get('/api/data/:moduleName', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };
    const q = request.query as Record<string, unknown>;
    const page = Number(q.page) || 1;
    const pageSize = Math.min(Number(q.pageSize) || 20, 500);
    let orderBy = typeof q.orderBy === 'string' ? q.orderBy : undefined;
    // Normalize '+' as space (in case encoded as %2B)
    if (orderBy) orderBy = orderBy.replace(/\+/g, ' ');
    const where = filterToWhere(parseFilter(q));

    try {
      const result = await manageData(userId, 'list', moduleName, undefined, {
        page, pageSize, orderBy, where,
      });
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /api/data/:moduleName — create
  app.post('/api/data/:moduleName', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };
    const data = request.body as Record<string, unknown>;
    try {
      const result = await manageData(userId, 'insert', moduleName, data);
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // PUT /api/data/:moduleName/:id — update
  app.put('/api/data/:moduleName/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName, id } = request.params as { moduleName: string; id: string };
    const data = request.body as Record<string, unknown>;
    try {
      const result = await manageData(userId, 'update', moduleName, data, { id: Number(id) });
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // DELETE /api/data/:moduleName/:id — delete one
  app.delete('/api/data/:moduleName/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName, id } = request.params as { moduleName: string; id: string };
    try {
      const result = await manageData(userId, 'delete', moduleName, undefined, { id: Number(id) });
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /api/data/:moduleName/batch-delete — batch delete
  app.post('/api/data/:moduleName/batch-delete', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };
    const { ids } = (request.body || {}) as { ids?: number[] };
    try {
      const result = await manageData(userId, 'batch_delete', moduleName, undefined, { ids });
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /api/data/:moduleName/clear — clear all
  app.post('/api/data/:moduleName/clear', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };
    try {
      const result = await manageData(userId, 'clear', moduleName);
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /api/data/:moduleName/bulk-generate — bulk generate
  app.post('/api/data/:moduleName/bulk-generate', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };
    const { count, rules } = (request.body || {}) as { count?: number; rules?: Record<string, FieldRule> };
    try {
      const result = await manageData(userId, 'bulk_generate', moduleName, undefined, { count, rules });
      return success(result);
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  });
}
