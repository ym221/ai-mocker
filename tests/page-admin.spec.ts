import { test, expect } from '@playwright/test';
import { waitForBackend, login, expectToast } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 5.1 UI 渲染验证 ==========

test.describe('管理页 - UI 渲染', () => {
  test('A01 页面标题', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('h1')).toContainText('管理面板');
    await expect(page.getByText('用户管理')).toBeVisible();
  });

  test('A02 用户表格结构', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // 表头含 5 列
    const headers = page.locator('thead th');
    await expect(headers.nth(0)).toContainText('ID');
    await expect(headers.nth(1)).toContainText('用户名');
    await expect(headers.nth(2)).toContainText('角色');
    await expect(headers.nth(3)).toContainText('状态');
    await expect(headers.nth(4)).toContainText('操作');
  });

  test('A03 角色徽章颜色', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // admin 用户有紫色徽章
    const adminBadge = page.locator('.bg-purple-100.text-purple-700');
    await expect(adminBadge.first()).toBeVisible();
  });

  test('A04 状态徽章颜色', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // Active 用户有绿色徽章
    const activeBadge = page.locator('.bg-green-100.text-green-700');
    await expect(activeBadge.first()).toBeVisible();
  });

  test('A05 操作按钮文字', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // admin 用户应显示 Demote
    await expect(page.getByRole('button', { name: '降级' }).first()).toBeVisible();
    // 应有 Disable 按钮
    await expect(page.getByRole('button', { name: '禁用' }).first()).toBeVisible();
  });
});

// ========== 5.2 用户管理交互 ==========

test.describe('管理页 - 用户管理交互', () => {
  test('A06 提升用户为管理员', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    const promoteBtn = page.getByRole('button', { name: '提升' }).first();
    if (await promoteBtn.isVisible()) {
      await promoteBtn.click();
      await expectToast(page, '角色已变更为管理员');
    } else {
      // 所有用户都是 admin，跳过
      test.skip();
    }
  });

  test('A07 降级管理员', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // 找非当前用户的 Demote 按钮（第二行起）
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const username = await row.locator('td').nth(1).textContent();
      if (username?.trim() !== 'admin') {
        const demoteBtn = row.getByRole('button', { name: '降级' });
        if (await demoteBtn.isVisible()) {
          await demoteBtn.click();
          await expectToast(page, '角色已变更为普通用户');
          return;
        }
      }
    }
    test.skip();
  });

  test('A08 禁用用户', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const username = await row.locator('td').nth(1).textContent();
      if (username?.trim() !== 'admin') {
        const disableBtn = row.getByRole('button', { name: '禁用' });
        if (await disableBtn.isVisible()) {
          await disableBtn.click();
          await expectToast(page, '用户已禁用');
          return;
        }
      }
    }
    test.skip();
  });

  test('A09 启用用户', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    const enableBtn = page.getByRole('button', { name: '启用' }).first();
    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expectToast(page, '用户已启用');
    } else {
      test.skip();
    }
  });
});

// ========== 5.3 权限 & 视觉 ==========

test.describe('管理页 - 权限', () => {
  test('A10 非管理员无法访问', async ({ browser }) => {
    // 显式空 storageState，防止继承 auth.setup 的登录态
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const baseURL = process.env.PW_BASE_URL || 'http://127.0.0.1:5177';
    await page.goto(`${baseURL}/admin`);
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });

  test('A11 管理页截图对比', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('admin-default.png', { maxDiffPixelRatio: 0.05 });
  });

  test('A12 表格样式一致', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // 表头有 bg-muted
    await expect(page.locator('thead.bg-muted')).toBeVisible();
    // 行间有 border-t
    const rows = page.locator('tbody tr.border-t');
    expect(await rows.count()).toBeGreaterThan(0);
  });
});
