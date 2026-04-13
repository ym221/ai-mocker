import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { manageData } from '../agent/tools/manage-data.js';

export default async function dataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /api/data/:moduleName/:action
  app.post('/api/data/:moduleName/:action', async (request, reply) => {
    const userId = request.user!.id;
    const { moduleName, action } = request.params as { moduleName: string; action: string };
    const body = request.body as Record<string, unknown>;

    try {
      const result = await manageData(userId, action, moduleName, body.data as Record<string, unknown>, {
        count: body.count as number,
        id: body.id as number,
        entityName: body.entityName as string,
      });
      return success(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, message: msg });
    }
  });
}
