import type { FastifyReply } from 'fastify';

export function success(data: unknown, message?: string) {
  return { success: true, data, message };
}

export function paginated(list: unknown[], total: number, page: number, pageSize: number) {
  return { success: true, data: { list, total, page, pageSize } };
}

export function error(reply: FastifyReply, code: number, message: string) {
  return reply.status(code).send({ success: false, message });
}
