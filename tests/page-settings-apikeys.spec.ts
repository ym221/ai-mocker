import { test, expect } from '@playwright/test';
import { waitForBackend, getToken, apiRequest, expectToast } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

test.beforeEach(async () => {
  // 清理 admin 的 API key，保证从"无 key"状态开始
  const token = await getToken();
  await apiRequest('DELETE', '/api/users/me/api-key', token);
});

test.describe('Settings → API Keys Tab', () => {
  test('A01 切换到 API Keys Tab，未生成态展示生成按钮', async ({ page }) => {
    await page.goto('/settings');
    await page.click('[data-testid="tab-api-keys"]');
    await expect(page.locator('[data-testid="tab-panel-api-keys"]')).toBeVisible();
    await expect(page.locator('[data-testid="generate-api-key-btn"]')).toBeVisible();
    await expect(page.getByText('你还没有 API Key')).toBeVisible();
  });

  test('A02 生成 API Key 后弹出 Dialog 展示明文', async ({ page }) => {
    await page.goto('/settings');
    await page.click('[data-testid="tab-api-keys"]');
    await page.click('[data-testid="generate-api-key-btn"]');
    await expect(page.locator('[data-testid="new-api-key-dialog"]')).toBeVisible();
    const val = await page.locator('[data-testid="new-api-key-value"]').textContent();
    expect(val?.startsWith('mf_')).toBeTruthy();
    expect((val || '').length).toBeGreaterThan(20);
  });

  test('A03 关闭 Dialog 后显示已有态，并能吊销', async ({ page }) => {
    await page.goto('/settings');
    await page.click('[data-testid="tab-api-keys"]');
    await page.click('[data-testid="generate-api-key-btn"]');
    await expect(page.locator('[data-testid="new-api-key-dialog"]')).toBeVisible();
    await page.click('[data-testid="close-new-api-key-dialog-btn"]');
    await expect(page.getByText('已有 API Key')).toBeVisible();
    await expect(page.locator('[data-testid="regenerate-api-key-btn"]')).toBeVisible();

    // 吊销：会二次确认
    await page.click('[data-testid="revoke-api-key-btn"]');
    // ConfirmDialog 的确认按钮
    await page.click('[data-testid="confirm-ok"]');
    await expectToast(page, 'API Key 已吊销');
    await expect(page.getByText('你还没有 API Key')).toBeVisible();
  });

  test('A04 重新生成会二次确认并换出新 Key', async ({ page }) => {
    await page.goto('/settings');
    await page.click('[data-testid="tab-api-keys"]');
    await page.click('[data-testid="generate-api-key-btn"]');
    const firstKey = await page.locator('[data-testid="new-api-key-value"]').textContent();
    await page.click('[data-testid="close-new-api-key-dialog-btn"]');

    await page.click('[data-testid="regenerate-api-key-btn"]');
    await page.click('[data-testid="confirm-ok"]');
    await expect(page.locator('[data-testid="new-api-key-dialog"]')).toBeVisible();
    const secondKey = await page.locator('[data-testid="new-api-key-value"]').textContent();
    expect(secondKey).not.toEqual(firstKey);
  });
});
