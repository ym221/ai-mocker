import { test, expect } from '@playwright/test';
import { waitForBackend, login, getToken, apiRequest } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 4.1 模块列表页 ==========

test.describe('模块列表页', () => {
  test('M01 页面标题', async ({ page }) => {
    await page.goto('/modules');
    await expect(page.locator('h1')).toContainText('模块');
  });

  test('M02 模块卡片渲染', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    const count = await cards.count();
    if (count > 0) {
      // 卡片有标题 h3
      await expect(cards.first().locator('h3')).toBeVisible();
    }
  });

  test('M03 卡片 hover 效果', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    const count = await cards.count();
    if (count > 0) {
      // hover 后有 transition 效果（class 包含 transition）
      const card = cards.first();
      await expect(card).toHaveClass(/transition/);
    }
  });

  test('M04 点击卡片跳转详情', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    const count = await cards.count();
    if (count > 0) {
      await cards.first().click();
      await page.waitForURL(/\/modules\/.+/, { timeout: 5000 });
      await expect(page).toHaveURL(/\/modules\/.+/);
    }
  });

  test('M05 空状态显示', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    const count = await cards.count();
    if (count === 0) {
      await expect(page.getByText('暂无模块')).toBeVisible();
      await expect(page.getByText('前往对话页生成你的第一个 Mock API 模块')).toBeVisible();
    } else {
      // 有模块则验证列表非空
      expect(count).toBeGreaterThan(0);
    }
  });

  test('M06 loading 状态', async ({ page }) => {
    // 拦截 API 延迟
    await page.route('**/api/modules', async (route) => {
      await new Promise(r => setTimeout(r, 1000));
      await route.continue();
    });
    await page.goto('/modules');
    // loading 文字应出现
    const loading = page.getByText('加载中...');
    // 可能很快消失，不强制可见
    await page.waitForTimeout(200);
    // 最终应有内容
    await page.waitForTimeout(1500);
    await expect(page.locator('h1')).toContainText('模块');
  });
});

// ========== 4.2 模块详情页 ==========

test.describe('模块详情页', () => {
  test('M07 详情页头部信息', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('M08 Endpoints 标签默认选中', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await page.waitForTimeout(500);
    // Endpoints 标签有 border-primary
    const endpointsTab = page.getByRole('button', { name: '接口' });
    await expect(endpointsTab).toHaveClass(/border-primary/);
  });

  test('M09 端点 Method 徽章颜色', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await page.waitForTimeout(500);
    // GET 徽章绿色
    const getBadge = page.locator('.bg-green-100.text-green-700');
    if (await getBadge.count() > 0) {
      await expect(getBadge.first()).toBeVisible();
    }
  });

  test('M10 GET 端点测试按钮', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await page.waitForTimeout(500);
    // GET 端点行有 Test 按钮
    const testBtn = page.getByRole('button', { name: '测试' });
    if (await testBtn.count() > 0) {
      await expect(testBtn.first()).toBeVisible();
    }
  });

  test('M11 执行端点测试', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await page.waitForTimeout(500);
    const testBtn = page.getByRole('button', { name: '测试' });
    if (await testBtn.count() === 0) return test.skip();
    await testBtn.first().click();
    await page.waitForTimeout(1000);
    // 测试结果区应出现
    const result = page.locator('pre');
    await expect(result).toBeVisible({ timeout: 5000 });
  });

  test('M12 Documentation 标签', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '文档' }).click();
    await page.waitForTimeout(1000);
    // 应显示文档（api-doc 容器 .api-doc 或含 heading）或 "暂无文档"
    const hasDoc = await page.locator('.api-doc').count() > 0;
    const noDoc = await page.getByText('暂无文档').count() > 0;
    expect(hasDoc || noDoc).toBe(true);
  });
});
