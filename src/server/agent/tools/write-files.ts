/**
 * write_files — batch multi-file write with all-or-nothing semantics.
 *
 * Why exists:
 *   write_file needs 1 LLM round-trip per file. A typical module has 5-6 files,
 *   so creating a module = 5-6 round-trips ≈ 7-15 min. write_files lets the AI
 *   emit all files in a single tool call, which cuts that down to 1-2 round-trips.
 *
 * Transaction semantics:
 *   1. Validate every path up-front; reject the whole batch if any path is unsafe.
 *   2. Snapshot prior content of each file (for fs rollback).
 *   3. Write all files to disk eagerly.
 *   4. Re-run per-file SQL exec + _meta.json sync (writeFile's side effects)
 *      inside a single sqlite.transaction so DB side-effects are atomic.
 *   5. If any step fails: restore fs from snapshots + DB transaction rolls back.
 *
 * The per-file write logic is delegated to `writeFile()` — but that function
 * auto-execs SQL and syncs _meta.json as side effects. To keep the DB changes
 * inside our transaction, we call writeFile twice-logically but wrap the SQL +
 * meta portions in our transaction boundary via a simpler approach: we split
 * writeFile into "pure disk write" and "post-write side effects". We do all
 * disk writes first, then run side effects inside a transaction.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';

const GENERATED_DIR = resolve('generated');

export interface WriteFilesInput {
  files: Array<{ path: string; content: string }>;
}

export interface WriteFilesResult {
  success: boolean;
  message: string;
  filesWritten: number;
  perFile: Array<{
    path: string;
    ok: boolean;
    note?: string;  // e.g. "SQL reconciled: +column mock__todo.extra"
    warnings?: string[];
  }>;
  /** Populated when success=false. */
  error?: string;
}

// ============================================================================
// Path validation (shared with write-file.ts)
// ============================================================================

function validatePath(userPath: string, userId: number): string {
  if (userPath.includes('..') || /^[/\\]/.test(userPath) || /^[a-zA-Z]:/.test(userPath)) {
    throw new Error(`Invalid path "${userPath}": directory traversal or absolute paths are not allowed`);
  }
  const fullPath = resolve(join(GENERATED_DIR, String(userId), userPath));
  const expectedPrefix = resolve(join(GENERATED_DIR, String(userId)));
  if (!fullPath.startsWith(expectedPrefix)) {
    throw new Error(`Invalid path "${userPath}": must be within generated/${userId}/ directory`);
  }
  return fullPath;
}

// ============================================================================
// SQL parsing + reconciliation (copied from write-file.ts; keep in sync)
// ============================================================================

function parseCreateTables(sql: string): Array<{ table: string; columns: { name: string; def: string }[] }> {
  const out: Array<{ table: string; columns: { name: string; def: string }[] }> = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*;?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const inside = m[2];
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
      if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(p)) continue;
      const nameMatch = p.match(/^`?([A-Za-z0-9_]+)`?\s+(.+)$/s);
      if (!nameMatch) continue;
      columns.push({ name: nameMatch[1], def: nameMatch[2] });
    }
    out.push({ table, columns });
  }
  return out;
}

function reconcileSchemaWithPhysical(injectedSql: string): { altered: string[]; warnings: string[] } {
  const altered: string[] = [];
  const warnings: string[] = [];
  const tables = parseCreateTables(injectedSql);
  for (const t of tables) {
    const existing = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(t.table) as { name: string } | undefined;
    if (!existing) continue;

    const physCols = sqlite.prepare(`PRAGMA table_info(\`${t.table}\`)`).all() as Array<{ name: string }>;
    const physNames = new Set(physCols.map(c => c.name));

    for (const col of t.columns) {
      if (!physNames.has(col.name)) {
        let def = col.def.trim().replace(/,\s*$/, '');
        if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)) {
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

// ============================================================================
// Batch write
// ============================================================================

/**
 * Write multiple files transactionally. Either all succeed or the filesystem +
 * DB roll back to the pre-call state.
 */
export async function writeFiles(userId: number, input: WriteFilesInput): Promise<WriteFilesResult> {
  if (!input.files || input.files.length === 0) {
    return {
      success: false,
      message: 'write_files: no `files` array provided. Your tool-call args were empty or malformed — the correct schema is { files: [{ path: "...", content: "..." }, ...] }. '
        + 'If your model cannot reliably emit nested arrays, STOP RETRYING write_files and call `write_file(path, content)` once per file instead.',
      filesWritten: 0,
      perFile: [],
      error: 'empty input — switch to write_file(path, content) per file',
    };
  }

  // 1. Pre-validate all paths and precompute full paths (fail fast on the whole batch)
  const prepared: Array<{ path: string; content: string; fullPath: string; prevContent: string | null; existedBefore: boolean }> = [];
  for (const f of input.files) {
    try {
      const fullPath = validatePath(f.path, userId);
      const existedBefore = existsSync(fullPath);
      let prevContent: string | null = null;
      if (existedBefore) {
        try { prevContent = readFileSync(fullPath, 'utf-8'); } catch { prevContent = null; }
      }
      prepared.push({ path: f.path, content: f.content, fullPath, prevContent, existedBefore });
    } catch (err) {
      return {
        success: false,
        message: `path validation failed for "${f.path}": ${(err as Error).message}`,
        filesWritten: 0,
        perFile: input.files.map(x => ({ path: x.path, ok: false, note: 'batch aborted' })),
        error: (err as Error).message,
      };
    }
  }

  // 2. Write all files to disk
  const writtenIndices: number[] = [];
  try {
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const dir = dirname(p.fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(p.fullPath, p.content, 'utf-8');
      writtenIndices.push(i);
    }
  } catch (err) {
    rollbackFs(prepared, writtenIndices);
    return {
      success: false,
      message: `write_files: fs write failed: ${(err as Error).message}`,
      filesWritten: 0,
      perFile: input.files.map(x => ({ path: x.path, ok: false, note: 'rolled back' })),
      error: (err as Error).message,
    };
  }

  // 3. Run side effects (SQL exec + _meta.json sync) inside a single DB transaction
  const perFile: WriteFilesResult['perFile'] = prepared.map(p => ({ path: p.path, ok: true }));

  try {
    const txn = sqlite.transaction(() => {
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (p.path.endsWith('.sql')) {
          const injectedSql = p.content
            .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${userId}_$1\``)
            .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${userId}_$1`);
          try {
            sqlite.exec(injectedSql);
          } catch (err) {
            throw new Error(`SQL execution failed for "${p.path}": ${(err as Error).message}`);
          }
          const reconcile = reconcileSchemaWithPhysical(injectedSql);
          if (reconcile.altered.length > 0 || reconcile.warnings.length > 0) {
            const notes: string[] = [];
            if (reconcile.altered.length) notes.push(`reconciled: ${reconcile.altered.join(', ')}`);
            perFile[i].note = notes.join('; ') || undefined;
            if (reconcile.warnings.length) perFile[i].warnings = reconcile.warnings;
          }
        } else if (p.path.endsWith('_meta.json')) {
          try {
            const meta = JSON.parse(p.content);
            const moduleName = meta.name;
            if (!moduleName) throw new Error('_meta.json missing "name" field');
            const existing = db.select().from(modules)
              .where(and(eq(modules.name, moduleName), eq(modules.userId, userId)))
              .get();
            if (existing) {
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
          } catch (err) {
            // Parsing/sync failure is soft — historically write_file swallowed it.
            // Keep same behavior: note on perFile, don't fail the whole batch.
            perFile[i].warnings = [...(perFile[i].warnings ?? []), `meta sync failed: ${(err as Error).message}`];
          }
        }
      }
    });
    txn();
  } catch (err) {
    rollbackFs(prepared, writtenIndices);
    return {
      success: false,
      message: `write_files: side-effect failed — batch rolled back. ${(err as Error).message}`,
      filesWritten: 0,
      perFile: perFile.map(x => ({ ...x, ok: false, note: 'rolled back' })),
      error: (err as Error).message,
    };
  }

  return {
    success: true,
    message: `wrote ${prepared.length} files`,
    filesWritten: prepared.length,
    perFile,
  };
}

function rollbackFs(
  prepared: Array<{ fullPath: string; prevContent: string | null; existedBefore: boolean }>,
  writtenIndices: number[],
): void {
  for (const i of writtenIndices) {
    const p = prepared[i];
    try {
      if (p.existedBefore && p.prevContent != null) {
        writeFileSync(p.fullPath, p.prevContent, 'utf-8');
      } else {
        if (existsSync(p.fullPath)) unlinkSync(p.fullPath);
      }
    } catch {
      // Best effort; failure here is logged but not re-thrown.
    }
  }
}
