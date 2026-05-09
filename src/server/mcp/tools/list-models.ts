import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, or, asc } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { providers, providerModels, users } from '../../core/schema.js';
import { getMcpUserId } from '../context.js';

/**
 * 重名 disambiguation:同视野下重名的 provider 加后缀("(公开)" / "(我的)") 区分。
 */
function buildDisplayNames(
  list: { id: number; name: string; scope: string; ownerId: number | null }[],
  userId: number,
): Map<number, string> {
  const counts = new Map<string, number>();
  list.forEach(p => counts.set(p.name, (counts.get(p.name) || 0) + 1));
  const result = new Map<number, string>();
  for (const p of list) {
    if ((counts.get(p.name) || 0) === 1) {
      result.set(p.id, p.name);
    } else {
      const suffix = p.scope === 'public'
        ? '(公开)'
        : (p.ownerId === userId ? '(我的)' : '(他人)');
      result.set(p.id, `${p.name} ${suffix}`);
    }
  }
  return result;
}

export function registerListModelsTool(server: McpServer): void {
  server.registerTool(
    'list_models',
    {
      title: 'List Available AI Models',
      description:
        'List all AI providers and their preset models visible to the current user (own private + all public). '
        + 'Each model carries: isVerified (whether connectivity test passed),  note (user-written hint about cost / speed / fitness), '
        + 'isDefault (provider-level default).  Use this BEFORE calling create_module_from_spec / update_module to pick the right model — '
        + 'pass it via the `provider` and `model` parameters to override the server default. '
        + 'When the user has set a default provider, prefer it unless its default model is unverified or note suggests poor fitness.',
      inputSchema: {},
    },
    async () => {
      const userId = getMcpUserId();

      // 1. 查用户能看的所有 active provider
      const visibleProviders = db.select().from(providers)
        .where(or(eq(providers.scope, 'public'), eq(providers.ownerId, userId)))
        .orderBy(asc(providers.id))
        .all()
        .filter(p => p.isActive === 1);

      // 2. 同名 disambiguation
      const displayNames = buildDisplayNames(visibleProviders, userId);

      // 3. 查每个 provider 的 preset models
      const grouped = visibleProviders.map(p => {
        const models = db.select().from(providerModels)
          .where(eq(providerModels.providerId, p.id))
          .orderBy(asc(providerModels.id))
          .all()
          .map(m => ({
            name: m.modelName,
            note: m.note,
            isVerified: m.isVerified === 1,
            lastVerifiedAt: m.lastVerifiedAt,
            lastVerifiedError: m.lastVerifiedError,
            isDefault: m.modelName === p.defaultModel,
          }));
        return {
          id: p.id,
          name: p.name,
          displayName: displayNames.get(p.id) || p.name,
          type: p.type,
          scope: p.scope,
          defaultModel: p.defaultModel,
          isProviderVerified: p.isVerified === 1,
          models,
        };
      });

      // 4. 用户的默认 provider
      const userRow = db.select().from(users).where(eq(users.id, userId)).get();
      const userDefaultProviderId = userRow?.defaultProviderId ?? null;
      // fallback 到 id=1(seed 兜底)
      const effectiveDefaultProviderId = userDefaultProviderId
        ?? (visibleProviders.find(p => p.id === 1) ? 1 : (visibleProviders[0]?.id ?? null));

      const result = {
        providers: grouped,
        userDefaultProviderId,
        effectiveDefaultProviderId,
        total: grouped.length,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );
}
