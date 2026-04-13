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

    let result;
    try {
      result = await runAgent({
        sessionId: body.sessionId,
        userId,
        userMessages: body.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }

    // Buffer the full text, then decide how to respond
    // This way we can return a proper error status if the AI call fails
    let fullText = '';
    let streamError: Error | null = null;

    try {
      // Use fullStream to catch errors from the AI SDK
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullText += part.textDelta;
        }
        // Ignore tool calls and other parts for now
      }
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
    }

    if (streamError) {
      return sendError(reply, streamError);
    }

    if (!fullText) {
      // Try to get any text from the result
      try {
        fullText = await result.text || '';
      } catch {
        // ignore
      }
    }

    if (!fullText) {
      return reply.status(502).send({
        success: false,
        message: 'AI returned empty response. Please check Provider configuration.',
      });
    }

    return reply.send({ success: true, data: fullText });
  });
}

function friendlyError(message: string): string {
  if (message.includes('API key') || message.includes('401') || message.includes('Unauthorized') || message.includes('missing or invalid')) {
    return 'AI Provider API Key is invalid or missing. Please go to Settings to configure your Provider.';
  }
  if (message.includes('quota') || message.includes('balance') || message.includes('429')) {
    return 'AI Provider quota exceeded. Please check your balance.';
  }
  if (message.includes('model') || message.includes('not found')) {
    return 'AI model not available. Please switch to a different model.';
  }
  return message;
}

function sendError(reply: any, err: unknown) {
  const message = err instanceof Error ? err.message : 'AI service error';
  const friendly = friendlyError(message);
  const status = message.includes('401') || message.includes('API key') || message.includes('missing or invalid') ? 502 : 500;
  return reply.status(status).send({ success: false, message: friendly });
}
