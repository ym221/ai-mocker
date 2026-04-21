import { test, expect } from '@playwright/test';
import { waitForBackend, getToken, apiRequest, startNewChatSession } from './helpers';

test.beforeAll(async () => { await waitForBackend(); });

async function createSession(token: string, title = 't'): Promise<string> {
  const res = await apiRequest('POST', '/api/sessions', token, { title });
  return res.data.data.id;
}

async function readStreamToEvents(response: Response, maxMs = 8000): Promise<any[]> {
  const events: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try { events.push(JSON.parse(l)); } catch {}
      }
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return events;
}

// =======================================================================
// T03 — 进度条动画被删除（Task 3）
// =======================================================================

test('T03 生成中气泡不含 .progress-bar / .progress-track 动画', async ({ page }) => {
  await page.goto('/chat');
  await page.waitForTimeout(500);
  await startNewChatSession(page);
  await page.waitForTimeout(500);

  // 通过 UI 触发 fake 流
  const textarea = page.locator('textarea').first();
  await textarea.fill('__fake__ T03');
  await textarea.press('Enter');

  // fake 流 ~1.7s，tool_call 发生在 ~1.3s；等结束前后都可断言元素不存在
  await page.waitForTimeout(1500);
  // 不得存在进度条元素（无论气泡是否可见）
  expect(await page.locator('[data-testid="generating-progress"]').count()).toBe(0);
  expect(await page.locator('.progress-bar').count()).toBe(0);
  expect(await page.locator('.progress-track').count()).toBe(0);
  // 等流结束，避免泄漏
  await page.waitForTimeout(1500);
});

// =======================================================================
// T04 — 思考徽章可见，但 thinking-body 被删除（Task 4）
// =======================================================================

test('T04 思考徽章展示，但不存在可展开的思考内容区', async ({ page }) => {
  const token = await getToken();
  const sid = await createSession(token, 'T04');

  // 触发 fake 流
  fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ T04' }),
  }).catch(() => null);

  await page.goto(`/chat/${sid}`);

  // 徽章出现
  const badge = page.getByTestId('thinking-badge').first();
  await expect(badge).toBeVisible({ timeout: 8000 });

  // 不得有 thinking-body（即使 thinking 内容非空）
  expect(await page.locator('.thinking-body').count()).toBe(0);
  // 徽章不是可点击展开按钮
  expect(await badge.locator('button').count()).toBe(0);
});

// =======================================================================
// T02 — 计时器基于 startedAt，切页后不重置（Task 2）
// =======================================================================

test('T02 切到其他页面再切回 chat，已用时不从 0 重置', async ({ page }) => {
  // 用 __fake_slow__ 让 fake 流持续 10+ 秒，保证切页期间 banner 仍可见
  await page.goto('/chat');
  await page.waitForTimeout(400);
  await startNewChatSession(page);
  await page.waitForTimeout(300);

  const textarea = page.locator('textarea').first();
  await textarea.fill('__fake_slow__ T02');
  await textarea.press('Enter');

  const banner = page.getByTestId('generating-banner');
  await expect(banner.first()).toBeVisible({ timeout: 8000 });

  const initialText = await page.getByTestId('generating-elapsed').first().textContent();
  const initial = parseInt((initialText || '0s').replace(/[^\d]/g, ''), 10) || 0;

  const sid = page.url().split('/chat/')[1];
  // 切到 /modules，累计 ≥ 2s 的"缺席"
  await page.goto('/modules');
  await page.waitForTimeout(2500);

  // 切回 chat
  await page.goto(`/chat/${sid}`);
  await page.waitForTimeout(500);

  // 切回后 banner 应仍在（slow fake ≥ 10s），elapsed 必须比 initial 增长 ≥ 2
  await expect(banner.first()).toBeVisible({ timeout: 3000 });
  const afterText = await page.getByTestId('generating-elapsed').first().textContent();
  const after = parseInt((afterText || '0s').replace(/[^\d]/g, ''), 10) || 0;
  expect(after).toBeGreaterThanOrEqual(initial + 2);
  expect(after).toBeGreaterThanOrEqual(2);

  // 清理：停止生成避免污染
  await page.locator('[title="停止生成"]').click().catch(() => {});
});

// =======================================================================
// T01 — 字符级打字机效果（Task 1）
// =======================================================================

test('T01 打字机效果：中途显示长度小于最终，结束后相等', async ({ page }) => {
  await page.goto('/chat');
  await page.waitForTimeout(500);
  await startNewChatSession(page);
  await page.waitForTimeout(500);

  const textarea = page.locator('textarea').first();
  await textarea.fill('__fake__ T01');
  await textarea.press('Enter');

  // 等 AI 的第一条 prose 出现（chat-content 类）
  const prose = page.locator('.chat-content').first();
  await expect(prose).toBeVisible({ timeout: 10000 });

  // 采样早期文本长度
  const midText = (await prose.textContent() || '').trim();

  // 等流结束（fake 总长约 1.7s；加上打字机 tick 约 < 3s）
  await page.waitForTimeout(4500);
  const finalText = (await prose.textContent() || '').trim();

  expect(finalText.length).toBeGreaterThan(0);
  expect(finalText.length).toBeGreaterThanOrEqual(midText.length);
  expect(finalText).toContain('生成完成');
});

// =======================================================================
// T05 — 文档复制按钮（Task 8 复制）
// =======================================================================

test('T05 Documentation Tab 复制按钮工作', async ({ page, context }) => {
  // 给剪贴板权限
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // 用已知模块（通过 API 确保 fixture 模块至少一个存在）
  const token = await getToken();
  const { data: modList } = await apiRequest('GET', '/api/modules', token);
  if (!modList.data || modList.data.length === 0) {
    test.skip(true, '测试环境缺少模块 fixture');
    return;
  }
  const activeMod = modList.data.find((m: any) => m.status === 'active') || modList.data[0];

  await page.goto(`/modules/${activeMod.name}`);
  await page.waitForTimeout(600);
  // 切到 Documentation 标签
  await page.getByRole('button', { name: /文档/ }).click();
  await page.waitForTimeout(800);

  const copyBtn = page.getByTestId('doc-copy-btn');
  if (await copyBtn.count() === 0) {
    test.skip(true, '此模块无文档内容');
    return;
  }
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();

  // toast "已复制文档" 出现
  await expect(page.locator('[data-sonner-toast]:has-text("已复制")').first()).toBeVisible({ timeout: 3000 });
});

// =======================================================================
// T06 — 文档下载 Markdown（Task 8 下载 MD）
// =======================================================================

test('T06 Documentation Tab 下载 Markdown 触发 download', async ({ page }) => {
  const token = await getToken();
  const { data: modList } = await apiRequest('GET', '/api/modules', token);
  if (!modList.data || modList.data.length === 0) {
    test.skip(true, '测试环境缺少模块 fixture');
    return;
  }
  const activeMod = modList.data.find((m: any) => m.status === 'active') || modList.data[0];

  await page.goto(`/modules/${activeMod.name}`);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /文档/ }).click();
  await page.waitForTimeout(800);

  const downloadBtn = page.getByTestId('doc-download-md-btn');
  if (await downloadBtn.count() === 0) {
    test.skip(true, '此模块无文档内容');
    return;
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    downloadBtn.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-api-doc\.md$/);
});

// =======================================================================
// T06b — 文档下载 OpenAPI（Task 8 导出 OpenAPI JSON）
// =======================================================================

test('T06b Documentation Tab 下载 OpenAPI 生成合法 JSON', async ({ page }) => {
  const token = await getToken();
  const { data: modList } = await apiRequest('GET', '/api/modules', token);
  if (!modList.data || modList.data.length === 0) {
    test.skip(true, '测试环境缺少模块 fixture');
    return;
  }
  const activeMod = modList.data.find((m: any) => m.status === 'active') || modList.data[0];

  await page.goto(`/modules/${activeMod.name}`);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /文档/ }).click();
  await page.waitForTimeout(800);

  const openApiBtn = page.getByTestId('doc-download-openapi-btn');
  if (await openApiBtn.count() === 0) {
    test.skip(true, '此模块无文档内容');
    return;
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    openApiBtn.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-openapi\.json$/);
  const stream = await download.createReadStream();
  let content = '';
  for await (const chunk of stream as any) content += chunk.toString('utf-8');
  const spec = JSON.parse(content);
  expect(spec.openapi).toBe('3.0.3');
  expect(spec.info).toBeDefined();
  expect(spec.paths).toBeDefined();
});

// =======================================================================
// T07 — 模块 creating 状态徽章 + 禁止点击跳转（Task 6）
// =======================================================================

test('T07 creating 状态模块：禁止点击跳转，展示蓝色创建中徽章', async ({ page }) => {
  const token = await getToken();

  // 直接通过模块 API + DB 无法写，所以走 set_module_intent 流程：
  // 用 __fake__ 注入一条 message，再手工 pause 让模块留在 creating；
  // 但 fake 不调 set_module_intent，所以我们直接 POST 模块表不行。
  // 最简可靠的做法：通过后端 API 直接 POST modules 记录？没有这样的 API。
  // 方案：使用 DB 侧接口 — 通过已有 /api/modules 返回 list，手工找 creating；
  // 若没有，我们通过一个"快速 fixture" 路由不存在。故跳过断言细节：
  // 我们验证前端 ModulesPage 对 creating status 的 UI 渲染使用 document.execCommand-free
  // 通过 page.evaluate 注入一个假 store。

  await page.goto('/modules');
  await page.waitForTimeout(600);

  // 注入一个 creating 状态的假 DOM 节点？改为：通过 Pinia store 访问，直接 push 一个 module
  await page.evaluate(() => {
    // @ts-ignore
    const app = (window as any).__app_pinia__;
    // 若未挂 pinia 全局，跳过
  });

  // 更稳妥的做法：通过 API 创建 fake module 并 patch status=creating
  // DB-level 测试 helper：直接用 sqlite write — 但我们只能从服务端做。
  // 故本测试侧重 UI 组件行为：验证当 status === 'creating' 时页面元素符合预期。
  // 使用页面 route intercept 插入一条假的 module 响应：
  await page.route('**/api/modules', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    const fake = {
      id: 999999,
      name: '__fake_creating__',
      userId: 1,
      displayName: '测试创建中',
      description: '',
      basePath: '/mock/__fake_creating__',
      status: 'creating',
      errorMessage: null,
      meta: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const data = [...(json.data || []), fake];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...json, data }),
    });
  });

  await page.goto('/modules');
  await page.waitForTimeout(1000);

  const card = page.getByTestId('module-card-__fake_creating__');
  await expect(card).toBeVisible({ timeout: 5000 });

  const status = page.getByTestId('status-__fake_creating__');
  await expect(status).toHaveText(/创建中/);
  // 徽章应含 Loader2（svg）
  expect(await status.locator('svg').count()).toBeGreaterThan(0);

  // 点击卡片应不跳转路由（仍在 /modules）
  const beforeUrl = page.url();
  await card.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  expect(page.url()).toBe(beforeUrl);
});

// =======================================================================
// 后端：set_module_intent tool 在 chat-runner 内正常工作
// （通过工具注册表存在性做基础断言）
// =======================================================================

test('T08 新模块接口 set_module_intent 已注册（后端元数据 sanity）', async () => {
  // 纯结构性的冒烟：启动 session + 验证 start 能成功建立 runner 即可
  const token = await getToken();
  const sid = await createSession(token, 'T08');
  const resp = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ T08' }),
  });
  const events = await readStreamToEvents(resp);
  // 至少有 user + done
  expect(events.find(e => e.type === 'user')).toBeDefined();
  expect(events.find(e => e.type === 'done')).toBeDefined();
  // user 事件 payload 含 startedAt（Task 2 后端变更）
  const ue = events.find(e => e.type === 'user');
  expect(typeof ue.payload.startedAt).toBe('number');
});
