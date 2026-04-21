import { test, expect } from '@playwright/test';
import { waitForBackend, login } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 7.1 移动端 (375x667) ==========

test.describe('响应式 - 移动端', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  // 登录页测试需无 auth 状态（auth.setup 会自动跳转已登录用户）
  test.describe('登录页（无 auth）', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('V01 登录页居中无溢出', async ({ page }) => {
      await page.goto('/login');
      await page.waitForSelector('form', { timeout: 15000 });
      const noOverflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
      expect(noOverflow).toBe(true);
    });

    test('V02 登录页移动端截图', async ({ page }) => {
      await page.goto('/login');
      await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
      await expect(page).toHaveScreenshot('login-mobile.png', { maxDiffPixelRatio: 0.05 });
    });
  });

  test('V03 布局侧边栏隐藏', async ({ page }) => {
    await page.goto('/chat');
    // 桌面侧边栏 (hidden lg:flex) 应不可见
    const desktopSidebar = page.locator('aside.hidden.lg\\:flex');
    // 在移动端该元素 display:none
    await expect(desktopSidebar).not.toBeVisible();
  });

  test('V04 头部汉堡菜单可见', async ({ page }) => {
    await page.goto('/chat');
    const menuBtn = page.locator('header button').first();
    await expect(menuBtn).toBeVisible();
  });

  test('V05 点击汉堡打开移动侧边栏', async ({ page }) => {
    await page.goto('/chat');
    const mobileSidebar = page.locator('aside.fixed');
    const overlay = page.locator('.fixed.inset-0.z-40');
    // sidebarOpen 初始 true，侧边栏应已可见；先关闭（点击遮罩右侧，避开 aside 的 192px）
    if (await mobileSidebar.first().isVisible().catch(() => false)) {
      await overlay.click({ position: { x: 340, y: 300 } });
      await page.waitForTimeout(300);
    }
    // 点击汉堡打开
    await page.locator('header button').first().click();
    await page.waitForTimeout(300);
    await expect(mobileSidebar.first()).toBeVisible({ timeout: 3000 });
  });

  test('V06 点击遮罩关闭移动侧边栏', async ({ page }) => {
    await page.goto('/chat');
    const mobileSidebar = page.locator('aside.fixed');
    // 确保打开
    if (!await mobileSidebar.first().isVisible().catch(() => false)) {
      await page.locator('header button').first().click();
      await page.waitForTimeout(300);
    }
    // 点遮罩右侧（x=340 在 aside 外、在 viewport 375 内）
    const overlay = page.locator('.fixed.inset-0.z-40');
    await overlay.click({ position: { x: 340, y: 300 } });
    await page.waitForTimeout(400);
    await expect(mobileSidebar.first()).not.toBeVisible({ timeout: 3000 });
  });

  test('V07 聊天页会话侧边栏隐藏', async ({ page }) => {
    await page.goto('/chat');
    // 会话侧边栏 (hidden md:flex) 在移动端不可见
    const chatSidebar = page.locator('.w-56.hidden');
    // 该元素在移动端隐藏
    await expect(chatSidebar).not.toBeVisible();
  });
});

// ========== 7.2 桌面端 (1280x720) ==========

test.describe('响应式 - 桌面端', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('V08 无水平溢出', async ({ page }) => {
    await page.goto('/chat');
    const noOverflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
  });

  test('V09 侧边栏正常显示', async ({ page }) => {
    await page.goto('/chat');
    // 桌面侧边栏可见
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();
  });

  test('V10 聊天会话侧边栏显示', async ({ page }) => {
    await page.goto('/chat');
    // 会话侧边栏 w-56 可见
    const chatSidebar = page.locator('.w-56');
    await expect(chatSidebar.first()).toBeVisible();
  });
});
