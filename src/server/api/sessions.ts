import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../core/database.js';
import { sessions, messages, users, providers, providerModels } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { aggregateTimeline } from '../core/timeline-aggregator.js';

/**
 * 解析创建/更新 session 时的 effective providerId:
 * - 显式传 → 用它
 * - 没传 → 用用户 default_provider_id
 * - 用户没设 → fallback 到 id=1(seed 兜底 provider)
 */
function resolveProviderId(userId: number, explicit: number | null | undefined): number | null {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.defaultProviderId) return user.defaultProviderId;
  // fallback: id=1(server.ts seed 创建的兜底 provider)
  const seed = db.select().from(providers).where(eq(providers.id, 1)).get();
  return seed ? 1 : null;
}

/**
 * 临时模型自动入库:用户在对话中输入了一个 model 但不在 provider_models 列表 → 自动追加。
 * 静默,不报错;is_verified=0,note 标记为对话中临时添加。
 */
function ensureModelInPresets(providerId: number, modelName: string | null | undefined): void {
  if (!modelName || !modelName.trim()) return;
  const trimmed = modelName.trim();
  const existing = db.select().from(providerModels)
    .where(and(eq(providerModels.providerId, providerId), eq(providerModels.modelName, trimmed)))
    .get();
  if (existing) return;
  try {
    db.insert(providerModels).values({
      providerId,
      modelName: trimmed,
      note: '对话中临时添加',
      isVerified: 0,
    }).run();
  } catch { /* 并发同名 INSERT 失败可忽略 */ }
}

export default async function sessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/sessions
  app.get('/api/sessions', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt))
      .all();
    return success(result);
  });

  // POST /api/sessions
  app.post('/api/sessions', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as {
      title?: string; providerId?: number; model?: string;
      presetId?: number; moduleName?: string;
    };

    const providerId = resolveProviderId(userId, body.providerId ?? null);
    // 模型 fallback:body 给了用 body 的;没给且能解析到 provider → 用 provider 默认 model
    let model = body.model || null;
    if (!model && providerId) {
      const p = db.select().from(providers).where(eq(providers.id, providerId)).get();
      if (p?.defaultModel) model = p.defaultModel;
    }
    // 临时模型自动入库
    if (providerId && model) ensureModelInPresets(providerId, model);

    const session = db.insert(sessions).values({
      id: randomUUID(),
      title: body.title || '新对话',
      userId,
      providerId,
      model,
      presetId: body.presetId || null,
      moduleName: body.moduleName || null,
    }).returning().get();

    return reply.status(201).send(success(session));
  });

  // GET /api/sessions/:id — detail + messages
  app.get('/api/sessions/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = (request.params as { id: string }).id;

    const session = db.select().from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .get();
    if (!session) return reply.status(404).send({ success: false, message: 'Session not found' });

    const msgs = db.select().from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(messages.createdAt)
      .all();

    // Parse JSON fields
    const parsedMsgs = msgs.map(m => {
      const safeParse = (s: string | null) => {
        if (!s) return null;
        try { return JSON.parse(s); } catch { return null; }
      };
      return {
        ...m,
        toolCalls: safeParse(m.toolCalls),
        modules: safeParse(m.modules),
        attachments: safeParse(m.attachments),
      };
    });

    return success({ ...session, messages: parsedMsgs });
  });

  // PUT /api/sessions/:id
  app.put('/api/sessions/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = (request.params as { id: string }).id;
    const body = request.body as Record<string, unknown>;

    const session = db.select().from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .get();
    if (!session) return reply.status(404).send({ success: false, message: 'Session not found' });

    const updates: Record<string, unknown> = {};
    if (body.title) updates.title = body.title;
    if (body.providerId !== undefined) updates.providerId = body.providerId;
    if (body.model !== undefined) updates.model = body.model;
    if (body.presetId !== undefined) updates.presetId = body.presetId;
    if (body.moduleName !== undefined) updates.moduleName = body.moduleName;
    updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
    // 临时模型自动入库:effective providerId + effective model
    const effProviderId = (typeof updates.providerId === 'number' ? updates.providerId : null) ?? session.providerId;
    const effModel = (typeof updates.model === 'string' ? updates.model : null) ?? session.model;
    if (effProviderId && effModel) ensureModelInPresets(effProviderId, effModel);

    const updated = db.select().from(sessions).where(eq(sessions.id, id)).get();
    return success(updated);
  });

  // DELETE /api/sessions/:id — cascade deletes messages + events
  app.delete('/api/sessions/:id', async (request, reply) => {
    const userId = request.user!.id;
    const id = (request.params as { id: string }).id;

    const session = db.select().from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .get();
    if (!session) return reply.status(404).send({ success: false, message: 'Session not found' });

    // Stop any active runner BEFORE deleting session (prevents FK violation)
    const { ChatRunner } = await import('../agent/chat-runner.js');
    const runner = ChatRunner.get(id);
    if (runner) {
      runner.pause();
      // Give it a moment to flush
      await new Promise(r => setTimeout(r, 100));
    }

    db.delete(sessions).where(eq(sessions.id, id)).run();
    return success(null, 'Session deleted');
  });

  // GET /api/sessions/:sessionId/timeline — observability/timeline view
  app.get('/api/sessions/:sessionId/timeline', async (request, reply) => {
    const userId = request.user!.id;
    const id = (request.params as { sessionId: string }).sessionId;

    const session = db.select().from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .get();
    if (!session) return reply.status(404).send({ success: false, message: 'Session not found' });

    const summary = aggregateTimeline(id);
    if (!summary) return reply.status(404).send({ success: false, message: 'Session not found' });
    return success(summary);
  });
}
