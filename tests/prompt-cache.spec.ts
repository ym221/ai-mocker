/**
 * Task M1.3 — provider-aware prompt caching unit tests.
 *
 * The actual cache hit happens on the provider backend; we can't assert it
 * here. What we CAN verify:
 * - Correct providerOptions shape per provider type
 * - System prompt + tools prefix is byte-stable across calls (necessary
 *   precondition for any server-side caching to kick in)
 * - ENABLE_PROMPT_CACHE=0 kill switch actually disables the explicit markers
 */
import { test, expect } from '@playwright/test';
import { buildProviderOptions, reportCacheSupport } from '../src/server/agent/prompt-cache';
import { buildSystemPrompt } from '../src/server/agent/system-prompt';

test.describe('Task M1.3 — prompt-cache provider options', () => {
  test.beforeEach(() => {
    delete process.env.ENABLE_PROMPT_CACHE;
  });
  test.afterEach(() => {
    delete process.env.ENABLE_PROMPT_CACHE;
  });

  test('PC01 anthropic 类型注入 cacheControl ephemeral', () => {
    const opts = buildProviderOptions('anthropic');
    expect(opts).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  test('PC02 openai-compatible / openai / google / custom 不注入 anthropic 选项', () => {
    for (const t of ['openai', 'openai-compatible', 'custom', 'google']) {
      expect(buildProviderOptions(t)).toBeUndefined();
    }
  });

  test('PC03 reportCacheSupport 按类型区分 explicitMarkers + autoCaches', () => {
    expect(reportCacheSupport('anthropic')).toMatchObject({ explicitMarkers: true, autoCaches: true });
    expect(reportCacheSupport('openai')).toMatchObject({ explicitMarkers: false, autoCaches: true });
    expect(reportCacheSupport('openai-compatible')).toMatchObject({ explicitMarkers: false, autoCaches: true });
    expect(reportCacheSupport('google')).toMatchObject({ explicitMarkers: false, autoCaches: true });
    expect(reportCacheSupport('weird-unknown-provider')).toMatchObject({ explicitMarkers: false, autoCaches: false });
  });

  test('PC04 ENABLE_PROMPT_CACHE=0 kill switch 禁用 anthropic 注入', () => {
    process.env.ENABLE_PROMPT_CACHE = '0';
    expect(buildProviderOptions('anthropic')).toBeUndefined();
    expect(reportCacheSupport('anthropic').note).toContain('disabled');
  });

  test('PC05 system prompt 在相同 params 下字节完全稳定 (cache 前缀必要条件)', () => {
    const params = {
      userId: 1,
      moduleList: [
        { name: 'order', displayName: 'Order', description: 'orders module' },
        { name: 'user', displayName: 'User', description: null },
      ],
      preset: { content: JSON.stringify({ fieldNaming: 'snake_case' }) },
      moduleContext: 'existing module context blob',
    };
    const a = buildSystemPrompt(params);
    const b = buildSystemPrompt(params);
    expect(a).toBe(b);
    expect(Buffer.byteLength(a, 'utf8')).toBe(Buffer.byteLength(b, 'utf8'));
  });

  test('PC06 system prompt 在不同 preset 下产生稳定区别 (变化项只在受控位置)', () => {
    const base = { userId: 1, moduleList: [] };
    const a = buildSystemPrompt(base);
    const b = buildSystemPrompt({ ...base, preset: { content: JSON.stringify({ fieldNaming: 'camelCase' }) } });
    expect(a).not.toBe(b);
    // The only change must be the preset section — the "默认最佳实践" section text should be identical
    const bestPracticeIdxA = a.indexOf('## 最佳实践默认');
    const bestPracticeIdxB = b.indexOf('## 最佳实践默认');
    expect(bestPracticeIdxA).toBeGreaterThan(0);
    expect(bestPracticeIdxB).toBeGreaterThan(0);
    // Tail after best-practice should be identical between the two
    expect(a.slice(bestPracticeIdxA)).toBe(b.slice(bestPracticeIdxB));
  });
});
