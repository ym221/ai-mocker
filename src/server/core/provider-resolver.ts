/**
 * 共享:为某个 user 解析"应该使用的"默认 provider id。
 *
 * 此前 chat / sessions / MCP 三处各自实现了同名但语义不同的逻辑,导致用户在
 * Settings 把 moyu (anthropic, private) 设为默认,但 MCP 的 pickProviderForUser
 * 仍优先返回 id=1 的 public seed provider (Default Provider / openai)。
 *
 * 统一优先级 (高到低):
 *   1. env MCP_DEFAULT_PROVIDER_ID  (测试 / 部署覆盖,仅当指向 active provider 时生效)
 *   2. users.defaultProviderId      (用户在 Settings 显式 ★ 默认)
 *   3. user-owned private active     (按 id desc — 用户最新创建的)
 *   4. public active                 (按 id asc — seed 兜底)
 *   5. null                           (用户完全没配 → 调用方应抛"未配置"友好错误)
 *
 * 关键性:每个候选必须能被该 user 访问,即 (public OR ownerId=userId) AND isActive=1。
 */
import { and, eq, or, desc } from 'drizzle-orm';
import { db } from './database.js';
import { providers, users } from './schema.js';

export interface ResolvedProvider {
  id: number;
  defaultModel: string;
  /** Why this provider was chosen — useful for tests + error hints. */
  source: 'env' | 'user-default' | 'user-private' | 'public-fallback';
}

function pickById(userId: number, providerId: number): ResolvedProvider | null {
  const p = db.select().from(providers)
    .where(and(
      eq(providers.id, providerId),
      eq(providers.isActive, 1),
      or(eq(providers.scope, 'public'), eq(providers.ownerId, userId)),
    ))
    .get();
  if (!p) return null;
  return { id: p.id, defaultModel: p.defaultModel, source: 'user-default' };
}

export function resolveDefaultProviderForUser(userId: number): ResolvedProvider | null {
  // 1. env override (tests / forced deployment default)
  const envPreferred = Number(process.env.MCP_DEFAULT_PROVIDER_ID || '0');
  if (envPreferred > 0) {
    const hit = pickById(userId, envPreferred);
    if (hit) return { ...hit, source: 'env' };
  }

  // 2. user's explicit default
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.defaultProviderId) {
    const hit = pickById(userId, user.defaultProviderId);
    if (hit) return { ...hit, source: 'user-default' };
    // 用户设了默认但 provider 已被禁用 / 删除 / 失去访问权限 — fall through
  }

  // 3. user-owned private active (newest first — better fit than ancient seed)
  const owned = db.select().from(providers)
    .where(and(
      eq(providers.ownerId, userId),
      eq(providers.scope, 'private'),
      eq(providers.isActive, 1),
    ))
    .orderBy(desc(providers.id))
    .get();
  if (owned) return { id: owned.id, defaultModel: owned.defaultModel, source: 'user-private' };

  // 4. public active fallback (oldest first — typically the seed)
  const pub = db.select().from(providers)
    .where(and(eq(providers.scope, 'public'), eq(providers.isActive, 1)))
    .orderBy(providers.id)
    .get();
  if (pub) return { id: pub.id, defaultModel: pub.defaultModel, source: 'public-fallback' };

  return null;
}

/**
 * 给定一个 providerId (来自 session.providerId 或 MCP override),验证该 provider 对该 user
 * 可访问 + isActive。返回完整 provider 行或 null。
 * 与 pickById 不同:此处不要求 scope=public 或 owner=userId 之一时也允许跨 user 读 — 调用方
 * 已经持有 id (通常来自 session 创建时校验过),仅检验 active 即可。
 */
export function findAccessibleProvider(
  userId: number,
  providerId: number,
): ResolvedProvider | null {
  return pickById(userId, providerId);
}
