import { test, expect } from '@playwright/test';
import { waitForBackend, login, expectToast } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

// ========== 3.1 UI 渲染验证 ==========

test.describe('设置页 - UI 渲染', () => {
  test('S01 页面标题和标签', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toContainText('设置');
    await expect(page.getByRole('button', { name: 'AI 服务商' })).toBeVisible();
    await expect(page.getByRole('button', { name: '项目预设' })).toBeVisible();
  });

  test('S02 默认显示 Providers 标签', async ({ page }) => {
    await page.goto('/settings');
    const provTab = page.getByRole('button', { name: 'AI 服务商' });
    await expect(provTab).toHaveClass(/border-primary/);
    await expect(page.getByText('配置用于生成 Mock API 的 AI 服务商')).toBeVisible();
  });

  test('S03 Provider 列表渲染', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    // 列表项应显示名称和操作按钮
    const items = page.locator('.border.border-border.rounded-lg.p-4');
    const count = await items.count();
    if (count > 0) {
      // 第一项有编辑和删除按钮（svg 图标）
      await expect(items.first().locator('button').first()).toBeVisible();
    }
  });
});

// ========== 3.2 Provider CRUD ==========

test.describe('设置页 - Provider CRUD', () => {
  test('S04 点击 Add Provider 打开模态框', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    // 模态框出现
    await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible();
    await expect(page.locator('h3')).toContainText('添加服务商');
    // 表单字段可见
    await expect(page.locator('input[placeholder="我的 OpenAI 服务商"]')).toBeVisible();
    await expect(page.locator('input[placeholder="gpt-4o-mini"]')).toBeVisible();
  });

  test('S05 Provider 表单字段 placeholder', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    await expect(page.locator('input[placeholder="我的 OpenAI 服务商"]')).toBeVisible();
    await expect(page.locator('input[placeholder="https://api.openai.com/v1"]')).toBeVisible();
    await expect(page.locator('input[placeholder="gpt-4o-mini"]')).toBeVisible();
  });

  test('S06 Type 下拉选项', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    const select = page.locator('select').first();
    const options = await select.locator('option').allTextContents();
    expect(options).toContain('OpenAI');
    expect(options).toContain('Anthropic');
    expect(options).toContain('Google');
  });

  test('S07 创建 Provider 成功', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    await page.fill('input[placeholder="我的 OpenAI 服务商"]', `Test Prov ${Date.now().toString(36)}`);
    await page.fill('input[placeholder="gpt-4o-mini"]', 'gpt-test');
    await page.click('button:has-text("保存")');
    await expectToast(page, '服务商已保存');
    // 模态框应关闭
    await expect(page.locator('.fixed.inset-0.z-50')).not.toBeVisible({ timeout: 3000 });
  });

  test('S08 创建 Provider 验证', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    // 不填 name 和 model 直接保存
    await page.click('button:has-text("保存")');
    await expectToast(page, '名称和模型为必填项');
    // 模态框不关闭
    await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible();
  });

  test('S09 取消关闭模态框', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible();
    await page.click('button:has-text("取消")');
    await expect(page.locator('.fixed.inset-0.z-50')).not.toBeVisible({ timeout: 3000 });
  });

  test('S10 点击背景关闭模态框', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=添加服务商');
    await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible();
    // 点击遮罩层（.self 修饰符确保只有遮罩本身触发）
    await page.locator('.fixed.inset-0.z-50').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.fixed.inset-0.z-50')).not.toBeVisible({ timeout: 3000 });
  });

  test('S11 编辑 Provider 预填数据', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    // 找到编辑按钮（Pencil 图标）
    const editBtn = page.locator('.border.border-border.rounded-lg.p-4 button').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('h3')).toContainText('编辑服务商');
      // 表单应预填
      const nameInput = page.locator('input[placeholder="我的 OpenAI 服务商"]');
      const nameValue = await nameInput.inputValue();
      expect(nameValue.length).toBeGreaterThan(0);
    }
  });

  test('S12 编辑 Provider API Key 提示', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    const editBtn = page.locator('.border.border-border.rounded-lg.p-4 button').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('input[placeholder="留空保持不变"]')).toBeVisible();
    }
  });

  test('S13 更新 Provider 成功', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    const editBtn = page.locator('.border.border-border.rounded-lg.p-4 button').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      const nameInput = page.locator('input[placeholder="我的 OpenAI 服务商"]');
      await nameInput.clear();
      await nameInput.fill(`Updated ${Date.now().toString(36)}`);
      await page.click('button:has-text("保存")');
      await expectToast(page, '服务商已更新');
    }
  });

  test('S14 删除 Provider', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    // 记录当前列表数量
    const itemsBefore = await page.locator('button.text-destructive').count();
    // 用 API 创建一个 Provider
    const token = await page.evaluate(() => localStorage.getItem('mockforge_token'));
    await fetch('http://localhost:3000/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'WillDelete', type: 'openai', defaultModel: 'gpt-test' }),
    });
    await page.reload();
    await page.waitForTimeout(500);
    // 新增了一个，删除按钮多了一个
    const itemsAfter = await page.locator('button.text-destructive').count();
    expect(itemsAfter).toBeGreaterThan(itemsBefore);
    // 点击最后一个删除按钮（刚创建的在最后）→ 自定义确认弹窗
    await page.locator('button.text-destructive').last().click();
    await page.getByTestId('confirm-ok').click();
    await expectToast(page, '服务商已删除');
  });

  test('S15 取消删除 Provider', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    const deleteButtons = page.locator('button.text-destructive');
    const countBefore = await deleteButtons.count();
    if (countBefore > 0) {
      await deleteButtons.first().click();
      await page.getByTestId('confirm-cancel').click();
      await page.waitForTimeout(500);
      // 取消后数量不变
      const countAfter = await deleteButtons.count();
      expect(countAfter).toBe(countBefore);
    }
  });
});

// ========== 3.3 Preset CRUD ==========

test.describe('设置页 - Preset CRUD', () => {
  test('S16 切换到 Presets 标签', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await expect(page.getByText('定义项目预设，统一 API 生成规范')).toBeVisible();
    await expect(page.getByText('添加预设')).toBeVisible();
  });

  test('S17 点击 Add Preset 打开模态框', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.click('text=添加预设');
    await expect(page.locator('h3')).toContainText('添加预设');
    await expect(page.locator('input[placeholder="企业 API 规范"]')).toBeVisible();
  });

  test('S18 Preset 表单字段 placeholder', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.click('text=添加预设');
    await expect(page.locator('input[placeholder="企业 API 规范"]')).toBeVisible();
    await expect(page.locator('textarea[placeholder="预设描述"]')).toBeVisible();
  });

  test('S19 创建 Preset 成功', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.click('text=添加预设');
    await page.fill('input[placeholder="企业 API 规范"]', `Preset ${Date.now().toString(36)}`);
    // 填写 content（JSON）
    const contentTextarea = page.locator('textarea.font-mono');
    await contentTextarea.fill('{"format":"json"}');
    await page.click('button:has-text("保存")');
    await expectToast(page, '预设已保存');
  });

  test('S20 创建 Preset 验证', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.click('text=添加预设');
    await page.click('button:has-text("保存")');
    await expectToast(page, '名称为必填项');
  });

  test('S21 编辑 Preset', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.waitForTimeout(500);
    const editBtn = page.locator('.border.border-border.rounded-lg.p-4 button').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('h3')).toContainText('编辑预设');
      const nameInput = page.locator('input[placeholder="企业 API 规范"]');
      await nameInput.clear();
      await nameInput.fill(`Edited ${Date.now().toString(36)}`);
      await page.click('button:has-text("保存")');
      await expectToast(page, '预设已更新');
    }
  });

  test('S22 删除 Preset', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    const uniqueName = `PDel${Date.now().toString(36)}`;
    // 先创建一个用于删除
    await page.click('text=添加预设');
    await page.fill('input[placeholder="企业 API 规范"]', uniqueName);
    await page.locator('textarea.font-mono').fill('{}');
    await page.click('button:has-text("保存")');
    await page.waitForTimeout(1000);
    const item = page.locator('.border.border-border.rounded-lg.p-4', { hasText: uniqueName }).first();
    await item.locator('button.text-destructive').click();
    await page.getByTestId('confirm-ok').click();
    await expectToast(page, '预设已删除');
  });
});

// ========== 3.4 空状态 ==========

test.describe('设置页 - 空状态', () => {
  test('S23 Provider 空列表文字', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(500);
    // 如果没有 provider，应显示空状态文字
    const items = page.locator('.border.border-border.rounded-lg.p-4');
    const count = await items.count();
    if (count === 0) {
      await expect(page.getByText('暂无服务商配置')).toBeVisible();
    } else {
      // 有 provider 则验证列表非空
      expect(count).toBeGreaterThan(0);
    }
  });

  test('S24 Preset 空列表文字', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: '项目预设' }).click();
    await page.waitForTimeout(500);
    const items = page.locator('.border.border-border.rounded-lg.p-4');
    const count = await items.count();
    if (count === 0) {
      await expect(page.getByText('暂无预设配置')).toBeVisible();
    } else {
      expect(count).toBeGreaterThan(0);
    }
  });
});
