import { test, expect } from '@playwright/test';
import { waitForBackend, expectToast } from './helpers';

// 登录页测试需要未认证状态
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(async () => { await waitForBackend(); });

// ========== 1.1 UI 渲染验证 ==========

test.describe('登录页 - UI 渲染', () => {
  test('L01 页面标题和品牌信息', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toContainText('AI Mock');
    await expect(page.getByText('AI 驱动的 Mock API 平台')).toBeVisible();
  });

  test('L02 登录表单完整渲染', async ({ page }) => {
    await page.goto('/login');
    // Login / Register 标签按钮
    await expect(page.getByRole('button', { name: '登录' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '注册' })).toBeVisible();
    // 输入框
    await expect(page.locator('input[placeholder="请输入用户名"]')).toBeVisible();
    await expect(page.locator('input[placeholder="请输入密码"]')).toBeVisible();
    // 提交按钮
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toBeVisible();
    await expect(submit).toContainText('登录');
  });

  test('L03 默认选中 Login 标签', async ({ page }) => {
    await page.goto('/login');
    const loginTab = page.getByRole('button', { name: '登录' }).first();
    const registerTab = page.getByRole('button', { name: '注册' });
    await expect(loginTab).toHaveClass(/border-primary/);
    await expect(registerTab).not.toHaveClass(/border-primary/);
  });

  test('L04 表单居中布局', async ({ page }) => {
    await page.goto('/login');
    // 页面使用 flex items-center justify-center
    const container = page.locator('.min-h-screen.flex.items-center.justify-center');
    await expect(container).toBeVisible();
    // 表单容器 max-w-sm
    const formWrapper = page.locator('.max-w-sm');
    await expect(formWrapper).toBeVisible();
  });
});

// ========== 1.2 标签切换交互 ==========

test.describe('登录页 - 标签切换', () => {
  test('L05 切换到注册标签', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    // 出现确认密码框
    await expect(page.locator('input[placeholder="请再次输入密码"]')).toBeVisible();
    // 密码框变为 2 个
    await expect(page.locator('input[type="password"]')).toHaveCount(2);
    // 提交按钮文字变为 Register
    await expect(page.locator('button[type="submit"]')).toContainText('注册');
  });

  test('L06 切换回登录标签', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    await page.getByRole('button', { name: '登录' }).first().click();
    // 确认密码框消失
    await expect(page.locator('input[placeholder="请再次输入密码"]')).not.toBeVisible();
    // 密码框恢复 1 个
    await expect(page.locator('input[type="password"]')).toHaveCount(1);
    // 提交按钮文字恢复
    await expect(page.locator('button[type="submit"]')).toContainText('登录');
  });

  test('L07 标签高亮跟随切换', async ({ page }) => {
    await page.goto('/login');
    // 标签区内的两个按钮（不含 submit）
    const tabs = page.locator('.border-b.border-border button');
    await tabs.nth(1).click(); // 点击 Register tab
    const loginTab = tabs.nth(0);
    const registerTab = tabs.nth(1);
    await expect(registerTab).toHaveClass(/border-primary/);
    await expect(loginTab).not.toHaveClass(/border-primary/);
  });
});

// ========== 1.3 登录功能 ==========

test.describe('登录页 - 登录功能', () => {
  test('L08 正确凭据登录成功', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[placeholder="请输入用户名"]', 'admin');
    await page.fill('input[placeholder="请输入密码"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 15000 });
    await expect(page).toHaveURL(/\/chat/);
    // localStorage 有 token
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    expect(token).toBeTruthy();
  });

  test('L09 登录过程 loading 状态', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[placeholder="请输入用户名"]', 'admin');
    await page.fill('input[placeholder="请输入密码"]', 'admin123');
    // 拦截 API 延迟响应以捕获 loading 态
    await page.route('**/api/auth/login', async (route) => {
      await new Promise(r => setTimeout(r, 500));
      await route.continue();
    });
    await page.click('button[type="submit"]');
    // loading 中按钮应显示 Processing... 且 disabled
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toContainText('处理中...');
    await expect(submit).toBeDisabled();
    // 等登录完成
    await page.waitForURL(/\/chat/, { timeout: 15000 });
  });

  test('L10 错误密码停留登录页', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[placeholder="请输入用户名"]', 'admin');
    await page.fill('input[placeholder="请输入密码"]', 'wrongpassword');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/login/);
  });

  test('L11 不存在用户登录失败', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[placeholder="请输入用户名"]', 'nonexistentuser999');
    await page.fill('input[placeholder="请输入密码"]', 'anypassword');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/login/);
  });
});

// ========== 1.4 表单验证 ==========

test.describe('登录页 - 表单验证', () => {
  test('L12 空字段提交拦截', async ({ page }) => {
    await page.goto('/login');
    await page.click('button[type="submit"]');
    await expectToast(page, '请填写所有字段');
  });

  test('L13 只填用户名提交', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[placeholder="请输入用户名"]', 'admin');
    await page.click('button[type="submit"]');
    await expectToast(page, '请填写所有字段');
  });

  test('L14 注册-用户名过短', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    await page.fill('input[placeholder="请输入用户名"]', 'ab');
    await page.fill('input[placeholder="请输入密码"]', '123456');
    await page.fill('input[placeholder="请再次输入密码"]', '123456');
    await page.click('button[type="submit"]');
    await expectToast(page, '用户名需 3-20 个字符');
  });

  test('L15 注册-密码过短', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    await page.fill('input[placeholder="请输入用户名"]', 'testuser');
    await page.fill('input[placeholder="请输入密码"]', '12345');
    await page.fill('input[placeholder="请再次输入密码"]', '12345');
    await page.click('button[type="submit"]');
    await expectToast(page, '密码至少 6 个字符');
  });

  test('L16 注册-密码不匹配', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    await page.fill('input[placeholder="请输入用户名"]', 'testuser');
    await page.fill('input[placeholder="请输入密码"]', '123456');
    await page.fill('input[placeholder="请再次输入密码"]', '654321');
    await page.click('button[type="submit"]');
    await expectToast(page, '两次密码不一致');
  });
});

// ========== 1.5 视觉回归 ==========

test.describe('登录页 - 视觉回归', () => {
  test('L17 登录页截图对比', async ({ page }) => {
    await page.goto('/login');
    await page.waitForSelector('button[type="submit"]');
    await expect(page).toHaveScreenshot('login-default.png', { maxDiffPixelRatio: 0.15 });
  });

  test('L18 注册标签截图对比', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '注册' }).click();
    await page.waitForSelector('input[placeholder="请再次输入密码"]');
    await expect(page).toHaveScreenshot('login-register.png', { maxDiffPixelRatio: 0.15 });
  });
});
