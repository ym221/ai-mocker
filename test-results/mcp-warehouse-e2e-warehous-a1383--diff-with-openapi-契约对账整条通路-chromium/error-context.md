# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mcp-warehouse-e2e.spec.ts >> warehouse 端到端 MCP 闭环验证 >> W06 MCP get_mock_access_log + diff_with_openapi 契约对账整条通路
- Location: tests\mcp-warehouse-e2e.spec.ts:298:3

# Error details

```
TypeError: fetch failed
```

# Test source

```ts
  1   | import { type Page } from '@playwright/test';
  2   | import { existsSync, mkdirSync, writeFileSync } from 'fs';
  3   | import { join, resolve } from 'path';
  4   | import Database from 'better-sqlite3';
  5   | 
  6   | const API = 'http://localhost:3000';
  7   | const NO_PROXY_FETCH: RequestInit = {};
  8   | 
  9   | /** 等待后端就绪 */
  10  | export async function waitForBackend() {
  11  |   for (let i = 0; i < 30; i++) {
  12  |     try {
  13  |       const res = await fetch(`${API}/api/health`);
  14  |       if (res.ok) return;
  15  |     } catch {}
  16  |     await new Promise(r => setTimeout(r, 500));
  17  |   }
  18  |   throw new Error('Backend not ready after 15s');
  19  | }
  20  | 
  21  | /** 通过 UI 登录（Playwright 页面） */
  22  | export async function login(page: Page, username = 'admin', password = 'admin123') {
  23  |   await page.goto('/login');
  24  |   await page.waitForSelector('input[type="text"]', { timeout: 10000 });
  25  |   await page.fill('input[type="text"]', username);
  26  |   await page.fill('input[type="password"]', password);
  27  |   await page.click('button[type="submit"]');
  28  |   await page.waitForURL(/\/(chat|modules|settings|admin)/, { timeout: 15000 });
  29  | }
  30  | 
  31  | /** 通过 API 获取 token */
  32  | export async function getToken(username = 'admin', password = 'admin123'): Promise<string> {
> 33  |   const res = await fetch(`${API}/api/auth/login`, {
      |               ^ TypeError: fetch failed
  34  |     method: 'POST',
  35  |     headers: { 'Content-Type': 'application/json' },
  36  |     body: JSON.stringify({ username, password }),
  37  |   });
  38  |   const data = await res.json();
  39  |   if (!data.success) throw new Error(data.message);
  40  |   return data.data.token;
  41  | }
  42  | 
  43  | /** 带认证的 API 请求 */
  44  | export async function apiRequest(
  45  |   method: string,
  46  |   path: string,
  47  |   token: string,
  48  |   body?: any,
  49  | ): Promise<{ status: number; data: any }> {
  50  |   const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  51  |   const opts: RequestInit = { method, headers };
  52  |   if (body !== undefined) {
  53  |     headers['Content-Type'] = 'application/json';
  54  |     opts.body = JSON.stringify(body);
  55  |   }
  56  |   const res = await fetch(`${API}${path}`, opts);
  57  |   const json = await res.json().catch(() => null);
  58  |   return { status: res.status, data: json };
  59  | }
  60  | 
  61  | /** 不带认证的 API 请求 */
  62  | export async function apiRequestNoAuth(
  63  |   method: string,
  64  |   path: string,
  65  |   body?: any,
  66  | ): Promise<{ status: number; data: any }> {
  67  |   const opts: RequestInit = {
  68  |     method,
  69  |     headers: { 'Content-Type': 'application/json' },
  70  |   };
  71  |   if (body !== undefined) opts.body = JSON.stringify(body);
  72  |   const res = await fetch(`${API}${path}`, opts);
  73  |   const json = await res.json().catch(() => null);
  74  |   return { status: res.status, data: json };
  75  | }
  76  | 
  77  | /** 等待 toast 出现并返回文字 */
  78  | export async function waitForToast(page: Page, timeout = 5000): Promise<string> {
  79  |   const toast = page.locator('[data-sonner-toast]').first();
  80  |   await toast.waitFor({ state: 'visible', timeout });
  81  |   return toast.textContent() as Promise<string>;
  82  | }
  83  | 
  84  | /** 检查 toast 包含指定文字 */
  85  | export async function expectToast(page: Page, text: string, timeout = 5000) {
  86  |   const toast = page.locator(`[data-sonner-toast]:has-text("${text}")`).first();
  87  |   await toast.waitFor({ state: 'visible', timeout });
  88  | }
  89  | 
  90  | /**
  91  |  * 创建新会话:点击"新建对话"按钮,等 SessionConfigDialog 弹出,点"跳过默认"以
  92  |  * 使用系统默认 provider/preset 创建 session。适用于"不关心对话配置"的旧测试。
  93  |  *
  94  |  * Step-MCP-3.4 起,点"新建对话"会弹 dialog 而不是直接建 session。
  95  |  */
  96  | export async function startNewChatSession(page: Page) {
  97  |   await page.click('[data-testid="new-session-btn"]');
  98  |   await page.locator('[data-testid="session-config-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  99  |   await page.click('[data-testid="skip-defaults-btn"]');
  100 |   // Wait for dialog to close before returning
  101 |   await page.locator('[data-testid="session-config-dialog"]').waitFor({ state: 'hidden', timeout: 5000 });
  102 | }
  103 | 
  104 | // ==================== Fixture bootstrap ====================
  105 | 
  106 | const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
  107 | const GENERATED_DIR = resolve(process.cwd(), 'generated');
  108 | const USER_ID = 1;
  109 | 
  110 | const USER_META = {
  111 |   name: 'user',
  112 |   displayName: '用户管理',
  113 |   description: '测试夹具模块：用户账户基础信息',
  114 |   basePath: '/mock/user',
  115 |   version: 1,
  116 |   status: 'active',
  117 |   entities: [{
  118 |     name: 'user',
  119 |     tableName: 'mock__user',
  120 |     displayName: '用户',
  121 |     fields: [
  122 |       { name: 'username', type: 'string', displayName: '用户名', required: true },
  123 |       { name: 'email', type: 'string', displayName: '邮箱', required: true },
  124 |       { name: 'password', type: 'string', displayName: '密码', required: true },
  125 |       { name: 'role', type: 'string', displayName: '角色', required: false, defaultValue: 'user' },
  126 |       { name: 'status', type: 'integer', displayName: '状态', required: false, defaultValue: 1 },
  127 |     ],
  128 |   }],
  129 |   endpoints: [
  130 |     { method: 'GET', path: '/', name: '列表', type: 'list' },
  131 |     { method: 'GET', path: '/:id', name: '详情', type: 'detail' },
  132 |     { method: 'POST', path: '/', name: '创建', type: 'create' },
  133 |     { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
```