import { resolve, join } from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';

const GENERATED_DIR = resolve('generated');

export async function deleteModule(userId: number, moduleName: string): Promise<string> {
  const moduleDir = join(GENERATED_DIR, String(userId), moduleName);

  // 1. Drop mock data tables
  const metaPath = join(moduleDir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      for (const entity of meta.entities || []) {
        const tableName = `mock__${userId}_${entity.name}`;
        try {
          sqlite.exec(`DROP TABLE IF EXISTS \`${tableName}\``);
        } catch {
          // Non-critical
        }
      }
    } catch {
      // Non-critical
    }
  }

  // 2. Delete generated files
  if (existsSync(moduleDir)) {
    rmSync(moduleDir, { recursive: true, force: true });
  }

  // 3. Delete from modules system table
  db.delete(modules)
    .where(and(eq(modules.name, moduleName), eq(modules.userId, userId)))
    .run();

  return `Module "${moduleName}" deleted successfully`;
}
