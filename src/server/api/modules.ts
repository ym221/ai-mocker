import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { db, sqlite } from '../core/database.js';
import { modules, sessions, users } from '../core/schema.js';
import { authMiddleware } from '../core/auth.js';
import { success } from '../core/response.js';
import { deleteModule } from '../agent/tools/delete-module.js';
import { computeModuleHealth } from '../core/module-health.js';
import { aggregateTimeline } from '../core/timeline-aggregator.js';

/**
 * Build id → username Map in one query so list/detail responses can attach
 * createdByUsername / updatedByUsername without N+1.
 */
function loadUsernameMap(ids: Array<number | null | undefined>): Map<number, string> {
  const map = new Map<number, string>();
  const filtered = Array.from(new Set(ids.filter((x): x is number => typeof x === 'number')));
  if (filtered.length === 0) return map;
  const rows = db.select({ id: users.id, username: users.username }).from(users).all();
  for (const r of rows) {
    if (filtered.includes(r.id)) map.set(r.id, r.username);
  }
  return map;
}

const GENERATED_DIR = resolve('generated');

/**
 * Build a `Set<moduleName>` for modules that have a chat session currently in
 * `running` state (i.e. AI is mid-generation). Lets the modules list show a
 * "active · 生成中" sub-indicator so users don't see a healthy module while
 * the conversation is still timing — addresses the "ready but still ticking"
 * UX bug.
 */
function activeSessionModuleSet(userId: number): Set<string> {
  const rows = sqlite
    .prepare(`SELECT DISTINCT module_name FROM sessions WHERE user_id = ? AND run_status = 'running' AND module_name IS NOT NULL`)
    .all(userId) as Array<{ module_name: string | null }>;
  return new Set(rows.map(r => r.module_name).filter((n): n is string => !!n));
}

export default async function moduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET /api/modules
  app.get('/api/modules', async (request) => {
    const userId = request.user!.id;
    const result = db.select().from(modules)
      .where(eq(modules.userId, userId))
      .all();

    const activeNames = activeSessionModuleSet(userId);
    const usernameMap = loadUsernameMap(result.flatMap(m => [m.userId, m.updatedBy]));

    // Enrich with _meta.json data + health; also self-heal transient status
    // (e.g. a 'creating' row whose files are now complete → flip to 'active').
    const enriched = result.map(m => {
      const metaPath = join(GENERATED_DIR, String(userId), m.name, '_meta.json');
      let meta = null;
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        } catch { /* ignore */ }
      }

      const report = computeModuleHealth(userId, m.name);
      const hasActiveSession = activeNames.has(m.name);
      let effectiveStatus = m.status;
      // Self-heal: if files are healthy but DB status is stale → promote to active + persist.
      // Skip the persist while a chat session is still running so the in-progress
      // status (creating/editing) keeps showing in the conversation card; the
      // list still reports the healed status via `effectiveStatus` so the user
      // sees the module as usable right away.
      if (report.health === 'healthy' && m.status !== 'active') {
        effectiveStatus = 'active';
        if (!hasActiveSession) {
          try { db.update(modules).set({ status: 'active', errorMessage: null }).where(eq(modules.id, m.id)).run(); } catch {}
        }
      }
      return {
        ...m,
        status: effectiveStatus,
        health: report.health,
        hasActiveSession,
        createdByUsername: m.userId ? (usernameMap.get(m.userId) ?? null) : null,
        updatedByUsername: m.updatedBy ? (usernameMap.get(m.updatedBy) ?? null) : (m.userId ? (usernameMap.get(m.userId) ?? null) : null),
        meta,
      };
    });

    return success(enriched);
  });

  // GET /api/modules/:name
  app.get('/api/modules/:name', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;

    const mod = db.select().from(modules)
      .where(and(eq(modules.name, name), eq(modules.userId, userId)))
      .get();
    if (!mod) return reply.status(404).send({ success: false, message: 'Module not found' });

    const metaPath = join(GENERATED_DIR, String(userId), name, '_meta.json');
    let meta = null;
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
    }

    const report = computeModuleHealth(userId, name);
    const hasActiveSession = activeSessionModuleSet(userId).has(name);
    let effectiveStatus = mod.status;
    if (report.health === 'healthy' && mod.status !== 'active') {
      effectiveStatus = 'active';
      if (!hasActiveSession) {
        try { db.update(modules).set({ status: 'active', errorMessage: null }).where(eq(modules.id, mod.id)).run(); } catch {}
      }
    }

    const usernameMap = loadUsernameMap([mod.userId, mod.updatedBy]);
    return success({
      ...mod,
      status: effectiveStatus,
      health: report.health,
      hasActiveSession,
      createdByUsername: mod.userId ? (usernameMap.get(mod.userId) ?? null) : null,
      updatedByUsername: mod.updatedBy ? (usernameMap.get(mod.updatedBy) ?? null) : (mod.userId ? (usernameMap.get(mod.userId) ?? null) : null),
      meta,
    });
  });

  // GET /api/modules/:name/context — read _context.md
  app.get('/api/modules/:name/context', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;
    const filePath = join(GENERATED_DIR, String(userId), name, '_context.md');

    if (!existsSync(filePath)) {
      return reply.status(404).send({ success: false, message: 'Context file not found' });
    }
    return success(readFileSync(filePath, 'utf-8'));
  });

  // GET /api/modules/:name/doc — read api-doc.md
  app.get('/api/modules/:name/doc', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;
    const filePath = join(GENERATED_DIR, String(userId), name, 'api-doc.md');

    if (!existsSync(filePath)) {
      return reply.status(404).send({ success: false, message: 'Documentation file not found' });
    }
    return success(readFileSync(filePath, 'utf-8'));
  });

  // GET /api/modules/:name/timeline — observability timeline of the most recent
  // session that touched this module. Optional ?sessionId= overrides the lookup.
  app.get('/api/modules/:name/timeline', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;
    const query = request.query as { sessionId?: string };

    let targetSessionId: string | null = query.sessionId ?? null;
    if (!targetSessionId) {
      // Pick the most recent session that targeted this module
      const recent = db.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.moduleName, name)))
        .orderBy(desc(sessions.updatedAt))
        .limit(1)
        .get();
      targetSessionId = recent?.id ?? null;
    }

    if (!targetSessionId) {
      return success({ sessionId: null, available: false });
    }

    const summary = aggregateTimeline(targetSessionId);
    if (!summary) {
      return success({ sessionId: null, available: false });
    }
    return success({ ...summary, available: true });
  });

  // DELETE /api/modules/:name — 删除模块（数据库表 + 文件 + modules 记录）
  app.delete('/api/modules/:name', async (request, reply) => {
    const userId = request.user!.id;
    const name = (request.params as { name: string }).name;

    const mod = db.select().from(modules)
      .where(and(eq(modules.name, name), eq(modules.userId, userId)))
      .get();
    if (!mod) {
      return reply.status(404).send({ success: false, message: '模块不存在' });
    }

    try {
      await deleteModule(userId, name);
      return success(null, '模块已删除');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, message: msg });
    }
  });
}
