/**
 * Step-MCP-3.4: 新建对话 dialog 测试
 *
 * 覆盖:
 *   NS01 对话 dialog 打开时三个选择器可见
 *   NS02 跳过默认时也能成功建 session
 *   NS03 选了 preset 后创建的 session.presetId 正确
 *   NS04 切换 provider 时 model 默认值联动更新
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

async function ensureUserOwnedPreset(name: string): Promise<number> {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM presets WHERE name = ? AND owner_id = 1`).run(name);
    const row = db.prepare(
      `INSERT INTO presets (name, description, content, scope, owner_id, is_active)
       VALUES (?, 'NS test preset', ?, 'private', 1, 1) RETURNING id`
    ).get(name, JSON.stringify({ fieldNaming: 'snake_case' })) as { id: number };
    return row.id;
  } finally { db.close(); }
}

async function ensureUserOwnedProvider(name: string): Promise<{ id: number; defaultModel: string; type: string }> {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM providers WHERE name = ? AND owner_id = 1`).run(name);
    const row = db.prepare(
      `INSERT INTO providers (name, type, base_url, default_model, scope, owner_id, is_active)
       VALUES (?, 'openai-compatible', 'http://fake', ?, 'private', 1, 1) RETURNING id`
    ).get(name, 'ns-custom-default-model') as { id: number };
    return { id: row.id, defaultModel: 'ns-custom-default-model', type: 'openai-compatible' };
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('ChatPage 新建对话 dialog', () => {
  test('NS01 点"新建对话"后 dialog 打开,三个选择器可见', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.click('[data-testid="new-session-btn"]');
    const dialog = page.locator('[data-testid="session-config-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="provider-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="model-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="preset-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="skip-defaults-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="confirm-session-config-btn"]')).toBeVisible();
  });

  test('NS02 点"跳过默认"也能成功建 session', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.click('[data-testid="new-session-btn"]');
    await page.locator('[data-testid="session-config-dialog"]').waitFor({ state: 'visible' });
    await page.click('[data-testid="skip-defaults-btn"]');
    await page.waitForFunction(() => /\/chat\/.+/.test(location.href), null, { timeout: 5000 });
    const sessionId = page.url().split('/chat/')[1];
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Session 应该有默认值 (backend 会在 send 时自动选 provider, 此时 session row 里 providerId/presetId 都是 null)
    const token = await getToken();
    const res = await apiRequest('GET', `/api/sessions/${sessionId}`, token);
    expect(res.status).toBe(200);
    expect(res.data.data.providerId).toBeNull();
    expect(res.data.data.presetId).toBeNull();
    expect(res.data.data.model).toBeNull();
  });

  test('NS03 选了 preset → 新 session.presetId 正确写入', async ({ page }) => {
    const presetId = await ensureUserOwnedPreset('ns03-preset');

    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.click('[data-testid="new-session-btn"]');
    await page.locator('[data-testid="session-config-dialog"]').waitFor({ state: 'visible' });

    // reka-ui Select: click trigger, then click the item with matching text
    await page.click('[data-testid="preset-select"]');
    // The popover renders outside the dialog via portal; click by visible text
    await page.locator('[role="option"]').filter({ hasText: 'ns03-preset' }).first().click();

    await page.click('[data-testid="confirm-session-config-btn"]');
    await page.waitForFunction(() => /\/chat\/.+/.test(location.href), null, { timeout: 5000 });
    const sessionId = page.url().split('/chat/')[1];

    const token = await getToken();
    const res = await apiRequest('GET', `/api/sessions/${sessionId}`, token);
    expect(res.data.data.presetId).toBe(presetId);
  });

  test('NS04 切换 provider → model 输入框联动预填 provider.defaultModel', async ({ page }) => {
    const provider = await ensureUserOwnedProvider('ns04-custom-provider');

    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.click('[data-testid="new-session-btn"]');
    await page.locator('[data-testid="session-config-dialog"]').waitFor({ state: 'visible' });

    // Model input should start empty
    const modelInput = page.locator('[data-testid="model-input"]');
    await expect(modelInput).toHaveValue('');

    // Select the custom provider
    await page.click('[data-testid="provider-select"]');
    await page.locator('[role="option"]').filter({ hasText: 'ns04-custom-provider' }).first().click();

    // Model input should now be pre-filled with provider.defaultModel
    await expect(modelInput).toHaveValue(provider.defaultModel);
  });
});
