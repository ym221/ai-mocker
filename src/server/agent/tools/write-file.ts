import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve, normalize } from 'path';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';

const GENERATED_DIR = resolve('generated');

function validatePath(userPath: string, userId: number): string {
  // Prevent directory traversal and absolute paths
  if (userPath.includes('..') || /^[/\\]/.test(userPath) || /^[a-zA-Z]:/.test(userPath)) {
    throw new Error('Invalid path: directory traversal or absolute paths are not allowed');
  }

  const fullPath = resolve(join(GENERATED_DIR, String(userId), userPath));
  const expectedPrefix = resolve(join(GENERATED_DIR, String(userId)));

  if (!fullPath.startsWith(expectedPrefix)) {
    throw new Error('Invalid path: must be within generated/{userId}/ directory');
  }

  return fullPath;
}

export async function writeFile(userId: number, path: string, content: string): Promise<string> {
  const fullPath = validatePath(path, userId);

  // Ensure directory exists
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write file
  writeFileSync(fullPath, content, 'utf-8');

  // Auto-execute SQL files
  if (path.endsWith('.sql')) {
    try {
      // 注入 userId 前缀：mock__{suffix} → mock__{userId}_{suffix}
      // 匹配标识符中的 mock__xxx（反引号包裹或裸名）
      const injectedSql = content
        .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${userId}_$1\``)
        .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${userId}_$1`);
      sqlite.exec(injectedSql);
      return `File written and SQL executed: ${path}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `File written but SQL execution failed: ${errMsg}. Please fix the SQL and try again.`;
    }
  }

  // Auto-sync _meta.json to modules table
  if (path.endsWith('_meta.json')) {
    try {
      const meta = JSON.parse(content);
      const moduleName = meta.name;
      const existing = db.select().from(modules)
        .where(and(eq(modules.name, moduleName), eq(modules.userId, userId)))
        .get();

      if (existing) {
        // Preserve transient 'creating'/'editing' status — finalize() will flip to 'active'
        const preserveStatus = existing.status === 'creating' || existing.status === 'editing';
        const updateValues: Record<string, unknown> = {
          displayName: meta.displayName || moduleName,
          description: meta.description || '',
          basePath: meta.basePath || `/mock/${moduleName}`,
          updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        };
        if (!preserveStatus) updateValues.status = meta.status || 'active';
        db.update(modules).set(updateValues as any).where(eq(modules.id, existing.id)).run();
      } else {
        db.insert(modules).values({
          name: moduleName,
          userId,
          displayName: meta.displayName || moduleName,
          description: meta.description || '',
          basePath: meta.basePath || `/mock/${moduleName}`,
          status: meta.status || 'active',
        }).run();
      }
    } catch {
      // Non-critical: meta sync failed but file was written
    }
  }

  return `File written: ${path}`;
}
