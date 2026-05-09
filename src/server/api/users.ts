import type { FastifyInstance } from 'fastify';
import { db } from '../core/database.js';
import { users, providers } from '../core/schema.js';
import { eq } from 'drizzle-orm';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/users/me/preferences — 当前登录用户的偏好(默认 provider 等)
  app.get('/api/users/me/preferences', async (request) => {
    const userId = request.user!.id;
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    return success({
      defaultProviderId: u?.defaultProviderId ?? null,
    });
  });

  // PUT /api/users/me/preferences — 更新偏好(可设 null 取消默认)
  app.put('/api/users/me/preferences', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { defaultProviderId?: number | null };
    if (body.defaultProviderId !== undefined && body.defaultProviderId !== null) {
      // 校验 provider 存在 + 用户能看到
      const p = db.select().from(providers).where(eq(providers.id, body.defaultProviderId)).get();
      if (!p) return reply.status(404).send({ success: false, message: 'Provider not found' });
      if (p.scope === 'private' && p.ownerId !== userId) {
        return reply.status(403).send({ success: false, message: '不能将他人私有 provider 设为默认' });
      }
    }
    db.update(users).set({
      defaultProviderId: body.defaultProviderId ?? null,
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    }).where(eq(users.id, userId)).run();
    const fresh = db.select().from(users).where(eq(users.id, userId)).get();
    return success({ defaultProviderId: fresh?.defaultProviderId ?? null });
  });

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
