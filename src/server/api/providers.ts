import type { FastifyInstance } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { db } from '../core/database.js';
import { providers } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { encrypt, decrypt } from '../core/encryption.js';
import { testProvider } from '../agent/lib/test-provider.js';

export default async function providerRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', authMiddleware);

  // GET /api/providers — list public + own private
  app.get('/api/providers', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(providers)
      .where(or(eq(providers.scope, 'public'), eq(providers.ownerId, userId)))
      .all();

    // Don't expose encrypted API keys
    const safe = result.map(p => ({
      ...p,
      apiKeyEncrypted: p.apiKeyEncrypted ? '***' : null,
    }));
    return success(safe);
  });

  // POST /api/providers — create
  app.post('/api/providers', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as {
      name: string; type: string; apiKey?: string; baseUrl?: string;
      defaultModel: string; scope?: string;
    };

    if (!body.name || !body.type || !body.defaultModel) {
      return reply.status(400).send({ success: false, message: 'name, type, defaultModel required' });
    }

    const provider = db.insert(providers).values({
      name: body.name,
      type: body.type,
      apiKeyEncrypted: body.apiKey ? encrypt(body.apiKey) : null,
      baseUrl: body.baseUrl || null,
      defaultModel: body.defaultModel,
      scope: body.scope || 'private',
      ownerId: userId,
    }).returning().get();

    return reply.status(201).send(success({
      ...provider,
      apiKeyEncrypted: provider.apiKeyEncrypted ? '***' : null,
    }));
  });

  // PUT /api/providers/:id — update
  app.put('/api/providers/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;

    const existing = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Provider not found' });
    }
    if (existing.ownerId !== userId && request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Permission denied' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name) updates.name = body.name;
    if (body.type) updates.type = body.type;
    if (body.apiKey) updates.apiKeyEncrypted = encrypt(body.apiKey as string);
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.defaultModel) updates.defaultModel = body.defaultModel;
    if (body.scope) updates.scope = body.scope;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.update(providers).set(updates).where(eq(providers.id, id)).run();
    const updated = db.select().from(providers).where(eq(providers.id, id)).get();
    return success({ ...updated, apiKeyEncrypted: updated?.apiKeyEncrypted ? '***' : null });
  });

  // POST /api/providers/test —— 测试草稿配置(表单内容,未保存)
  app.post('/api/providers/test', async (request, reply) => {
    const body = request.body as {
      type?: string; baseUrl?: string | null; apiKey?: string; defaultModel?: string;
      modelName?: string;
    };
    const result = await testProvider({
      type: body.type || 'openai',
      apiKey: body.apiKey || '',
      baseUrl: body.baseUrl ?? null,
      modelName: body.modelName || body.defaultModel || '',
    });
    // 200 即使 ok=false —— 这是验证结果不是 HTTP error;前端按 result.ok 判断
    return reply.status(200).send(success(result));
  });

  // POST /api/providers/:id/test —— 测试已保存的 provider,顺便更新 is_verified + last_verified_*
  app.post('/api/providers/:id/test', async (request, reply) => {
    const userId = request.user!.id;
    const id = Number((request.params as { id: string }).id);

    const existing = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) return reply.status(404).send({ success: false, message: 'Provider not found' });
    if (existing.scope === 'private' && existing.ownerId !== userId && request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Permission denied' });
    }

    let apiKey = '';
    if (existing.apiKeyEncrypted) {
      try { apiKey = decrypt(existing.apiKeyEncrypted); }
      catch { return reply.status(200).send(success({ ok: false, errorCode: 'API_KEY_INVALID', errorMessage: '已存的 API Key 解密失败,请重新填写', latencyMs: 0, gotText: false, gotToolCall: false })); }
    }

    const result = await testProvider({
      type: existing.type,
      apiKey,
      baseUrl: existing.baseUrl,
      modelName: existing.defaultModel,
    });

    // 写回 db
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.update(providers).set({
      isVerified: result.ok ? 1 : 0,
      lastVerifiedAt: now,
      lastVerifiedError: result.ok ? null : `[${result.errorCode || 'UNKNOWN'}] ${result.errorMessage || ''}`.slice(0, 500),
    }).where(eq(providers.id, id)).run();

    return reply.status(200).send(success(result));
  });

  // DELETE /api/providers/:id
  app.delete('/api/providers/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = Number((request.params as { id: string }).id);

    const existing = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Provider not found' });
    }
    if (existing.ownerId !== userId && request.user!.role !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Permission denied' });
    }

    db.delete(providers).where(eq(providers.id, id)).run();
    return success(null, 'Provider deleted');
  });
}
