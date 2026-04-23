import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve, normalize } from 'path';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';

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
