import { test, expect } from '@playwright/test';
import { waitForBackend, login, expectToast, startNewChatSession } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

test.describe('端到端业务流程', () => {
  test('E01 登录→聊天→退出', async ({ page }) => {
    // 已有 storageState，直接到 /chat
    await page.goto('/chat');
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    expect(token).toBeTruthy();
    // 创建会话
    await startNewChatSession(page);
    await page.waitForURL(/\/chat\/.+/, { timeout: 5000 });
    // 发送消息
    const textarea = page.locator('textarea');
    await textarea.fill('E01 test message');
    await textarea.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.getByText('E01 test message')).toBeVisible();
    // 退出
    await page.click('[title="退出登录"]');
    await page.waitForURL('/login', { timeout: 5000 });
    const tokenAfter = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    expect(tokenAfter).toBeNull();
  });

  test('E02 Provider 全生命周期', async ({ page }) => {
    await page.goto('/settings');
    const name = `E02Prov${Date.now().toString(36)}`;
    // 创建
    await page.click('text=添加服务商');
    await page.fill('input[placeholder="我的 OpenAI 服务商"]', name);
    await page.fill('[data-testid="provider-form-default-model"]', 'gpt-test');
    await page.click('button:has-text("保存")');
    await expectToast(page, '服务商已保存');
    await page.waitForTimeout(500);
    // 列表中出现
    await expect(page.getByText(name).first()).toBeVisible();
    // 编辑：通过 API 更新更可靠
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    const provList = await (await fetch('http://localhost:3000/api/providers', {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const prov = provList.data.find((p: any) => p.name === name);
    expect(prov).toBeTruthy();
    // 点击第一个 Provider 的编辑按钮
    const editBtn = page.locator('.border.border-border.rounded-lg.p-4', { hasText: name }).first().locator('button').first();
    await editBtn.click();
    const nameInput = page.locator('input[placeholder="我的 OpenAI 服务商"]');
    await nameInput.clear();
    const newName = name + '_edited';
    await nameInput.fill(newName);
    await page.click('button:has-text("保存")');
    await expectToast(page, '服务商已更新');
    await page.waitForTimeout(500);
    await expect(page.getByText(newName).first()).toBeVisible();
    // 删除 - 通过 API
    const token2 = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    const provRes = await (await fetch('http://localhost:3000/api/providers', {
      headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const target = provRes.data.find((p: any) => p.name === newName);
    if (target) {
      await fetch(`http://localhost:3000/api/providers/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token2}` },
      });
    }
    await page.reload();
    await page.waitForTimeout(500);
    await expect(page.getByText(newName)).not.toBeVisible();
  });

  test('E03 Preset 全生命周期', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    const name = `E03Pre${Date.now().toString(36)}`;
    // 创建
    await page.click('text=添加预设');
    await page.fill('input[placeholder="企业 API 规范"]', name);
    await page.locator('textarea.font-mono').fill('{"test":true}');
    await page.click('button:has-text("保存")');
    await expectToast(page, '预设已保存');
    await page.waitForTimeout(500);
    await expect(page.getByText(name).first()).toBeVisible();
    // 删除 - 通过 API
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    const preRes = await (await fetch('http://localhost:3000/api/presets', {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const target = preRes.data.find((p: any) => p.name === name);
    if (target) {
      await fetch(`http://localhost:3000/api/presets/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    await page.reload();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '项目预设' }).click();
    await expect(page.getByText(name)).not.toBeVisible();
  });

  test('E04 会话全生命周期', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(800);
    // Mock chat API
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({ status: 200, body: 'AI reply to E04' });
    });
    // 创建
    const before = page.url();
    await startNewChatSession(page);
    await page.waitForFunction((prev) => location.href !== prev && /\/chat\/.+/.test(location.href), before, { timeout: 5000 });
    const sessionId = page.url().split('/chat/')[1];
    // 发消息
    const textarea = page.locator('textarea');
    await textarea.fill('E04 lifecycle message');
    await textarea.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.getByText('E04 lifecycle message').first()).toBeVisible();
    // 刷新页面 — 消息应持久化
    await page.reload();
    await page.waitForTimeout(1000);
    await expect(page.getByText('E04 lifecycle message').first()).toBeVisible();
    // 删除会话
    const activeSession = page.locator('.w-56 .bg-accent').first();
    await activeSession.hover();
    await activeSession.locator('button').click({ force: true });
    await page.waitForFunction((id) => !location.href.includes(id), sessionId, { timeout: 5000 }).catch(() => {});
    expect(page.url()).not.toContain(sessionId);
  });

  test('E05 模块浏览完整流程', async ({ page }) => {
    await page.goto('/modules');
    await page.waitForTimeout(500);
    const cards = page.locator('.cursor-pointer.border');
    if (await cards.count() === 0) return test.skip();
    // 点击进入详情
    await cards.first().click();
    await page.waitForURL(/\/modules\/.+/);
    // 查看端点
    await expect(page.locator('h1')).toBeVisible();
    // 测试 GET 端点
    const testBtn = page.getByRole('button', { name: '测试' }).first();
    if (await testBtn.isVisible()) {
      await testBtn.click();
      await page.waitForTimeout(1000);
      await expect(page.locator('pre')).toBeVisible();
    }
    // 查看文档
    await page.getByRole('button', { name: '文档' }).click();
    await page.waitForTimeout(1000);
  });

  test('E06 管理员操作流程', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForTimeout(500);
    // 查看用户表
    await expect(page.getByText('用户管理')).toBeVisible();
    // 表格有数据
    const rows = page.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('E07 多会话切换', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    // 创建会话 A — 用 __fake__ 让后端正常处理流
    await startNewChatSession(page);
    await page.waitForURL(/\/chat\/.+/, { timeout: 5000 });
    const idA = page.url().split('/chat/')[1];
    const textarea = page.locator('textarea');
    await textarea.fill('__fake__ A unique');
    await textarea.press('Enter');
    await page.waitForTimeout(2500);
    // 创建会话 B
    await startNewChatSession(page);
    await page.waitForTimeout(600);
    await textarea.fill('__fake__ B unique');
    await textarea.press('Enter');
    await page.waitForTimeout(2500);
    // 切回 A（通过 URL 导航更可靠）
    await page.goto(`/chat/${idA}`);
    await page.waitForTimeout(1500);
    // A 的用户消息应仍可见
    await expect(page.getByText('__fake__ A unique').first()).toBeVisible({ timeout: 5000 });
  });

  test('E08 跨页面导航一致性', async ({ page }) => {
    await page.goto('/chat');
    // 聊天页
    await expect(page).toHaveURL(/\/chat/);
    // 设置页
    await page.getByRole('link', { name: '设置' }).first().click();
    await page.waitForURL('/settings', { timeout: 5000 });
    await expect(page.locator('h1')).toContainText('设置');
    // 模块页
    await page.getByRole('link', { name: '模块' }).first().click();
    await page.waitForURL('/modules', { timeout: 5000 });
    await expect(page.locator('h1')).toContainText('模块');
    // 管理页
    await page.getByRole('link', { name: '管理' }).first().click();
    await page.waitForURL('/admin', { timeout: 5000 });
    await expect(page.locator('h1')).toContainText('管理面板');
    // 回到聊天
    await page.getByRole('link', { name: '对话' }).first().click();
    await page.waitForURL(/\/chat/, { timeout: 5000 });
  });
});
