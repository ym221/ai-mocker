import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../core/auth.js';
import { runAgent } from '../agent/agent-runner.js';

export default async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /api/chat — SSE streaming
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

      // Return SSE stream
      reply.raw.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = result.textStream;
      for await (const chunk of reader) {
        reply.raw.write(chunk);
      }

      reply.raw.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI service error';

      // Check if headers already sent
      if (reply.sent) return;

      // Friendly error messages
      if (message.includes('API key') || message.includes('401') || message.includes('Unauthorized')) {
        return reply.status(502).send({ success: false, message: 'AI Provider API Key is invalid. Please check your Provider settings.' });
      }
      if (message.includes('quota') || message.includes('balance') || message.includes('429')) {
        return reply.status(502).send({ success: false, message: 'AI Provider quota exceeded. Please check your balance.' });
      }
      if (message.includes('model') || message.includes('404')) {
        return reply.status(502).send({ success: false, message: 'AI model not available. Please switch to a different model.' });
      }

      return reply.status(500).send({ success: false, message });
    }
  });
}
