/**
 * Chat API — 事件日志 / 可恢复订阅架构
 *
 * Endpoints:
 *   POST /api/chat             — 启动新一轮生成（含 user 消息），立即返回 meta + 流
 *   GET  /api/chat/stream      — 纯订阅流（afterSeq 断点续播），不启动新生成
 *   POST /api/chat/pause       — 暂停当前生成（保留已产生内容）
 *   POST /api/chat/read        — 清除会话未读标记
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../core/auth.js';
import { db } from '../core/database.js';
import { sessions } from '../core/schema.js';
import { eq, and } from 'drizzle-orm';
import { ChatRunner, type StreamEvent } from '../agent/chat-runner.js';

function writeEvent(reply: FastifyReply, ev: StreamEvent | { type: string; [k: string]: unknown }): boolean {
  try {
    reply.raw.write(JSON.stringify(ev) + '\n');
    return true;
  } catch {
    return false;
  }
}

function setStreamHeaders(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
}

async function streamSubscribe(
  runner: ChatRunner,
  afterSeq: number,
  reply: FastifyReply,
  request: FastifyRequest,
): Promise<void> {
  let clientAlive = true;
  const onClose = () => { clientAlive = false; };
  request.raw.once('close', onClose);

  try {
    for await (const ev of runner.subscribe(afterSeq)) {
      if (!clientAlive) break;
      const ok = writeEvent(reply, ev);
      if (!ok) break;
    }
  } finally {
    request.raw.removeListener('close', onClose);
    try { reply.raw.end(); } catch {}
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ---------- POST /api/chat ----------
  app.post('/api/chat', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as {
      sessionId: string;
      content?: string;
      message?: string; // backward-compat alias
      attachments?: unknown[];
      // legacy shape: messages: [{ role, content }]
      messages?: { role: string; content: string }[];
    };

    if (!body.sessionId) {
      return reply.status(400).send({ success: false, message: 'sessionId required' });
    }

    // Derive user content
    let userContent = body.content ?? body.message ?? '';
    if (!userContent && Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
      if (lastUser) userContent = lastUser.content;
    }
    if (!userContent) {
      return reply.status(400).send({ success: false, message: 'content required' });
    }

    // Validate session ownership
    const sess = db.select().from(sessions)
      .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, userId)))
      .get();
    if (!sess) return reply.status(404).send({ success: false, message: 'Session not found' });

    const runner = ChatRunner.getOrCreate(body.sessionId);

    let meta: { userMessageId: number; assistantMessageId: number; startSeq: number };
    try {
      meta = await runner.start({ userId, userContent, attachments: body.attachments });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : 'Failed to start';
      const status = msg === 'Session already running' ? 409 : 500;
      return reply.status(status).send({ success: false, message: msg });
    }

    // Stream events starting just before startSeq - 1 (include user event)
    setStreamHeaders(reply);
    writeEvent(reply, { type: 'meta', ...meta });

    await streamSubscribe(runner, meta.startSeq - 1, reply, request);
  });

  // ---------- GET /api/chat/stream?sessionId=...&afterSeq=N ----------
  app.get('/api/chat/stream', async (request, reply) => {
    const userId = request.user!.id;
    const q = request.query as { sessionId?: string; afterSeq?: string };
    if (!q.sessionId) {
      return reply.status(400).send({ success: false, message: 'sessionId required' });
    }
    const sess = db.select().from(sessions)
      .where(and(eq(sessions.id, q.sessionId), eq(sessions.userId, userId)))
      .get();
    if (!sess) return reply.status(404).send({ success: false, message: 'Session not found' });

    const afterSeq = Math.max(0, Number(q.afterSeq) || 0);
    const runner = ChatRunner.get(q.sessionId);

    setStreamHeaders(reply);
    writeEvent(reply, { type: 'meta', runStatus: sess.runStatus ?? 'idle', lastSeq: sess.lastSeq ?? 0 });

    if (runner) {
      await streamSubscribe(runner, afterSeq, reply, request);
    } else {
      // No live runner: replay DB history, then synthesize a terminal event if the
      // last event in the log isn't already terminal (prevents frontend from hanging
      // on a "进行中..." state for sessions interrupted by a server restart).
      const { sqlite } = await import('../core/database.js');
      const rows = sqlite.prepare(
        `SELECT seq, type, payload, created_at FROM message_events
         WHERE session_id = ? AND seq > ? ORDER BY seq`
      ).all(q.sessionId, afterSeq) as { seq: number; type: string; payload: string; created_at: string }[];
      let lastType: string | undefined;
      let lastSeq = afterSeq;
      for (const r of rows) {
        let payload: unknown = {};
        try { payload = JSON.parse(r.payload); } catch {}
        writeEvent(reply, { seq: r.seq, type: r.type as any, payload: payload as any, createdAt: r.created_at });
        lastType = r.type;
        lastSeq = r.seq;
      }
      const isTerminal = lastType && ['done', 'error', 'aborted', 'paused'].includes(lastType);
      if (!isTerminal && rows.length > 0) {
        // synthetic terminal so client can collapse "进行中" UI
        writeEvent(reply, {
          seq: lastSeq + 1,
          type: 'aborted',
          payload: { reason: 'no_live_runner_on_replay' },
        });
      }
      try { reply.raw.end(); } catch {}
    }
  });

  // ---------- POST /api/chat/pause ----------
  app.post('/api/chat/pause', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ success: false, message: 'sessionId required' });
    }
    const sess = db.select().from(sessions)
      .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, userId)))
      .get();
    if (!sess) return reply.status(404).send({ success: false, message: 'Session not found' });

    const runner = ChatRunner.get(body.sessionId);
    if (!runner || !runner.isLive()) {
      return reply.send({ success: true, message: 'Not running' });
    }
    runner.pause();
    return reply.send({ success: true });
  });

  // ---------- POST /api/chat/read ----------
  app.post('/api/chat/read', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ success: false, message: 'sessionId required' });
    }
    const sess = db.select().from(sessions)
      .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, userId)))
      .get();
    if (!sess) return reply.status(404).send({ success: false, message: 'Session not found' });

    db.update(sessions).set({ hasUnread: 0 }).where(eq(sessions.id, body.sessionId)).run();
    return reply.send({ success: true });
  });
}
