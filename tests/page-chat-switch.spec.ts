/**
 * Step-MCP-3.5: 对话中切换配置测试
 *
 * 覆盖:
 *   SW01 显示当前配置文案
 *   SW02 点击打开切换 dialog 能改 model
 *   SW03 生成中时控件禁用
 *   SW04 切换后 GET /api/sessions/:id 验证 model 已更新
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { waitForBackend, getToken, apiRequest, startNewChatSession } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

test.describe('ChatPage 对话中切换配置', () => {
  test('SW01 meta-bar 显示当前配置文案', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await startNewChatSession(page);
    await page.waitForFunction(() => /\/chat\/.+/.test(location.href), null, { timeout: 5000 });

    const bar = page.locator('[data-testid="session-meta-bar"]');
    await expect(bar).toBeVisible();
    const text = await bar.textContent();
    // 三段必然出现 — 默认路径下都是默认值
    expect(text).toContain('默认');  // 默认服务商 / 默认模型
    expect(text).toContain('无预设');
  });

  test('SW02 点击 meta-bar 打开 dialog 能改 model', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await startNewChatSession(page);
    await page.waitForFunction(() => /\/chat\/.+/.test(location.href), null, { timeout: 5000 });

    await page.click('[data-testid="session-meta-bar"]');
    const dialog = page.locator('[data-testid="session-config-dialog"]');
    await expect(dialog).toBeVisible();
    // Dialog 标题应该是"切换会话配置"
    await expect(page.locator('h2, [role="heading"]').filter({ hasText: '切换会话配置' }).first()).toBeVisible();

    const modelInput = page.locator('[data-testid="model-input"]');
    await modelInput.fill('sw02-custom-model');
    await page.click('[data-testid="confirm-session-config-btn"]');
    // Wait for dialog to close
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    // Toast "会话配置已更新"
    await expect(page.locator('[data-sonner-toast]:has-text("已更新")').first()).toBeVisible({ timeout: 5000 });

    // SW04 combined: verify via API
    const sessionId = page.url().split('/chat/')[1];
    const token = await getToken();
    const res = await apiRequest('GET', `/api/sessions/${sessionId}`, token);
    expect(res.data.data.model).toBe('sw02-custom-model');
  });

  test('SW03 runStatus=running 时 meta-bar 按钮禁用,不打开 dialog', async ({ page }) => {
    // 造一条 running 状态的 session
    const db = new Database(DB_PATH);
    const { randomUUID } = await import('crypto');
    const sessionId = randomUUID();
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, user_id, run_status, has_unread, last_seq)
         VALUES (?, ?, 1, 'running', 0, 0)`
      ).run(sessionId, 'SW03 running fixture');
    } finally { db.close(); }

    await page.goto(`/chat/${sessionId}`);
    await page.waitForTimeout(800);  // sessions fetch + stream connect

    const bar = page.locator('[data-testid="session-meta-bar"]');
    await expect(bar).toBeVisible();
    // Button should be disabled
    await expect(bar).toBeDisabled();

    // Clicking (even disabled) should not open the dialog
    await bar.click({ force: true }).catch(() => { /* disabled click rejected */ });
    const dialog = page.locator('[data-testid="session-config-dialog"]');
    await expect(dialog).toBeHidden();

    // Cleanup
    const db2 = new Database(DB_PATH);
    try { db2.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId); } finally { db2.close(); }
  });
});
