import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve, normalize } from 'path';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';
import { validateMetaContract, formatContractErrors } from './meta-contract.js';

const GENERATED_DIR = resolve('generated');

/**
 * Parse `CREATE TABLE [IF NOT EXISTS] `name` ( col1 TYPE..., ... )` statements
 * from SQL text. Returns one entry per parsed CREATE TABLE; ignores other DDL.
 *
 * Notes:
 * - `name` may be backtick-quoted or bare.
 * - column definitions are comma-separated at the top level; we naively split
 *   on commas that aren't inside parens. Good enough for the templates AI
 *   emits; SQLite's own parser is the ground truth at exec time.
 */
function parseCreateTables(sql: string): Array<{ table: string; columns: { name: string; def: string }[] }> {
  const out: Array<{ table: string; columns: { name: string; def: string }[] }> = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*;?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const inside = m[2];
    // split on top-level commas
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(inside.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(inside.slice(start));

    const columns: { name: string; def: string }[] = [];
    for (const raw of parts) {
      const p = raw.trim();
      if (!p) continue;
      // skip table-level constraints (PRIMARY KEY (...), UNIQUE (...), FOREIGN KEY ..., CHECK ..., etc.)
      if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(p)) continue;
      // first identifier is the column name (possibly backticked)
      const nameMatch = p.match(/^`?([A-Za-z0-9_]+)`?\s+(.+)$/s);
      if (!nameMatch) continue;
      columns.push({ name: nameMatch[1], def: nameMatch[2] });
    }
    out.push({ table, columns });
  }
  return out;
}

/**
 * Reconcile schema.sql against the existing physical table.
 *
 * Why this exists: AI updates a module by rewriting schema.sql. SQLite's
 * `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists, so
 * new columns silently never get added. The next INSERT against a new column
 * then fails with "no such column", which is exactly what the user reported
 * during MCP testing.
 *
 * Strategy:
 * - Parse the new CREATE TABLE statements.
 * - For each parsed table that already exists, diff columns:
 *     * Columns present in new schema but not in physical table → ALTER TABLE
 *       ADD COLUMN (additive — preserves data, safe).
 *     * Columns present in physical table but not in new schema → leave them
 *       (SQLite < 3.35 has no clean DROP COLUMN; orphaned columns are harmless
 *       and surfacing them as warnings would not block the user).
 *
 * Returns a list of human-readable changes for logging back to the AI.
 */
function reconcileSchemaWithPhysical(injectedSql: string): { altered: string[]; warnings: string[] } {
  const altered: string[] = [];
  const warnings: string[] = [];
  const tables = parseCreateTables(injectedSql);
  for (const t of tables) {
    // Check whether the physical table already exists.
    const existing = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(t.table) as { name: string } | undefined;
    if (!existing) continue; // table didn't exist — exec will create it normally

    // Read its columns
    const physCols = sqlite.prepare(`PRAGMA table_info(\`${t.table}\`)`).all() as Array<{ name: string }>;
    const physNames = new Set(physCols.map(c => c.name));

    for (const col of t.columns) {
      if (!physNames.has(col.name)) {
        // ALTER TABLE ADD COLUMN — strip NOT NULL without DEFAULT (SQLite forbids it)
        let def = col.def.trim().replace(/,\s*$/, '');
        if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)) {
          // Make it NULL-able since existing rows can't satisfy NOT NULL
          def = def.replace(/\bNOT\s+NULL\b/gi, '').replace(/\s+/g, ' ').trim();
          warnings.push(`column ${t.table}.${col.name} added as NULL-able (existing rows can't satisfy NOT NULL without DEFAULT)`);
        }
        try {
          sqlite.exec(`ALTER TABLE \`${t.table}\` ADD COLUMN \`${col.name}\` ${def}`);
          altered.push(`+column ${t.table}.${col.name}`);
        } catch (err) {
          warnings.push(`failed to add column ${t.table}.${col.name}: ${(err as Error).message}`);
        }
      }
    }

    const newColNames = new Set(t.columns.map(c => c.name));
    for (const phys of physCols) {
      if (!newColNames.has(phys.name) && phys.name !== 'id' && phys.name !== 'created_at' && phys.name !== 'updated_at') {
        warnings.push(`physical column ${t.table}.${phys.name} no longer in schema.sql (left in place; SQLite has no safe DROP COLUMN)`);
      }
    }
  }
  return { altered, warnings };
}

/** Exported for unit tests + write-files.ts sharing. */
export function normalizeUserPath(userPath: string): string {
  // AI 经常把完整路径 "generated/<moduleName>/..." 当作 path 传过来。框架的 path
  // 已经默认是 generated/<userId>/ 下的相对路径,再带 generated/ 前缀就会让文件
  // 落到 generated/<userId>/generated/<moduleName>/...,modules 表 _meta.json
  // sync 从 segments[0] 提取的 moduleName 会变成 "generated"。这是真实生产中
  // moyu-claude / claude-sonnet 等高档位模型也会犯的错(它们看到 system prompt 里
  // 提到 "generated/{userId}/" 就以为自己也得带这个前缀)。
  // 修复:静默剥除领头的 generated/ 前缀;只有用户**显式**写 generated/<userId>/...
  // 这种试图越权的情况才会进 validatePath 的 traversal 检查被拒。
  let p = userPath.replace(/\\/g, '/').replace(/^\.\//, '');
  // 剥多余前导 generated/
  p = p.replace(/^(?:generated\/)+/, '');
  return p;
}

function validatePath(userPath: string, userId: number): string {
  const normalized = normalizeUserPath(userPath);

  // Prevent directory traversal and absolute paths
  if (normalized.includes('..') || /^[/\\]/.test(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('Invalid path: directory traversal or absolute paths are not allowed');
  }

  const fullPath = resolve(join(GENERATED_DIR, String(userId), normalized));
  const expectedPrefix = resolve(join(GENERATED_DIR, String(userId)));

  if (!fullPath.startsWith(expectedPrefix)) {
    throw new Error('Invalid path: must be within generated/{userId}/ directory');
  }

  // 告诉调用方:如果做了 normalize(剥前缀),返实际相对 path 供 _meta sync 提取 moduleName
  return fullPath;
}

export async function writeFile(userId: number, path: string, content: string): Promise<string> {
  // 关键:先 normalize(剥 generated/ / 反斜杠归一化),然后整个函数内部都用 normalized
  // path,确保 _meta.json sync 时 segments[0] 拿到的是真正的 moduleName(不是 'generated')。
  path = normalizeUserPath(path);
  const fullPath = validatePath(path, userId);

  // _meta.json 写盘前先做契约硬校验:basePath / endpoints[].path / 名字全局唯一。
  // 任一不合规 → throw,上层 instrument() 转成 tool_result error 给 AI 看修复建议,
  // 绝不让坏 meta 落盘(否则模块永远无法访问)。
  let normalizedContent = content;
  if (path.endsWith('_meta.json')) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2 || segments[segments.length - 1] !== '_meta.json') {
      throw new Error(`_meta.json must be written under a module dir, got "${path}"`);
    }
    const moduleName = segments[0];
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(content); }
    catch (e) { throw new Error(`_meta.json invalid JSON: ${(e as Error).message}`); }

    const check = validateMetaContract(userId, moduleName, parsed);
    if (!check.ok) {
      throw new Error(formatContractErrors(check.errors));
    }
    // 用规范化后的内容(自动填充 name/basePath)写盘
    normalizedContent = JSON.stringify(check.normalizedMeta, null, 2);
  }

  // Ensure directory exists
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write file
  writeFileSync(fullPath, normalizedContent, 'utf-8');

  // Auto-execute SQL files
  if (path.endsWith('.sql')) {
    try {
      // 注入 userId 前缀：mock__{suffix} → mock__{userId}_{suffix}
      // 匹配标识符中的 mock__xxx（反引号包裹或裸名）
      const injectedSql = content
        .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${userId}_$1\``)
        .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${userId}_$1`);
      sqlite.exec(injectedSql);

      // Reconcile schema drift: SQLite's CREATE TABLE IF NOT EXISTS is a no-op
      // when the table already exists, so AI's added columns silently never
      // land. Diff the parsed CREATE TABLE statements against the actual
      // physical columns and ALTER TABLE ADD COLUMN for new ones (additive,
      // preserves data). Removed columns are left in place since SQLite < 3.35
      // has no safe DROP COLUMN; we surface them as warnings only.
      const reconcileReport = reconcileSchemaWithPhysical(injectedSql);
      const parts = [`File written and SQL executed: ${path}`];
      if (reconcileReport.altered.length > 0) {
        parts.push(`Schema reconciled: ${reconcileReport.altered.join(', ')}`);
      }
      if (reconcileReport.warnings.length > 0) {
        parts.push(`Warnings: ${reconcileReport.warnings.join('; ')}`);
      }
      return parts.join('. ');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `File written but SQL execution failed: ${errMsg}. Please fix the SQL and try again.`;
    }
  }

  // Auto-sync _meta.json to modules table.
  // 路径、JSON 解析、basePath/endpoints contract、名字全局唯一 都已在文件顶部
  // 写盘前的预校验通过,这里 normalizedContent 是已经规范化的内容。
  if (path.endsWith('_meta.json')) {
    try {
      const segments = path.split('/').filter(Boolean);
      const moduleName = segments[0];
      const meta = JSON.parse(normalizedContent) as Record<string, unknown>;

      const existing = db.select().from(modules)
        .where(and(eq(modules.name, moduleName), eq(modules.userId, userId)))
        .get();

      if (existing) {
        const preserveStatus = existing.status === 'creating' || existing.status === 'editing';
        const updateValues: Record<string, unknown> = {
          displayName: (meta.displayName as string) || moduleName,
          description: (meta.description as string) || '',
          basePath: `/mock/${moduleName}`,
          updatedBy: userId,
          updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        };
        if (!preserveStatus) updateValues.status = (meta.status as string) || 'active';
        db.update(modules).set(updateValues as any).where(eq(modules.id, existing.id)).run();
      } else {
        db.insert(modules).values({
          name: moduleName,
          userId,                                     // creator
          updatedBy: userId,                          // 第一次写入,updatedBy = creator
          displayName: (meta.displayName as string) || moduleName,
          description: (meta.description as string) || '',
          basePath: `/mock/${moduleName}`,
          status: (meta.status as string) || 'active',
        }).run();
      }
    } catch (err) {
      console.warn(`[write-file] _meta.json sync failed for ${path}:`, (err as Error).message);
    }
  }

  return `File written: ${path}`;
}
