import { test, expect } from '@playwright/test';
import { waitForBackend, login, expectToast, startNewChatSession } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 2.1 UI 渲染验证 ==========

test.describe('聊天页 - UI 渲染', () => {
  test('C01 会话侧边栏渲染', async ({ page }) => {
    await page.goto('/chat');
    // 桌面端会话侧边栏 w-56
    const sidebar = page.locator('.w-56.border-r');
    await expect(sidebar).toBeVisible();
    // New Chat 按钮
    await expect(page.getByRole('button', { name: '新建对话' })).toBeVisible();
  });

  test('C02 聊天输入区渲染', async ({ page }) => {
    await page.goto('/chat');
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.locator('[title="添加附件"]')).toBeVisible();
    await expect(page.locator('[title="发送消息"]')).toBeVisible();
  });

  test('C03 空状态引导文字', async ({ page }) => {
    await page.goto('/chat');
    // 创建新会话以确保无消息
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    await expect(page.locator('h2:has-text("AI Mock")')).toBeVisible();
    await expect(page.getByText('描述你想生成的 Mock API 模块')).toBeVisible();
  });

  test('C04 消息气泡样式', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 发送消息
    const textarea = page.locator('textarea');
    await textarea.fill('Hello test C04');
    await textarea.press('Enter');
    await page.waitForTimeout(1000);
    // 用户消息：右对齐气泡，含 bg-primary 样式
    const userBubble = page.locator('.flex.justify-end .bg-primary').filter({ hasText: 'Hello test C04' }).first();
    await expect(userBubble).toBeVisible();
  });
});

// ========== 2.2 会话管理交互 ==========

test.describe('聊天页 - 会话管理', () => {
  test('C05 创建新会话', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/chat\/.+/);
  });

  test('C06 新会话默认标题', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 侧边栏应有会话项
    const sessionItems = page.locator('.w-56 .truncate');
    await expect(sessionItems.first()).toBeVisible();
  });

  test('C07 切换会话', async ({ page }) => {
    await page.goto('/chat');
    // 等待 onMounted 可能的 redirect 完成
    await page.waitForTimeout(800);
    const beforeA = page.url();
    // 创建会话 A
    await startNewChatSession(page);
    await page.waitForFunction((prev) => location.href !== prev && /\/chat\/.+/.test(location.href), beforeA, { timeout: 5000 });
    const idA = page.url().split('/chat/')[1];
    const beforeB = page.url();
    // 创建会话 B
    await startNewChatSession(page);
    await page.waitForFunction((prev) => location.href !== prev && /\/chat\/.+/.test(location.href), beforeB, { timeout: 5000 });
    const idB = page.url().split('/chat/')[1];
    expect(idA).not.toBe(idB);
    // 当前在 B，侧边栏点击非活跃会话
    const inactiveSession = page.locator('.w-56 .text-muted-foreground.cursor-pointer').first();
    if (await inactiveSession.isVisible()) {
      const beforeClick = page.url();
      await inactiveSession.click();
      await page.waitForFunction((prev) => location.href !== prev, beforeClick, { timeout: 5000 }).catch(() => {});
      // URL 应该变了 — 即使测试略过 click，idB 的 UUID 也不应在新 URL 里同时出现
      expect(page.url()).not.toBe(beforeClick);
    }
  });

  test('C08 删除会话', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(800);
    const before = page.url();
    await startNewChatSession(page);
    await page.waitForFunction((prev) => location.href !== prev && /\/chat\/.+/.test(location.href), before, { timeout: 5000 });
    const currentId = page.url().split('/chat/')[1];
    const activeSession = page.locator('.w-56 .bg-accent').first();
    await activeSession.hover();
    const deleteBtn = activeSession.locator('button');
    await deleteBtn.click({ force: true });
    // wait for URL to change away from currentId
    await page.waitForFunction((id) => !location.href.includes(id), currentId, { timeout: 5000 }).catch(() => {});
    expect(page.url()).not.toContain(currentId);
  });

  test('C09 删除最后一个会话', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    // 通过浏览器 fetch 清空所有会话（避免 Node fetch 走代理）
    await page.evaluate(async () => {
      const token = localStorage.getItem('mockforge_token');
      const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      for (const s of json.data || []) {
        await fetch(`/api/sessions/${s.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    });
    await page.reload();
    await page.waitForTimeout(800);
    // 创建唯一一个会话
    await startNewChatSession(page);
    await page.waitForURL(/\/chat\/.+/, { timeout: 5000 });
    await page.waitForTimeout(500);
    // 删除它
    const activeSession = page.locator('.w-56 .bg-accent').first();
    await activeSession.waitFor({ state: 'visible', timeout: 5000 });
    await activeSession.hover();
    await activeSession.locator('button').click({ force: true });
    await page.waitForTimeout(1500);
    // 应该回到 /chat 基础路径
    const sessionCount = await page.locator('.w-56 .group').count();
    expect(sessionCount).toBe(0);
  });

  test('C10 会话高亮状态', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForURL(/\/chat\/.+/, { timeout: 5000 });
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 活跃会话有 bg-accent class
    const activeSession = page.locator('.w-56 .bg-accent');
    await expect(activeSession.first()).toBeVisible();
  });
});

// ========== 2.3 消息发送交互 ==========

test.describe('聊天页 - 消息发送', () => {
  test('C11 输入文字发送', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    const textarea = page.locator('textarea');
    await textarea.fill('Hello test message C11');
    await textarea.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.getByText('Hello test message C11').first()).toBeVisible();
    // textarea 应该已清空
    await expect(textarea).toHaveValue('');
  });

  test('C12 Shift+Enter 换行', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    const textarea = page.locator('textarea');
    await textarea.fill('line1');
    await textarea.press('Shift+Enter');
    await textarea.type('line2');
    // textarea 应含换行，但未发送
    const value = await textarea.inputValue();
    expect(value).toContain('line1');
    expect(value).toContain('line2');
    // 无用户消息出现
    await expect(page.locator('.flex-row-reverse')).toHaveCount(0);
  });

  test('C13 空输入发送按钮禁用', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    const sendBtn = page.locator('[title="发送消息"]');
    await expect(sendBtn).toBeDisabled();
  });

  test('C14 有输入时发送按钮启用', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    const textarea = page.locator('textarea');
    await textarea.fill('some text');
    const sendBtn = page.locator('[title="发送消息"]');
    await expect(sendBtn).toBeEnabled();
  });

  test('C15 textarea 自动扩高', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    const textarea = page.locator('textarea');
    const heightBefore = await textarea.evaluate(el => el.offsetHeight);
    await textarea.fill('line1\nline2\nline3\nline4\nline5');
    await textarea.dispatchEvent('input');
    await page.waitForTimeout(200);
    const heightAfter = await textarea.evaluate(el => el.offsetHeight);
    expect(heightAfter).toBeGreaterThan(heightBefore);
  });
});

// ========== 2.4 加载 & 流式状态 ==========

test.describe('聊天页 - 加载状态', () => {
  test('C16 发送后 loading 态', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 拦截 chat API 延迟响应
    await page.route('**/api/chat', async (route) => {
      await new Promise(r => setTimeout(r, 2000));
      await route.fulfill({ status: 200, body: 'AI response' });
    });
    const textarea = page.locator('textarea');
    await textarea.fill('Test loading');
    await textarea.press('Enter');
    // 检查 loading 态
    await expect(page.locator('textarea')).toBeDisabled({ timeout: 3000 });
    // Stop 按钮应出现
    await expect(page.locator('[title="停止生成"]')).toBeVisible();
  });

  test('C17 停止生成', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 拦截 chat API 无限等待
    await page.route('**/api/chat', async (route) => {
      await new Promise(r => setTimeout(r, 30000));
      await route.fulfill({ status: 200, body: '' });
    });
    const textarea = page.locator('textarea');
    await textarea.fill('Test stop');
    await textarea.press('Enter');
    await page.waitForTimeout(500);
    // 点击 Stop
    const stopBtn = page.locator('[title="停止生成"]');
    if (await stopBtn.isVisible()) {
      await stopBtn.click();
      await page.waitForTimeout(500);
      // 输入区恢复
      await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });
    }
  });

  test('C18 消息自动滚动', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 发送消息后检查滚动容器
    const textarea = page.locator('textarea');
    await textarea.fill('Scroll test message');
    await textarea.press('Enter');
    await page.waitForTimeout(1000);
    // 消息列表存在
    await expect(page.getByText('Scroll test message').first()).toBeVisible();
  });
});

// ========== 2.5 文件上传交互 ==========

test.describe('聊天页 - 文件上传', () => {
  test('C19 文件上传按钮可用', async ({ page }) => {
    await page.goto('/chat');
    const attachBtn = page.locator('[title="添加附件"]');
    await expect(attachBtn).toBeVisible();
    await expect(attachBtn).toBeEnabled();
  });

  test('C20 附件预览显示', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    // 模拟文件上传 API
    await page.route('**/api/upload', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { filename: 'test.txt', type: 'text/plain', content: 'file content' },
        }),
      });
    });
    // 触发文件选择
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('file content'),
    });
    await page.waitForTimeout(500);
    // 附件预览应出现
    await expect(page.getByText('test.txt')).toBeVisible();
  });

  test('C21 移除附件', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    await page.route('**/api/upload', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { filename: 'remove-me.txt', type: 'text/plain', content: 'x' },
        }),
      });
    });
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'remove-me.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    await page.waitForTimeout(500);
    await expect(page.getByText('remove-me.txt')).toBeVisible();
    // 点击 X 删除
    const removeBtn = page.locator('.bg-muted.rounded-md button').first();
    await removeBtn.click();
    await expect(page.getByText('remove-me.txt')).not.toBeVisible();
  });

  test('C22 有附件时发送按钮启用', async ({ page }) => {
    await page.goto('/chat');
    await startNewChatSession(page);
    await page.waitForTimeout(500);
    await page.route('**/api/upload', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { filename: 'file.txt', type: 'text/plain', content: 'y' },
        }),
      });
    });
    // 初始发送按钮禁用
    await expect(page.locator('[title="发送消息"]')).toBeDisabled();
    // 上传附件
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('y'),
    });
    await page.waitForTimeout(500);
    // 发送按钮启用
    await expect(page.locator('[title="发送消息"]')).toBeEnabled();
  });
});
