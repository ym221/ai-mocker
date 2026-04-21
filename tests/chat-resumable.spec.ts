import { test, expect } from '@playwright/test';
import { waitForBackend, getToken, apiRequest } from './helpers';

/**
 * 5 大硬需求场景 e2e 测试。
 * 后端用 `__fake__` 前缀触发确定性假流，避免真实 AI 依赖。
 */

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

// ==================== 场景 1：暂停保留 + 续接 ====================

test('场景1 暂停后已输出内容保留，继续发送能接上', async () => {
  const token = await getToken();
  const sid = await createSession(token, 'pause-keep');

  // POST /api/chat
  const postPromise = fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ t1' }),
  });
  // pause after 800ms (ensures at least one text chunk emitted)
  await new Promise(r => setTimeout(r, 800));
  const pauseRes = await apiRequest('POST', '/api/chat/pause', token, { sessionId: sid });
  expect(pauseRes.data.success).toBe(true);

  const resp = await postPromise;
  const events = await readStreamToEvents(resp);
  const types = events.map(e => e.type);
  expect(types).toContain('user');
  expect(types).toContain('text');
  expect(types).toContain('paused');
  // 已输出的 text 事件数 >= 1
  const textBefore = events.filter(e => e.type === 'text').length;
  expect(textBefore).toBeGreaterThanOrEqual(1);

  // turn 2 (继续)
  const resp2 = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ t2' }),
  });
  const events2 = await readStreamToEvents(resp2);
  expect(events2.find(e => e.type === 'done')).toBeDefined();
  // seq 在 session 内持续递增
  const maxSeq1 = Math.max(...events.filter(e => e.seq).map(e => e.seq));
  const minSeq2 = Math.min(...events2.filter(e => e.seq).map(e => e.seq));
  expect(minSeq2).toBeGreaterThan(maxSeq1);
});

// ==================== 场景 3：卡片/工具调用持久化 ====================

test('场景3 tool_call 和 tool_result 事件持久化到 event log', async () => {
  const token = await getToken();
  const sid = await createSession(token, 'persist');

  const resp = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ x' }),
  });
  await readStreamToEvents(resp);

  // 重新订阅 afterSeq=0 应该完整重放
  const resp2 = await fetch(
    `http://localhost:3000/api/chat/stream?sessionId=${sid}&afterSeq=0`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const events = await readStreamToEvents(resp2, 3000);
  const types = events.map(e => e.type);
  expect(types).toContain('tool_call');
  expect(types).toContain('tool_result');
  expect(types).toContain('done');
});

// ==================== 场景 4：断线后端不中断，重连接续 ====================

test('场景4 客户端断开，runner 继续执行，重连看到完整结果', async () => {
  const token = await getToken();
  const sid = await createSession(token, 'disc');

  // 发起然后立刻 abort
  const ac = new AbortController();
  const p = fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ d' }),
    signal: ac.signal,
  }).catch(() => null);
  await new Promise(r => setTimeout(r, 300));
  ac.abort();
  await p;

  // 等 runner 完成
  await new Promise(r => setTimeout(r, 2500));

  // 重连看完整事件
  const resp = await fetch(
    `http://localhost:3000/api/chat/stream?sessionId=${sid}&afterSeq=0`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const events = await readStreamToEvents(resp, 3000);
  expect(events.find(e => e.type === 'done')).toBeDefined();

  // session 应被标记 hasUnread
  const list = await apiRequest('GET', '/api/sessions', token);
  const s = list.data.data.find((x: any) => x.id === sid);
  expect(s.hasUnread).toBe(1);
  expect(s.runStatus).toBe('done');
});

// ==================== 场景 5：未读标识 + 清除 ====================

test('场景5 标记已读后 hasUnread 清除', async () => {
  const token = await getToken();
  const sid = await createSession(token, 'unread');

  const ac = new AbortController();
  fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, content: '__fake__ u' }),
    signal: ac.signal,
  }).catch(() => null);
  await new Promise(r => setTimeout(r, 200));
  ac.abort();
  await new Promise(r => setTimeout(r, 2500));

  let list = await apiRequest('GET', '/api/sessions', token);
  expect(list.data.data.find((x: any) => x.id === sid).hasUnread).toBe(1);

  await apiRequest('POST', '/api/chat/read', token, { sessionId: sid });
  list = await apiRequest('GET', '/api/sessions', token);
  expect(list.data.data.find((x: any) => x.id === sid).hasUnread).toBe(0);
});

// ==================== 场景 2：上下文策略 — 删除会话不影响新会话 ====================

test('场景2 删除会话后新建同模块会话，事件日志隔离', async () => {
  const token = await getToken();
  const sidA = await createSession(token, 'A');
  const sidB = await createSession(token, 'B');

  // A 发一条
  const r1 = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sidA, content: '__fake__ A' }),
  });
  await readStreamToEvents(r1);

  // 删除 A
  await apiRequest('DELETE', `/api/sessions/${sidA}`, token);

  // B 的事件应该是空
  const r2 = await fetch(
    `http://localhost:3000/api/chat/stream?sessionId=${sidB}&afterSeq=0`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const evB = await readStreamToEvents(r2, 2000);
  // 只应含 meta，无实际 event
  expect(evB.every(e => e.type === 'meta' || !e.seq)).toBe(true);

  // A 的事件已级联删除
  const r3 = await fetch(
    `http://localhost:3000/api/chat/stream?sessionId=${sidA}&afterSeq=0`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // 应返回 404，但 fetch 会成功解析
  expect(r3.status).toBe(404);
});

// ==================== UI 场景：页面切换后状态保持 ====================

test('UI 场景 切换 session 再切回，消息内容保持', async ({ page }) => {
  // 创建两个 session 和发送内容
  const token = await getToken();
  const sidA = await createSession(token, 'UI-A');
  const sidB = await createSession(token, 'UI-B');

  // A 完成一轮 fake
  const r = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sidA, content: '__fake__ UI' }),
  });
  await readStreamToEvents(r);

  await page.goto(`/chat/${sidA}`);
  // 内容应包含 fake text
  await expect(page.locator('.prose').filter({ hasText: '生成完成' }).first()).toBeVisible({ timeout: 8000 });

  // 切到 B
  await page.goto(`/chat/${sidB}`);
  await page.waitForTimeout(500);

  // 切回 A，内容依然
  await page.goto(`/chat/${sidA}`);
  await expect(page.locator('.prose').filter({ hasText: '生成完成' }).first()).toBeVisible({ timeout: 8000 });
});
