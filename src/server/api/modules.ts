import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { db } from '../core/database.js';
import { modules } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { deleteModule } from '../agent/tools/delete-module.js';
import { computeModuleHealth } from '../core/module-health.js';

const GENERATED_DIR = resolve('generated');

export default async function moduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/modules
  app.get('/api/modules', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(modules)
      .where(eq(modules.userId, userId))
      .all();

    // Enrich with _meta.json data + health; also self-heal transient status
    // (e.g. a 'creating' row whose files are now complete → flip to 'active').
    const enriched = result.map(m => {
      const metaPath = join(GENERATED_DIR, String(userId), m.name, '_meta.json');
      let meta = null;
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        } catch { /* ignore */ }
      }

      const report = computeModuleHealth(userId, m.name);
      let effectiveStatus = m.status;
      // Self-heal: if files are healthy but DB status is stale → promote to active + persist
      if (report.health === 'healthy' && m.status !== 'active') {
        effectiveStatus = 'active';
        // Persist the heal so it doesn't re-compute every request
        try { db.update(modules).set({ status: 'active', errorMessage: null }).where(eq(modules.id, m.id)).run(); } catch {}
      }
      return {
        ...m,
        status: effectiveStatus,
        health: report.health,
        meta,
      };
    });

    return success(enriched);
  });

  // GET /api/modules/:name
  app.get('/api/modules/:name', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;

    const mod = db.select().from(modules)
      .where(and(eq(modules.name, name), eq(modules.userId, userId)))
      .get();
    if (!mod) return reply.status(404).send({ success: false, message: 'Module not found' });

    const metaPath = join(GENERATED_DIR, String(userId), name, '_meta.json');
    let meta = null;
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
    }

    const report = computeModuleHealth(userId, name);
    let effectiveStatus = mod.status;
    if (report.health === 'healthy' && mod.status !== 'active') {
      effectiveStatus = 'active';
      try { db.update(modules).set({ status: 'active', errorMessage: null }).where(eq(modules.id, mod.id)).run(); } catch {}
    }

    return success({ ...mod, status: effectiveStatus, health: report.health, meta });
  });

  // GET /api/modules/:name/context — read _context.md
  app.get('/api/modules/:name/context', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;
    const filePath = join(GENERATED_DIR, String(userId), name, '_context.md');

    if (!existsSync(filePath)) {
      return reply.status(404).send({ success: false, message: 'Context file not found' });
    }
    return success(readFileSync(filePath, 'utf-8'));
  });

  // GET /api/modules/:name/doc — read api-doc.md
  app.get('/api/modules/:name/doc', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;
    const filePath = join(GENERATED_DIR, String(userId), name, 'api-doc.md');

    if (!existsSync(filePath)) {
      return reply.status(404).send({ success: false, message: 'Documentation file not found' });
    }
    return success(readFileSync(filePath, 'utf-8'));
  });

  // DELETE /api/modules/:name — 删除模块（数据库表 + 文件 + modules 记录）
  app.delete('/api/modules/:name', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;

    const mod = db.select().from(modules)
      .where(and(eq(modules.name, name), eq(modules.userId, userId)))
      .get();
    if (!mod) {
      return reply.status(404).send({ success: false, message: '模块不存在' });
    }

    try {
      await deleteModule(userId, name);
      return success(null, '模块已删除');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, message: msg });
    }
  });
}
