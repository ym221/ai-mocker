/**
 * Step-Observability-1.2: server-restart aborted UX.
 *
 * Validates:
 *   - When an `aborted` event arrives with payload `{reason: 'server_restart'}`,
 *     MessageBubble shows a clearer banner ("服务已重启,生成被中断") and a 重试 button.
 *   - The retry button resends the original user content via chatStore.send.
 *
 * Implementation note: we don't actually restart the dev server in the test.
 * Instead we synthesize the exact 'aborted' event the database cleanup writes
 * on restart, by injecting a row directly into message_events for an idle
 * session, then loading that session in the UI.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

function makeAbortedSession(reason: string | undefined): { sessionId: string } {
  const db = new Database(DB_PATH);
  try {
    const sid = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq, created_at, updated_at) VALUES (?, ?, ?, 'idle', 0, datetime('now'), datetime('now'))`,
    ).run(sid, '[ABORT-TEST] restart fixture', 1);

    // Insert user msg + assistant placeholder (matching real flow)
    const userMsg = db.prepare(
      `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'user', ?, ?, datetime('now')) RETURNING id`,
    ).get(sid, '生成仓储管理模块', Date.now()) as { id: number };
    const asstMsg = db.prepare(
      `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'assistant', '', ?, datetime('now')) RETURNING id`,
    ).get(sid, Date.now()) as { id: number };

    // Insert events: user (seq=1), thinking (seq=2 — creates assistant msg in store), aborted (seq=3)
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 1, 'user', ?, datetime('now'))`,
    ).run(sid, userMsg.id, JSON.stringify({ content: '生成仓储管理模块', startedAt: Date.now() }));
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 2, 'thinking', ?, datetime('now'))`,
    ).run(sid, asstMsg.id, JSON.stringify({ text: 'analyzing...' }));
    db.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at) VALUES (?, ?, 3, 'aborted', ?, datetime('now'))`,
    ).run(sid, asstMsg.id, JSON.stringify(reason ? { reason } : {}));
    db.prepare(`UPDATE sessions SET last_seq = 3 WHERE id = ?`).run(sid);
    return { sessionId: sid };
  } finally {
    db.close();
  }
}

function deleteSession(sid: string) {
  const db = new Database(DB_PATH);
  try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid); } finally { db.close(); }
}

test.describe('abort-restart UX (Step-Observability-1.2)', () => {
  test('AR-RST01 server_restart aborted shows clear banner + retry button', async ({ page }) => {
    const { sessionId } = makeAbortedSession('server_restart');
    try {
      await page.goto(`/chat/${sessionId}`);
      await page.waitForLoadState('networkidle');

      // Banner text should be the restart-specific copy, not the generic "已停止生成"
      await expect(page.getByText('服务已重启,生成被中断')).toBeVisible({ timeout: 8000 });
      // Retry button is rendered
      await expect(page.getByTestId('abort-retry-btn')).toBeVisible();
    } finally {
      deleteSession(sessionId);
    }
  });

  test('AR-RST02 generic aborted (no reason) keeps original "已停止生成" copy + no retry button', async ({ page }) => {
    const { sessionId } = makeAbortedSession(undefined);
    try {
      await page.goto(`/chat/${sessionId}`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('已停止生成')).toBeVisible({ timeout: 8000 });
      await expect(page.getByTestId('abort-retry-btn')).toHaveCount(0);
    } finally {
      deleteSession(sessionId);
    }
  });

  test('AR-RST03 clicking retry button posts the original user content', async ({ page }) => {
    const { sessionId } = makeAbortedSession('server_restart');
    try {
      await page.goto(`/chat/${sessionId}`);
      await page.waitForLoadState('networkidle');

      // Intercept /api/chat to verify retry posts the original user content
      let retriedContent: string | null = null;
      await page.route('**/api/chat', async (route) => {
        const post = route.request().postDataJSON();
        retriedContent = post?.content;
        // Don't actually send to backend (that would start a real LLM run)
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: {"type":"meta"}\n\n',
        });
      });

      await page.getByTestId('abort-retry-btn').click();
      // Wait for the intercepted post
      await page.waitForFunction(() => true, { timeout: 1000 }).catch(() => {});
      await expect.poll(() => retriedContent, { timeout: 5000 }).toBe('生成仓储管理模块');
    } finally {
      deleteSession(sessionId);
    }
  });
});
