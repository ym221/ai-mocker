/**
 * Provider-aware prompt caching plumbing.
 *
 * Context:
 *   A single MCP `update_module` call triggers an AI conversation of up to 20
 *   tool-call round-trips. Every round-trip re-sends the same ~4.5KB system
 *   prompt + ~2-3KB tools schema. On providers that support prompt caching
 *   (Anthropic native, OpenAI GPT-4/5 auto-cache, Doubao, DeepSeek) this prefix
 *   is cached server-side and subsequent round-trips only pay the delta cost +
 *   latency. Prompt caching typically cuts token cost by 50-70% and shaves
 *   300-800ms off the first-token time per round.
 *
 * What this module does:
 *   1. Reports whether the current provider likely supports caching (observable).
 *   2. Returns provider-specific `providerOptions` to pass to `streamText` —
 *      e.g. Anthropic needs an explicit `cacheControl: { type: 'ephemeral' }`
 *      marker; OpenAI-compat auto-caches so we pass nothing.
 *
 * What this module does NOT do:
 *   - Enable caching on a backend that doesn't support it (e.g. a self-hosted
 *     Ollama instance would still not cache).
 *   - Mutate the prompt content. The prefix must already be byte-stable across
 *     requests in a session — verified in prompt-cache.spec.ts.
 *
 * Kill switch: set `ENABLE_PROMPT_CACHE=0` in env to disable the explicit
 * providerOptions injection. Auto-caching at the backend continues to work.
 */

export type ProviderType = 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'custom' | string;

export interface CacheSupportReport {
  /** Human-readable provider kind classification. */
  providerType: ProviderType;
  /** True if we inject explicit cache-control markers (Anthropic-style). */
  explicitMarkers: boolean;
  /** True if the backend is known to auto-cache matching prefixes. */
  autoCaches: boolean;
  /** Human note for logs/metrics. */
  note: string;
}

function enabled(): boolean {
  return process.env.ENABLE_PROMPT_CACHE !== '0';
}

/**
 * Classify how caching behaves for a given provider type.
 * Used for logging/metrics so users can verify speedup after this task lands.
 */
export function reportCacheSupport(providerType: ProviderType): CacheSupportReport {
  const t = (providerType || '').toLowerCase();
  if (!enabled()) {
    return { providerType, explicitMarkers: false, autoCaches: false, note: 'ENABLE_PROMPT_CACHE=0 — caching explicit markers disabled' };
  }
  if (t === 'anthropic') {
    return {
      providerType,
      explicitMarkers: true,
      autoCaches: true,
      note: 'Anthropic: ephemeral cache_control on system + tools prefix',
    };
  }
  if (t === 'openai') {
    return {
      providerType,
      explicitMarkers: false,
      autoCaches: true,
      note: 'OpenAI: server-side auto-cache for prefixes ≥1024 tokens (GPT-4+)',
    };
  }
  if (t === 'openai-compatible' || t === 'custom') {
    return {
      providerType,
      explicitMarkers: false,
      autoCaches: true,
      note: 'OpenAI-compatible (Doubao/DeepSeek/…): backend auto-cache when supported',
    };
  }
  if (t === 'google') {
    return {
      providerType,
      explicitMarkers: false,
      autoCaches: true,
      note: 'Gemini: implicit cache on prefix match (Flash/Pro 1.5+)',
    };
  }
  return { providerType, explicitMarkers: false, autoCaches: false, note: `Unknown provider type "${providerType}" — no explicit caching` };
}

/**
 * Build the `providerOptions` object for `streamText(...)`.
 *
 * The object is shaped `{ <provider>: { ...options } }`. The AI SDK routes the
 * nested object to the matching provider; other providers ignore their section.
 *
 * We emit Anthropic markers only. For OpenAI-compatible stacks we emit nothing
 * — their backends auto-cache on matching prefix (which this codebase already
 * guarantees, verified by the prompt-cache.spec.ts byte-stability test).
 */
export function buildProviderOptions(providerType: ProviderType): Record<string, unknown> | undefined {
  if (!enabled()) return undefined;
  const t = (providerType || '').toLowerCase();
  if (t === 'anthropic') {
    return {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    };
  }
  return undefined;
}
