import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, or, and, asc } from 'drizzle-orm';
import { db } from '../core/database.js';
import { providers, providerModels } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { encrypt, decrypt } from '../core/encryption.js';
import { testProvider } from '../agent/lib/test-provider.js';

/** 用户能看到这个 provider 吗?public 或自己 owner */
function canRead(p: { scope: string; ownerId: number | null }, userId: number): boolean {
  return p.scope === 'public' || p.ownerId === userId;
}

/** 用户能改/删 这个 provider 的资源吗?owner 或 admin */
function canWrite(p: { scope: string; ownerId: number | null }, userId: number, role: string): boolean {
  return p.ownerId === userId || role === 'admin';
}

/** 加载 provider 并做基础 ACL 检查;返回 reply 表示拒绝;返回 provider 表示通过 */
function loadProvider(id: number, request: FastifyRequest, reply: FastifyReply, requireWrite = false) {
  const p = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!p) { reply.status(404).send({ success: false, message: 'Provider not found' }); return null; }
  const userId = request.user!.id;
  const role = request.user!.role;
  if (!canRead(p, userId)) { reply.status(403).send({ success: false, message: 'Permission denied' }); return null; }
  if (requireWrite && !canWrite(p, userId, role)) {
    reply.status(403).send({ success: false, message: 'Permission denied (write)' });
    return null;
  }
  return p;
}

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

    // 首个自动 default:同步插入 provider_models 一条,modelName=defaultModel
    try {
      db.insert(providerModels).values({
        providerId: provider.id,
        modelName: body.defaultModel,
        note: null,
      }).run();
    } catch { /* 极小概率重复 — 忽略 */ }

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

  // ==========================================
  //          PROVIDER MODELS (preset list)
  // ==========================================

  // GET /api/providers/:id/models — 列出该 provider 的预置模型
  app.get('/api/providers/:id/models', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const p = loadProvider(id, request, reply);
    if (!p) return;
    const rows = db.select().from(providerModels)
      .where(eq(providerModels.providerId, id))
      .orderBy(asc(providerModels.id))
      .all();
    return success(rows.map(r => ({
      id: r.id,
      providerId: r.providerId,
      modelName: r.modelName,
      note: r.note,
      isVerified: r.isVerified,
      lastVerifiedAt: r.lastVerifiedAt,
      lastVerifiedError: r.lastVerifiedError,
      isDefault: r.modelName === p.defaultModel,
    })));
  });

  // POST /api/providers/:id/models — 添加一个预置模型;首个自动 default
  app.post('/api/providers/:id/models', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const p = loadProvider(id, request, reply, /* requireWrite */ true);
    if (!p) return;
    const body = request.body as { modelName?: string; note?: string };
    if (!body.modelName || !body.modelName.trim()) {
      return reply.status(400).send({ success: false, message: 'modelName required' });
    }
    const modelName = body.modelName.trim();
    // 已存在?
    const existing = db.select().from(providerModels)
      .where(and(eq(providerModels.providerId, id), eq(providerModels.modelName, modelName)))
      .get();
    if (existing) {
      return reply.status(409).send({ success: false, message: '该模型已存在', data: existing });
    }
    const inserted = db.insert(providerModels).values({
      providerId: id,
      modelName,
      note: body.note?.trim() || null,
    }).returning().get();
    // 首个 model → 自动 default
    const total = db.select().from(providerModels).where(eq(providerModels.providerId, id)).all().length;
    if (total === 1) {
      db.update(providers).set({ defaultModel: modelName }).where(eq(providers.id, id)).run();
    }
    return reply.status(201).send(success({
      ...inserted,
      isDefault: total === 1,
    }));
  });

  // PUT /api/providers/:id/models/:modelId — 改名 或 改备注
  app.put('/api/providers/:id/models/:modelId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const modelId = Number((request.params as { modelId: string }).modelId);
    const p = loadProvider(id, request, reply, true);
    if (!p) return;
    const m = db.select().from(providerModels)
      .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, id)))
      .get();
    if (!m) return reply.status(404).send({ success: false, message: 'Model not found' });

    const body = request.body as { modelName?: string; note?: string };
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) };
    let renamedTo: string | null = null;
    if (body.modelName !== undefined) {
      const newName = body.modelName.trim();
      if (!newName) return reply.status(400).send({ success: false, message: 'modelName cannot be empty' });
      if (newName !== m.modelName) {
        // 重名检查
        const dup = db.select().from(providerModels)
          .where(and(eq(providerModels.providerId, id), eq(providerModels.modelName, newName)))
          .get();
        if (dup) return reply.status(409).send({ success: false, message: '该模型名已存在' });
        updates.modelName = newName;
        renamedTo = newName;
      }
    }
    if (body.note !== undefined) updates.note = body.note?.trim() || null;
    db.update(providerModels).set(updates).where(eq(providerModels.id, modelId)).run();

    // 若改的是 default 的名,同步更新 providers.defaultModel
    if (renamedTo && p.defaultModel === m.modelName) {
      db.update(providers).set({ defaultModel: renamedTo }).where(eq(providers.id, id)).run();
    }
    const fresh = db.select().from(providerModels).where(eq(providerModels.id, modelId)).get();
    const fresh_p = db.select().from(providers).where(eq(providers.id, id)).get();
    return success({ ...fresh, isDefault: fresh?.modelName === fresh_p?.defaultModel });
  });

  // DELETE /api/providers/:id/models/:modelId
  // 规则:只剩 1 条拒绝;删的是 default → fallback 到剩余的 verified 第一个 / 否则第一个
  app.delete('/api/providers/:id/models/:modelId', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const modelId = Number((request.params as { modelId: string }).modelId);
    const p = loadProvider(id, request, reply, true);
    if (!p) return;
    const m = db.select().from(providerModels)
      .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, id)))
      .get();
    if (!m) return reply.status(404).send({ success: false, message: 'Model not found' });

    const all = db.select().from(providerModels)
      .where(eq(providerModels.providerId, id))
      .orderBy(asc(providerModels.id))
      .all();
    if (all.length <= 1) {
      return reply.status(400).send({ success: false, message: '至少保留一个模型,不能删除' });
    }
    // 删的是 default? → 选 fallback(verified 优先)
    if (p.defaultModel === m.modelName) {
      const remaining = all.filter(x => x.id !== modelId);
      const fallback = remaining.find(x => x.isVerified === 1) || remaining[0];
      db.update(providers).set({ defaultModel: fallback.modelName }).where(eq(providers.id, id)).run();
    }
    db.delete(providerModels).where(eq(providerModels.id, modelId)).run();
    syncProviderVerifiedFromDefaultModel(id);
    return success(null, '已删除');
  });

  /**
   * 联动:provider.is_verified 反映"它的 default model 是否测试通过"。
   * - default model 的 isVerified=1 → providers.is_verified=1
   * - default model 的 isVerified=0(测失败 或 未测) → providers.is_verified=0
   * 在 model test / set-default / delete 后调用。
   */
  function syncProviderVerifiedFromDefaultModel(providerId: number) {
    const p = db.select().from(providers).where(eq(providers.id, providerId)).get();
    if (!p) return;
    const defaultModel = db.select().from(providerModels)
      .where(and(eq(providerModels.providerId, providerId), eq(providerModels.modelName, p.defaultModel)))
      .get();
    const verified = defaultModel?.isVerified === 1 ? 1 : 0;
    if (p.isVerified !== verified) {
      db.update(providers).set({ isVerified: verified }).where(eq(providers.id, providerId)).run();
    }
  }

  // POST /api/providers/:id/models/:modelId/test — 测试该 model 连通性
  // 任何能看到 provider 的用户都能测,结果写回 db(共享给 public provider 全部可见用户)
  app.post('/api/providers/:id/models/:modelId/test', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const modelId = Number((request.params as { modelId: string }).modelId);
    const p = loadProvider(id, request, reply); // read 即可,test 不算"改配置"
    if (!p) return;
    const m = db.select().from(providerModels)
      .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, id)))
      .get();
    if (!m) return reply.status(404).send({ success: false, message: 'Model not found' });

    let apiKey = '';
    if (p.apiKeyEncrypted) {
      try { apiKey = decrypt(p.apiKeyEncrypted); }
      catch {
        return reply.status(200).send(success({ ok: false, errorCode: 'API_KEY_INVALID', errorMessage: '解密失败', latencyMs: 0, gotText: false, gotToolCall: false }));
      }
    }
    const result = await testProvider({
      type: p.type,
      apiKey,
      baseUrl: p.baseUrl,
      modelName: m.modelName,
    });
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.update(providerModels).set({
      isVerified: result.ok ? 1 : 0,
      lastVerifiedAt: now,
      lastVerifiedError: result.ok ? null : `[${result.errorCode || 'UNKNOWN'}] ${result.errorMessage || ''}`.slice(0, 500),
      updatedAt: now,
    }).where(eq(providerModels.id, modelId)).run();
    // 联动:若该 model 是 provider 的 default,同步 provider.is_verified
    syncProviderVerifiedFromDefaultModel(id);
    return reply.status(200).send(success(result));
  });

  // POST /api/providers/:id/models/:modelId/set-default — 设该 model 为 provider 的默认
  app.post('/api/providers/:id/models/:modelId/set-default', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const modelId = Number((request.params as { modelId: string }).modelId);
    const p = loadProvider(id, request, reply, true);
    if (!p) return;
    const m = db.select().from(providerModels)
      .where(and(eq(providerModels.id, modelId), eq(providerModels.providerId, id)))
      .get();
    if (!m) return reply.status(404).send({ success: false, message: 'Model not found' });
    db.update(providers).set({ defaultModel: m.modelName }).where(eq(providers.id, id)).run();
    syncProviderVerifiedFromDefaultModel(id);
    return success({ defaultModel: m.modelName });
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
