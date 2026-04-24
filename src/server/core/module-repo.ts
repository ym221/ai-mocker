/**
 * Centralized module row + meta.json helpers.
 *
 * Before this module existed, ~8 MCP tools and 4 agent tools did their own
 * `db.select().from(modules).where(...).get()` and their own
 * `readFileSync(join(GENERATED_DIR, String(userId), name, '_meta.json'), ...)`.
 * This consolidates those to one place so:
 *   - path construction stays consistent
 *   - user-scoping bugs are harder (we only expose `(userId, name)` APIs)
 *   - future changes (e.g. caching, multi-tenant partitioning) have one owner
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from './database.js';
import { modules } from './schema.js';

const GENERATED_DIR = resolve('generated');

export type ModuleRow = typeof modules.$inferSelect;

/** Lookup the modules row for (userId, name); null when missing. */
export function getModuleRow(userId: number, name: string): ModuleRow | null {
  const row = db
    .select()
    .from(modules)
    .where(and(eq(modules.userId, userId), eq(modules.name, name)))
    .get();
  return row ?? null;
}

/** True iff (userId, name) exists in modules. */
export function moduleExists(userId: number, name: string): boolean {
  return getModuleRow(userId, name) !== null;
}

/** Module-scoped filesystem directory. */
export function moduleDir(userId: number, name: string): string {
  return join(GENERATED_DIR, String(userId), name);
}

/** Absolute path to a file inside the module dir. */
export function moduleFilePath(userId: number, name: string, filename: string): string {
  return join(moduleDir(userId, name), filename);
}

/**
 * Read a file from the module directory. Returns null if the file is missing.
 * Optionally caps the returned size (defensively; pass 0 or undefined for no cap).
 */
export function readModuleFile(
  userId: number,
  name: string,
  filename: string,
  maxBytes?: number,
): string | null {
  const p = moduleFilePath(userId, name, filename);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    if (maxBytes && maxBytes > 0 && raw.length > maxBytes) return raw.slice(0, maxBytes);
    return raw;
  } catch {
    return null;
  }
}

/** Parse _meta.json for a module. Returns null if missing or invalid JSON. */
export function loadMeta(userId: number, name: string): Record<string, unknown> | null {
  const raw = readModuleFile(userId, name, '_meta.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
