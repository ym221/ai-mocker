import type { FastifyInstance } from 'fastify';
import { pipeTextStreamToResponse } from 'ai';
import { authMiddleware } from '../core/auth.js';
import { runAgent } from '../agent/agent-runner.js';

export default async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /api/chat — SSE text stream
  app.post('/api/chat', async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as {
      sessionId: string;
      messages: { role: string; content: string }[];
    };

    if (!body.sessionId || !body.messages?.length) {
      return reply.status(400).send({ success: false, message: 'sessionId and messages required' });
    }

    try {
      const result = await runAgent({
        sessionId: body.sessionId,
        userId,
        userMessages: body.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      // Pipe text stream to response — useChat in compatible mode will read this
      pipeTextStreamToResponse({
        response: reply.raw,
        textStream: result.textStream,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI service error';
      if (!reply.raw.headersSent) {
        return reply.status(502).send({ success: false, message });
      }
    }
  });
}
