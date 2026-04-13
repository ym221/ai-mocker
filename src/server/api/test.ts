import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { runTest } from '../agent/tools/run-test.js';

export default async function testRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /api/test/:moduleName
  app.post('/api/test/:moduleName', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName } = request.params as { moduleName: string };

    try {
      const result = await runTest(userId, moduleName);
      return success(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, message: msg });
    }
  });
}
