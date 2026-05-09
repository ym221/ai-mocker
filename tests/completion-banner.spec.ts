/**
 * Step-Observability-1.3 — UX simplification:
 *
 *   - Remove thinking badge ("思考中/已完成思考") — content invisible to users anyway
 *   - After stream done, show "完成 · 耗时 X" so user knows how long the turn took
 *
 * Validates:
 *   - Generating banner present (with timer); thinking badge gone (handled by T04 update)
 *   - After fake-runner completes, completion banner appears with formatted elapsed
 *   - Completion banner is suppressed when message is aborted / errored (those have own banners)
 *   - finishedAt accurately stamped by server, replays correctly on history reload
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

async function createSession(token: string, title: string): Promise<string> {
  const res = await apiRequest('POST', '/api/sessions', token, { title: `[CB-TEST] ${title}` });
  return (res.data as any).data.id as string;
}

function makeFinishedSession(opts: { startedAt: number; finishedAt: number; aborted?: boolean; withModule?: boolean }): string {
  const sid = randomUUID();
  const db = new Database(DB_PATH);
  // 默认带一张 module card,匹配"完成 banner 只在模块生成场景显示"的新行为。
  // 测"无模块产出不显示 banner"用 withModule=false。
  const withModule = opts.withModule !== false;
  const modulesJson = withModule
    ? JSON.stringify([{ name: 'cb-test', displayName: '完成测试', status: 'active' }])
    : null;
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq, created_at, updated_at) VALUES (?, ?, ?, 'idle', 0, datetime('now'), datetime('now'))`,
    ).run(sid, '[CB-TEST] history', 1);
    const userMsg = db.prepare(
      `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'user', ?, ?, datetime('now')) RETURNING id`,
    ).get(sid, '__fake__ history', opts.startedAt) as { id: number };
    const asstMsg = db.prepare(
      `INSERT INTO messages (session_id, role, content, modules, started_at, finalized_at, created_at) VALUES (?, 'assistant', '完成', ?, ?, datetime('now'), datetime('now')) RETURNING id`,
    ).get(sid, modulesJson, opts.startedAt) as { id: number };
    // user(seq=1), thinking(seq=2 — creates assistant in store), text(seq=3), terminal(seq=4)
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 1, 'user', ?, datetime('now'))`,
    ).run(sid, userMsg.id, JSON.stringify({ content: '__fake__ history', startedAt: opts.startedAt }));
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 2, 'thinking', ?, datetime('now'))`,
    ).run(sid, asstMsg.id, JSON.stringify({ text: 'hi' }));
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 3, 'text', ?, datetime('now'))`,
    ).run(sid, asstMsg.id, JSON.stringify({ text: '完成' }));
    let terminalSeq = 4;
    if (withModule) {
      // emit 一个 card event,SSE replay 时让前端重建 message.modules,从而触发"完成"banner
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 4, 'card', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({
        kind: 'module',
        data: { name: 'cb-test', displayName: '完成测试', status: 'active', endpointCount: 1 },
      }));
      terminalSeq = 5;
    }
    const terminalType = opts.aborted ? 'aborted' : 'done';
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(sid, asstMsg.id, terminalSeq, terminalType, JSON.stringify({ finishedAt: opts.finishedAt }));
    db.prepare(`UPDATE sessions SET last_seq = ? WHERE id = ?`).run(terminalSeq, sid);
    return sid;
  } finally { db.close(); }
}

function deleteSession(sid: string) {
  const db = new Database(DB_PATH);
  try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { db.close(); }
}

test.describe('完成 · 耗时 banner (Step-Observability-1.3)', () => {
  test('CB01 模块生成完成后展示"完成 · 耗时 Xs"', async ({ page }) => {
    // 注:新行为下"完成 · 耗时" banner 只在模块生成场景出现(普通对话不出),
    // 因此用 makeFinishedSession 模拟"含 module card 的会话"。
    const startedAt = Date.now() - 30_000;
    const finishedAt = startedAt + 7_000;
    const sid = makeFinishedSession({ startedAt, finishedAt });
    try {
      await page.goto(`/chat/${sid}`);
      const banner = page.getByTestId('completion-banner').first();
      await expect(banner).toBeVisible({ timeout: 8_000 });
      const txt = await banner.textContent();
      expect(txt).toContain('完成');
      expect(txt).toContain('耗时');
      const elapsed = await page.getByTestId('completion-elapsed').first().textContent();
      expect(elapsed).toMatch(/^\d+[秒分]/);
    } finally { deleteSession(sid); }
  });

  test('CB02 思考徽章已下线,完成后只剩完成横条', async ({ page }) => {
    const startedAt = Date.now() - 30_000;
    const finishedAt = startedAt + 5_000;
    const sid = makeFinishedSession({ startedAt, finishedAt });
    try {
      await page.goto(`/chat/${sid}`);
      await expect(page.getByTestId('completion-banner').first()).toBeVisible({ timeout: 8_000 });
      expect(await page.getByTestId('thinking-badge').count()).toBe(0);
    } finally { deleteSession(sid); }
  });

  test('CB02b 普通对话(无 module 产出)不显示完成 banner', async ({ page }) => {
    const startedAt = Date.now() - 30_000;
    const finishedAt = startedAt + 5_000;
    const sid = makeFinishedSession({ startedAt, finishedAt, withModule: false });
    try {
      await page.goto(`/chat/${sid}`);
      await page.waitForLoadState('networkidle');
      // 普通对话不应该显示绿色完成 banner(用户期望:不打扰快速对话)
      expect(await page.getByTestId('completion-banner').count()).toBe(0);
    } finally { deleteSession(sid); }
  });

  test('CB03 历史会话: replay 通过 finishedAt 准确还原耗时', async ({ page }) => {
    const startedAt = Date.now() - 130_000; // 130s 前开始
    const finishedAt = startedAt + 75_000;  // 75s 完成
    const sid = makeFinishedSession({ startedAt, finishedAt });
    try {
      await page.goto(`/chat/${sid}`);
      const banner = page.getByTestId('completion-banner').first();
      await expect(banner).toBeVisible({ timeout: 8000 });
      const elapsed = await page.getByTestId('completion-elapsed').first().textContent();
      // 75s → "1分15秒"
      expect(elapsed).toBe('1分15秒');
    } finally {
      deleteSession(sid);
    }
  });

  test('CB04 aborted 状态下不显示完成横条(让 aborted-banner 主导)', async ({ page }) => {
    const startedAt = Date.now() - 60_000;
    const finishedAt = startedAt + 40_000;
    const sid = makeFinishedSession({ startedAt, finishedAt, aborted: true });
    try {
      await page.goto(`/chat/${sid}`);
      // 给 SSE 一点时间 replay 完
      await page.waitForLoadState('networkidle');
      // aborted-banner 显示
      await expect(page.getByText('已停止生成').first()).toBeVisible({ timeout: 8000 });
      // 完成横条不显示
      expect(await page.getByTestId('completion-banner').count()).toBe(0);
    } finally {
      deleteSession(sid);
    }
  });

  test('CB06 空回复(无 text/无 modules) → 显示中性"已结束 · 无回复"而非绿色"完成"', async ({ page }) => {
    // 制造一个 done session,但 assistant 消息没有 text / modules /thinking
    // (重现用户截图的 image_gallery 第二轮 — AI 只调了 clear,没产出任何回复)
    const startedAt = Date.now() - 60_000;
    const finishedAt = startedAt + 53_000;
    const sid = randomUUID();
    const db = new Database(DB_PATH);
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
      ).run(sid, '[CB06] empty completion', 1);
      const userMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'user', ?, ?, datetime('now')) RETURNING id`,
      ).get(sid, '改第一条', startedAt) as { id: number };
      const asstMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, started_at, finalized_at, created_at) VALUES (?, 'assistant', '', ?, datetime('now'), datetime('now')) RETURNING id`,
      ).get(sid, startedAt) as { id: number };
      // user (seq=1), thinking (seq=2 — creates assistant in store), done (seq=3)
      // 注意: 没有 text 事件,也没有 card 事件
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 1, 'user', ?, datetime('now'))`,
      ).run(sid, userMsg.id, JSON.stringify({ content: '改第一条', startedAt }));
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 2, 'thinking', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({ text: 'thinking only' }));
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 3, 'done', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({ finishedAt }));
      db.prepare(`UPDATE sessions SET last_seq = 3 WHERE id = ?`).run(sid);
    } finally { db.close(); }

    try {
      await page.goto(`/chat/${sid}`);
      const banner = page.getByTestId('completion-banner').first();
      await expect(banner).toBeVisible({ timeout: 8000 });
      // 必须是 empty 模式
      await expect(banner).toHaveAttribute('data-empty', '1');
      // 文案是"已结束 · 无回复"而非"完成"
      await expect(banner).toContainText('已结束');
      await expect(banner).toContainText('无回复');
      const txt = await banner.textContent();
      expect(txt).not.toContain('完成');
    } finally {
      const cleanup = new Database(DB_PATH);
      try { cleanup.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { cleanup.close(); }
    }
  });

  test('CB07 有 module 卡片但无 text → 仍算正常"完成"(因为模块卡是有效产出)', async ({ page }) => {
    // 已经在 CB01 隐式覆盖(fake runner 走完含 module card),这里专门 history fixture 验证
    const startedAt = Date.now() - 30_000;
    const finishedAt = startedAt + 20_000;
    const sid = randomUUID();
    const db = new Database(DB_PATH);
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
      ).run(sid, '[CB07] module card no text', 1);
      const userMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'user', ?, ?, datetime('now')) RETURNING id`,
      ).get(sid, '生成模块', startedAt) as { id: number };
      const asstMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, started_at, finalized_at, created_at) VALUES (?, 'assistant', '', ?, datetime('now'), datetime('now')) RETURNING id`,
      ).get(sid, startedAt) as { id: number };
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 1, 'user', ?, datetime('now'))`,
      ).run(sid, userMsg.id, JSON.stringify({ content: '生成模块', startedAt }));
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 2, 'thinking', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({ text: '...' }));
      // card 事件 (有效产出)
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 3, 'card', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({
        kind: 'module',
        data: { name: 'cb07_mod', displayName: 'CB07', basePath: '/mock/cb07', status: 'active', endpointCount: 1 },
      }));
      db.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 4, 'done', ?, datetime('now'))`,
      ).run(sid, asstMsg.id, JSON.stringify({ finishedAt }));
      db.prepare(`UPDATE sessions SET last_seq = 4 WHERE id = ?`).run(sid);
    } finally { db.close(); }

    try {
      await page.goto(`/chat/${sid}`);
      const banner = page.getByTestId('completion-banner').first();
      await expect(banner).toBeVisible({ timeout: 8000 });
      // 有 module card → 正常完成
      await expect(banner).toHaveAttribute('data-empty', '0');
      await expect(banner).toContainText('完成');
    } finally {
      const cleanup = new Database(DB_PATH);
      try { cleanup.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { cleanup.close(); }
    }
  });

  test('CB05 时长格式: 30s → "30秒", 90s → "1分30秒", 600s → "10分"', async ({ page }) => {
    // 仅检查格式逻辑,通过 3 条 history fixture
    const cases: Array<{ secs: number; expect: string }> = [
      { secs: 30, expect: '30秒' },
      { secs: 90, expect: '1分30秒' },
      { secs: 600, expect: '10分' },
    ];
    for (const c of cases) {
      const start = Date.now() - (c.secs * 1000) - 5000;
      const fin = start + c.secs * 1000;
      const sid = makeFinishedSession({ startedAt: start, finishedAt: fin });
      try {
        await page.goto(`/chat/${sid}`);
        await expect(page.getByTestId('completion-banner').first()).toBeVisible({ timeout: 8000 });
        const elapsed = await page.getByTestId('completion-elapsed').first().textContent();
        expect(elapsed).toBe(c.expect);
      } finally {
        deleteSession(sid);
      }
    }
  });
});
