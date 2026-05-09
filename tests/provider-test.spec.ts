/**
 * Provider 连接测试功能 e2e
 *
 * 覆盖 API 层错误分类 + UI 测试按钮 + 状态 badge + db 写回。
 * 所有测试不依赖外部 LLM 真实通过(用 fake key + unreachable URL 走错误路径,稳定可重跑)。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve('data/mockforge.db');

test.describe('TP — Provider 测试连接(API)', () => {
  let token: string;

  test.beforeAll(async () => {
    await waitForBackend();
    token = await getToken();
  });

  test('TP01 — 草稿测试:apiKey 缺失返回 NO_API_KEY', async () => {
    const res = await apiRequest('POST', '/api/providers/test', token, {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.ok).toBe(false);
    expect(res.data.data.errorCode).toBe('NO_API_KEY');
    expect(res.data.data.hint).toBeTruthy();
  });

  test('TP02 — 草稿测试:model 缺失返回 NO_MODEL', async () => {
    const res = await apiRequest('POST', '/api/providers/test', token, {
      type: 'openai',
      apiKey: 'sk-fake-but-present',
    });
    expect(res.data.data.ok).toBe(false);
    expect(res.data.data.errorCode).toBe('NO_MODEL');
  });

  test('TP03 — 草稿测试:不可达 baseUrl 返回 NETWORK/TIMEOUT/UNKNOWN', async () => {
    test.setTimeout(60_000);
    const res = await apiRequest('POST', '/api/providers/test', token, {
      type: 'openai',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1', // port 1 ≈ connection refused
      modelName: 'gpt-4o-mini',
    });
    expect(res.status).toBe(200);
    expect(res.data.data.ok).toBe(false);
    // ai-sdk retry 包装后可能输出多种错误码,只要不是 ok=true 都算正确分类
    expect(['NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN', 'BASE_URL_NOT_FOUND']).toContain(res.data.data.errorCode);
    expect(res.data.data.latencyMs).toBeGreaterThan(0);
  });

  test('TP04 — 已保存测试:不存在的 id 返回 404', async () => {
    const res = await apiRequest('POST', '/api/providers/99999/test', token);
    expect(res.status).toBe(404);
    expect(res.data.success).toBe(false);
  });

  test('TP05 — 已保存测试:测完写回 last_verified_at + last_verified_error + is_verified', async () => {
    test.setTimeout(60_000);

    const create = await apiRequest('POST', '/api/providers', token, {
      name: 'tp05-bad-provider',
      type: 'openai',
      apiKey: 'sk-bad-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'gpt-4o-mini',
      scope: 'private',
    });
    expect(create.status).toBe(201);
    const id = create.data.data.id;

    try {
      const r = await apiRequest('POST', `/api/providers/${id}/test`, token);
      expect(r.status).toBe(200);
      expect(r.data.data.ok).toBe(false);

      // db 应当被写回
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
      db.close();

      expect(row).toBeTruthy();
      expect(row.last_verified_at).toBeTruthy();
      expect(row.last_verified_error).toBeTruthy();
      expect(row.is_verified).toBe(0);
    } finally {
      await apiRequest('DELETE', `/api/providers/${id}`, token);
    }
  });

  test('TP06 — 已保存 provider 没存 apiKey 时,测试返回明确错误而不是崩溃', async () => {
    test.setTimeout(30_000);
    const create = await apiRequest('POST', '/api/providers', token, {
      name: 'tp06-no-key',
      type: 'openai',
      // no apiKey
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      scope: 'private',
    });
    expect(create.status).toBe(201);
    const id = create.data.data.id;

    try {
      const r = await apiRequest('POST', `/api/providers/${id}/test`, token);
      expect(r.status).toBe(200);
      expect(r.data.data.ok).toBe(false);
      // 没 key 应该走 NO_API_KEY 而不是 UNKNOWN/NETWORK
      expect(r.data.data.errorCode).toBe('NO_API_KEY');
    } finally {
      await apiRequest('DELETE', `/api/providers/${id}`, token);
    }
  });

  test('TP07 — 测试结果含 latencyMs/gotText/gotToolCall 字段(响应契约稳定)', async () => {
    const res = await apiRequest('POST', '/api/providers/test', token, {
      type: 'openai',
      // 全部缺失,会即时返回 NO_API_KEY
    });
    expect(res.data.data).toMatchObject({
      ok: false,
      latencyMs: expect.any(Number),
      gotText: expect.any(Boolean),
      gotToolCall: expect.any(Boolean),
    });
  });
});

test.describe('TP — Provider 测试连接(UI)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('button:has-text("添加服务商")', { timeout: 15000 });
    // 切到 providers tab(默认就是,但保险点)
    const providersTab = page.locator('button:has-text("AI 服务商")').first();
    if (await providersTab.isVisible().catch(() => false)) {
      await providersTab.click().catch(() => {});
    }
  });

  test('TP-UI01 — 列表行展示状态 badge(已验证 / 未验证 / 失败 之一)', async ({ page }) => {
    await page.waitForSelector('[data-testid^="provider-row-"]', { timeout: 15000 });
    const badges = page.locator('[data-testid^="provider-badge-"]');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);

    // 任一 badge 文本应当包含三种之一
    const text = await badges.first().textContent();
    expect(text).toMatch(/已验证|未验证|验证失败/);
  });

  test('TP-UI02 — 列表行有测试连接按钮(⚡ icon)', async ({ page }) => {
    await page.waitForSelector('[data-testid^="provider-test-"]', { timeout: 15000 });
    const btns = page.locator('[data-testid^="provider-test-"]');
    expect(await btns.count()).toBeGreaterThan(0);
  });

  test('TP-UI03 — Form 内有"测试连接"按钮', async ({ page }) => {
    await page.click('button:has-text("添加服务商")');
    await page.waitForSelector('[data-testid="draft-test-btn"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="draft-test-btn"]')).toContainText('测试连接');
  });

  test('TP-UI04 — Form 内点测试,缺 model 弹错误提示', async ({ page }) => {
    await page.click('button:has-text("添加服务商")');
    await page.waitForSelector('[data-testid="draft-test-btn"]');
    await page.click('[data-testid="draft-test-btn"]');
    // 等 sonner toast
    await page.waitForSelector('text=请先填默认模型', { timeout: 5000 });
  });

  test('TP-UI05 — Form 内点测试,缺 apiKey 弹错误提示', async ({ page }) => {
    await page.click('button:has-text("添加服务商")');
    await page.waitForSelector('[data-testid="draft-test-btn"]');
    // 填 model 但不填 apiKey
    await page.fill('input[placeholder="gpt-4o-mini"]', 'gpt-4o-mini');
    await page.click('[data-testid="draft-test-btn"]');
    await page.waitForSelector('text=请填 API Key', { timeout: 5000 });
  });

  test('TP-UI06 — Form 内点测试,显示结果块(草稿失败场景)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.click('button:has-text("添加服务商")');
    await page.waitForSelector('[data-testid="draft-test-btn"]');
    await page.fill('input[placeholder="gpt-4o-mini"]', 'gpt-4o-mini');
    await page.fill('input[type="password"]', 'sk-fake-key-for-test');
    await page.fill('input[placeholder="https://api.openai.com/v1"]', 'http://127.0.0.1:1/v1');
    await page.click('[data-testid="draft-test-btn"]');
    // 等结果块出现(失败,但有内容)
    await page.waitForSelector('[data-testid="draft-test-result"]', { timeout: 60_000 });
    const result = page.locator('[data-testid="draft-test-result"]');
    await expect(result).toBeVisible();
    // 不应该 ok=true
    const text = await result.textContent();
    expect(text).not.toMatch(/^\s*测试通过/);
  });
});
