import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../core/database.js';
import { sessions, messages } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { aggregateTimeline } from '../core/timeline-aggregator.js';

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

    const session = db.insert(sessions).values({
      id: randomUUID(),
      title: body.title || '新对话',
      userId,
      providerId: body.providerId || null,
      model: body.model || null,
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
