import type { FastifyInstance } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { db } from '../core/database.js';
import { presets } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';

export default async function presetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/presets
  app.get('/api/presets', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(presets)
      .where(or(eq(presets.scope, 'public'), eq(presets.ownerId, userId)))
      .all();
    return success(result);
  });

  // POST /api/presets
  app.post('/api/presets', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { name: string; description?: string; content: string; scope?: string };

    if (!body.name || !body.content) {
      return reply.status(400).send({ success: false, message: 'name and content required' });
    }

    const preset = db.insert(presets).values({
      name: body.name,
      description: body.description || null,
      content: body.content,
      scope: body.scope || 'private',
      ownerId: userId,
    }).returning().get();

    return reply.status(201).send(success(preset));
  });

  // PUT /api/presets/:id
  app.put('/api/presets/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;

    const existing = db.select().from(presets).where(eq(presets.id, id)).get();
    if (!existing) return reply.status(404).send({ success: false, message: 'Preset not found' });
    if (existing.ownerId !== userId && request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Permission denied' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.content) updates.content = body.content;
    if (body.scope) updates.scope = body.scope;
    updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.update(presets).set(updates).where(eq(presets.id, id)).run();
    const updated = db.select().from(presets).where(eq(presets.id, id)).get();
    return success(updated);
  });

  // DELETE /api/presets/:id
  app.delete('/api/presets/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = Number((request.params as { id: string }).id);

    const existing = db.select().from(presets).where(eq(presets.id, id)).get();
    if (!existing) return reply.status(404).send({ success: false, message: 'Preset not found' });
    if (existing.ownerId !== userId && request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Permission denied' });
    }

    db.delete(presets).where(eq(presets.id, id)).run();
    return success(null, 'Preset deleted');
  });
}
