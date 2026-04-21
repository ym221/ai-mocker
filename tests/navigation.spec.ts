import { test, expect } from '@playwright/test';
import { waitForBackend, login } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 6.1 路由守卫 ==========

test.describe('路由守卫 - 未登录', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('R01 未登录→/chat 重定向到 /login', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/login');
  });

  test('R02 未登录→/settings 重定向到 /login', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/login');
  });

  test('R03 未登录→/modules 重定向到 /login', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/login');
  });

  test('R04 未登录→/admin 重定向到 /login', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/login');
  });
});

test.describe('路由守卫 - 已登录', () => {
  test('R05 已登录→/login 重定向到 /chat', async ({ page }) => {
    await page.goto('/login');
    await page.waitForURL(/\/chat/, { timeout: 10000 });
    await expect(page).toHaveURL(/\/chat/);
  });

  test('R06 根路径重定向到 /chat', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/chat/, { timeout: 10000 });
    await expect(page).toHaveURL(/\/chat/);
  });
});

// ========== 6.2 侧边栏导航 ==========

test.describe('侧边栏导航', () => {
  test('R07 导航项完整显示', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await expect(page.getByRole('link', { name: '对话' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '模块' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '设置' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '管理' }).first()).toBeVisible();
  });

  test('R08 点击 "对话" 导航', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    await page.getByRole('link', { name: '对话' }).first().click();
    await page.waitForURL(/\/chat/, { timeout: 5000 });
    await expect(page).toHaveURL(/\/chat/);
  });

  test('R09 点击 "模块" 导航', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.getByRole('link', { name: '模块' }).first().click();
    await page.waitForURL('/modules', { timeout: 5000 });
    await expect(page).toHaveURL('/modules');
  });

  test('R10 点击 "设置" 导航', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.getByRole('link', { name: '设置' }).first().click();
    await page.waitForURL('/settings', { timeout: 5000 });
    await expect(page).toHaveURL('/settings');
  });

  test('R11 点击 "管理" 导航', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.getByRole('link', { name: '管理' }).first().click();
    await page.waitForURL('/admin', { timeout: 5000 });
    await expect(page).toHaveURL('/admin');
    await expect(page.locator('h1')).toContainText('管理面板');
  });

  test('R11b 离开 Chat 页面后 sessions 轮询停止', async ({ page }) => {
    // 进入 chat 页，等待首次请求完成
    await page.goto('/chat');
    await page.waitForTimeout(800);

    // 开始拦截 /api/sessions GET 请求，统计数量
    let sessionsGetCount = 0;
    await page.route('**/api/sessions', (route, request) => {
      if (request.method() === 'GET') sessionsGetCount++;
      return route.continue();
    });

    // 导航到 /modules（离开 chat 页）
    await page.getByRole('link', { name: '模块' }).first().click();
    await page.waitForURL('/modules', { timeout: 5000 });

    // 离开后静等 6s（原 bug：5s 轮询会继续触发）
    await page.waitForTimeout(6500);

    // 离开 chat 页后不应再有 sessions 请求
    expect(sessionsGetCount).toBe(0);
  });

  test('R12 退出登录', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    await page.click('[title="退出登录"]');
    await page.waitForURL('/login', { timeout: 5000 });
    await expect(page).toHaveURL('/login');
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    expect(token).toBeNull();
  });
});
