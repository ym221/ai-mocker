import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq } from 'drizzle-orm';

export async function listModules(userId: number) {
  const result = db.select().from(modules).where(eq(modules.userId, userId)).all();
  return result.map(m => ({
    name: m.name,
    displayName: m.displayName,
    description: m.description,
    basePath: m.basePath,
    status: m.status,
  }));
}
