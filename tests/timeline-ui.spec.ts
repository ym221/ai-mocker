/**
 * Step-Observability-1 / Task 5: frontend Tab + TimelineView UI tests.
 *
 * - Renders the new "执行日志" tab into ModuleDetailPage
 * - On click, fetches /api/modules/:name/timeline and shows phase bar / stats
 * - Shows empty-state when no session exists for the module
 * - Real fake-runner session produces visible phase data
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { ensureUserModule, waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => {
  await waitForBackend();
  await ensureUserModule();
});

test.describe('timeline UI (Task 5)', () => {
  test('OB-UI01 timeline tab is present and clickable on ModuleDetailPage', async ({ page }) => {
    await page.goto('/modules/user');
    await page.waitForLoadState('networkidle');

    // Find the new tab button
    const tab = page.locator('button', { hasText: '执行日志' });
    await expect(tab).toBeVisible();

    await tab.click();

    // Tab content area appears
    await expect(page.locator('[data-testid="timeline-tab"]')).toBeVisible();
  });

  test('OB-UI02 empty state when module has no sessions', async ({ page }) => {
    // user fixture module is unlikely to have a chat session. Even if it did,
    // the timeline endpoint returns available:false when no session exists.
    // We force this by using a module name that definitely has no sessions:
    const uniqueName = `obs_ui_empty_${Date.now()}`;
    // Create just enough of a module to navigate to the page
    const db = new Database(DB_PATH);
    try {
      db.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status) VALUES (?, ?, ?, '', ?, 'active')`,
      ).run(uniqueName, 1, uniqueName, `/mock/${uniqueName}`);
    } finally {
      db.close();
    }

    try {
      await page.goto(`/modules/${uniqueName}`);
      await page.waitForLoadState('networkidle');
      await page.locator('button', { hasText: '执行日志' }).click();

      // Empty-state element visible
      await expect(page.locator('[data-testid="timeline-empty"]')).toBeVisible({ timeout: 10000 });
    } finally {
      const db2 = new Database(DB_PATH);
      try { db2.prepare(`DELETE FROM modules WHERE name = ?`).run(uniqueName); } finally { db2.close(); }
    }
  });

  test('OB-UI03 fake-runner session shows phase bar + summary', async ({ page }) => {
    const { startHeadlessSession, attachAndWait } = await import('../src/server/mcp/lib/headless-session.js');

    // Create a fresh module name + bind a fake-runner session to it.
    const moduleName = `obs_ui_filled_${Date.now()}`;

    // Insert module row
    const db = new Database(DB_PATH);
    try {
      db.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status) VALUES (?, ?, ?, '', ?, 'active')`,
      ).run(moduleName, 1, moduleName, `/mock/${moduleName}`);
    } finally {
      db.close();
    }

    // Start fake session and bind moduleName so /api/modules/:name/timeline can find it
    const { sessionId } = await startHeadlessSession({
      userId: 1,
      userContent: '__fake__',
      title: '[OBS-UI-TEST] OB-UI03',
    });
    // Manually link the session to the module
    const db2 = new Database(DB_PATH);
    try {
      db2.prepare(`UPDATE sessions SET module_name = ? WHERE id = ?`).run(moduleName, sessionId);
    } finally {
      db2.close();
    }

    await attachAndWait(sessionId, 30);
    await new Promise((r) => setTimeout(r, 300));

    try {
      await page.goto(`/modules/${moduleName}`);
      await page.waitForLoadState('networkidle');
      await page.locator('button', { hasText: '执行日志' }).click();

      // Wait for the summary to appear
      await expect(page.locator('[data-testid="timeline-summary"]')).toBeVisible({ timeout: 10000 });

      // Phase bar + total
      await expect(page.locator('[data-testid="phase-bar"]')).toBeVisible();
      await expect(page.locator('[data-testid="phase-total"]')).toContainText('总耗时');
    } finally {
      // Cleanup
      const db3 = new Database(DB_PATH);
      try {
        db3.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
        db3.prepare(`DELETE FROM modules WHERE name = ?`).run(moduleName);
      } finally { db3.close(); }
    }
  });
});
