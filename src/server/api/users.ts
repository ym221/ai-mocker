import type { FastifyInstance } from 'fastify';
import { db } from '../core/database.js';
import { users } from '../core/schema.js';
import { eq } from 'drizzle-orm';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/users (admin only)
  app.get('/api/users', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Admin access required' });
    }
    const result = db.select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    }).from(users).all();
    return success(result);
  });

  // PUT /api/users/:id (admin only)
  app.put('/api/users/:id', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Admin access required' });
    }
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;

    const updates: Record<string, unknown> = {};
    if (body.role) updates.role = body.role;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.update(users).set(updates).where(eq(users.id, id)).run();
    return success(null, 'User updated');
  });
}
