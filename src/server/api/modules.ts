import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { db } from '../core/database.js';
import { modules } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';

const GENERATED_DIR = resolve('generated');

export default async function moduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/modules
  app.get('/api/modules', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(modules)
      .where(eq(modules.userId, userId))
      .all();

    // Enrich with _meta.json data if available
    const enriched = result.map(m => {
      const metaPath = join(GENERATED_DIR, String(userId), m.name, '_meta.json');
      let meta = null;
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        } catch { /* ignore */ }
      }
      return { ...m, meta };
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

    return success({ ...mod, meta });
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
}
