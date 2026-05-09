import type { FastifyInstance } from 'fastify';
import { db } from '../core/database.js';
import { users, providers } from '../core/schema.js';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';

/**
 * 系统超级管理员保护:id=1(seed 创建)是不可降级 / 不可禁用 / 不可删除的根账户。
 * 加这一层后端拦截避免前端漏渲染按钮时被绕过。
 */
function isProtectedSuperAdmin(userId: number): boolean {
  return userId === 1;
}

/** 返回当前 active admin 数量 */
function activeAdminCount(): number {
  const rows = db.select({ id: users.id }).from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, 1))).all();
  return rows.length;
}

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

    // 系统超级管理员(id=1)保护
    if (isProtectedSuperAdmin(id)) {
      if (body.role && body.role !== 'admin') {
        return reply.status(400).send({ success: false, message: '系统管理员账户不能降级' });
      }
      if (body.isActive !== undefined && body.isActive !== 1 && body.isActive !== true) {
        return reply.status(400).send({ success: false, message: '系统管理员账户不能禁用' });
      }
    }

    // 防止"最后一个 admin"被自己降级/禁用导致系统无 admin
    const target = db.select().from(users).where(eq(users.id, id)).get();
    if (target && target.role === 'admin' && target.isActive === 1) {
      const downgrade = body.role && body.role !== 'admin';
      const deactivate = body.isActive !== undefined && body.isActive !== 1 && body.isActive !== true;
      if ((downgrade || deactivate) && activeAdminCount() <= 1) {
        return reply.status(400).send({ success: false, message: '至少保留一个活跃管理员' });
      }
    }

    const updates: Record<string, unknown> = {};
    if (body.role) updates.role = body.role;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.update(users).set(updates).where(eq(users.id, id)).run();
    return success(null, 'User updated');
  });

  // POST /api/users — admin 新增用户
  app.post('/api/users', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Admin access required' });
    }
    const body = request.body as { username?: string; password?: string; displayName?: string; role?: string };
    if (!body.username || !body.password) {
      return reply.status(400).send({ success: false, message: 'username 与 password 必填' });
    }
    if (body.password.length < 6) {
      return reply.status(400).send({ success: false, message: 'password 至少 6 位' });
    }
    const existing = db.select({ id: users.id }).from(users).where(eq(users.username, body.username)).get();
    if (existing) return reply.status(409).send({ success: false, message: '用户名已存在' });

    const passwordHash = await bcrypt.hash(body.password, 10);
    const inserted = db.insert(users).values({
      username: body.username,
      passwordHash,
      displayName: body.displayName || body.username,
      role: body.role === 'admin' ? 'admin' : 'user',
      isActive: 1,
    }).returning().get();
    return reply.status(201).send(success({
      id: inserted.id,
      username: inserted.username,
      displayName: inserted.displayName,
      role: inserted.role,
      isActive: inserted.isActive,
      createdAt: inserted.createdAt,
    }));
  });

  // DELETE /api/users/:id — admin 删除用户
  app.delete('/api/users/:id', async (request, reply) => {
    if (request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Admin access required' });
    }
    const id = Number((request.params as { id: string }).id);
    if (isProtectedSuperAdmin(id)) {
      return reply.status(400).send({ success: false, message: '系统管理员账户不能删除' });
    }
    if (id === request.user!.id) {
      return reply.status(400).send({ success: false, message: '不能删除自己' });
    }
    const target = db.select().from(users).where(eq(users.id, id)).get();
    if (!target) return reply.status(404).send({ success: false, message: 'User not found' });

    if (target.role === 'admin' && target.isActive === 1 && activeAdminCount() <= 1) {
      return reply.status(400).send({ success: false, message: '至少保留一个活跃管理员' });
    }
    db.delete(users).where(eq(users.id, id)).run();
    return success(null, 'User deleted');
  });
}
