import type { FastifyInstance } from 'fastify';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { authMiddleware } from '../core/auth.js';
import { parseFile } from '../core/file-parser.js';
import { success } from '../core/response.js';

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || './uploads');

export default async function uploadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/api/upload', async (request, reply) => {
    const userId = request.user!.id;
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ success: false, message: 'No file uploaded' });
    }

    const buffer = await data.toBuffer();
    const fileName = data.filename;
    const mimeType = data.mimetype;

    // Save file
    const userDir = join(UPLOAD_DIR, String(userId));
    if (!existsSync(userDir)) {
      mkdirSync(userDir, { recursive: true });
    }

    const savedPath = join(userDir, `${Date.now()}-${fileName}`);
    writeFileSync(savedPath, buffer);

    // Parse file
    const parsed = await parseFile(buffer, mimeType, fileName);

    return success({
      filename: fileName,
      ...parsed,
    });
  });
}
