import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../core/database.js';
import { users } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { generateApiKey } from '../core/api-key.js';
import { success } from '../core/response.js';

export default async function apiKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/users/me/api-key — 查询当前用户的 MCP API Key 状态
  app.get('/api/users/me/api-key', async (request) => {
    const userId = request.user!.id;
    const row = db.select({
      hasKey: users.apiKeyHash,
      createdAt: users.apiKeyCreatedAt,
      lastUsedAt: users.apiKeyLastUsedAt,
    }).from(users).where(eq(users.id, userId)).get();

    return success({
      hasKey: !!row?.hasKey,
      createdAt: row?.createdAt || null,
      lastUsedAt: row?.lastUsedAt || null,
    });
  });

  // POST /api/users/me/api-key — 生成/重置 API Key，明文仅此一次返回
  app.post('/api/users/me/api-key', async (request) => {
    const userId = request.user!.id;
    const { plain, hash } = generateApiKey();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.update(users).set({
      apiKeyHash: hash,
      apiKeyCreatedAt: now,
      apiKeyLastUsedAt: null,
      updatedAt: now,
    }).where(eq(users.id, userId)).run();

    return success({ apiKey: plain, createdAt: now }, 'API key generated');
  });

  // DELETE /api/users/me/api-key — 吊销
  app.delete('/api/users/me/api-key', async (request) => {
    const userId = request.user!.id;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.update(users).set({
      apiKeyHash: null,
      apiKeyCreatedAt: null,
      apiKeyLastUsedAt: null,
      updatedAt: now,
    }).where(eq(users.id, userId)).run();
    return success(null, 'API key revoked');
  });
}
