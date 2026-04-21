import { test, expect, type Page } from '@playwright/test';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const MODULE = 'user';

async function gotoDataTab(page: Page) {
  await page.goto(`/modules/${MODULE}`);
  await page.waitForSelector('text=数据', { timeout: 15000 });
  await page.click('button:has-text("数据")');
  await page.waitForSelector('[data-testid="data-table"]', { timeout: 10000 });
}

test.describe('数据管理 UI - DataTable', () => {
  test.beforeAll(async () => {
    await waitForBackend();
    const token = await getToken('admin', 'admin123');
    // Ensure the fixture module + table are present before tests
    await ensureUserModule(token);
    // Reset data
    await apiRequest('POST', `/api/data/${MODULE}/clear`, token);
    // Seed 15 rows
    await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, token, { count: 15 });
  });

  test('U01 打开 Data Tab 显示表格和数据', async ({ page }) => {
    await gotoDataTab(page);
    await expect(page.getByTestId('data-table')).toBeVisible();
    await expect(page.getByTestId('total-count')).toHaveText(/\d+/);
    const total = Number(await page.getByTestId('total-count').textContent());
    expect(total).toBeGreaterThanOrEqual(15);
    // first row visible
    await expect(page.locator('tr[data-testid^="row-"]').first()).toBeVisible();
  });

  test('U02 单元格编辑 — 点击 Cell 切换为 Input 并保存', async ({ page }) => {
    await gotoDataTab(page);
    // Pick first row's username cell
    const firstRow = page.locator('tr[data-testid^="row-"]').first();
    const rowId = await firstRow.getAttribute('data-testid');
    const id = rowId!.replace('row-', '');
    const cell = page.getByTestId(`cell-${id}-username`);
    await cell.click();
    // Input appears
    const input = cell.locator('input[data-testid="cell-input"]');
    await expect(input).toBeVisible();
    await input.fill('');
    await input.fill('edited_name_001');
    await input.press('Enter');
    await page.waitForTimeout(500);
    // verify persisted
    await page.reload();
    await page.click('button:has-text("数据")');
    await page.waitForSelector(`[data-testid="cell-${id}-username"]`);
    await expect(page.getByTestId(`cell-${id}-username`)).toContainText('edited_name_001');
  });

  test('U03 Esc 取消编辑', async ({ page }) => {
    await gotoDataTab(page);
    const row = page.locator('tr[data-testid^="row-"]').first();
    const rowId = (await row.getAttribute('data-testid'))!.replace('row-', '');
    const cell = page.getByTestId(`cell-${rowId}-email`);
    const before = await cell.textContent();
    await cell.click();
    const input = cell.locator('input[data-testid="cell-input"]');
    await input.fill('xxxxxx@abandoned.com');
    await input.press('Escape');
    await expect(cell).toContainText((before || '').trim());
  });

  test('U04 新增行 → 保存', async ({ page }) => {
    await gotoDataTab(page);
    const before = Number(await page.getByTestId('total-count').textContent());
    await page.getByTestId('btn-new-row').click();
    await expect(page.getByTestId('new-row')).toBeVisible();
    // Fill required fields
    const newRow = page.getByTestId('new-row');
    const inputs = newRow.locator('[data-testid^="cell-default"]');
    // Username, email, password are required
    const usernameCell = newRow.locator('td').nth(3); // id is hidden from edit; col order: select, id, username
    // Robust: find by field index via editable cells in order
    const editables = newRow.locator('[data-testid="cell-default"], [data-testid="cell-text"]');
    // Fill first 3 editable cells with sample values
    const count = await editables.count();
    const values = ['new_user_ui', 'ui@test.com', 'pwd123', 'user'];
    for (let i = 0; i < Math.min(count, values.length); i++) {
      const c = editables.nth(i);
      await c.click();
      const input = c.locator('input[data-testid="cell-input"]').first();
      if (await input.count() > 0) {
        await input.fill(values[i]);
        await input.press('Tab');
      }
    }
    await page.getByTestId('new-save').click();
    await page.waitForTimeout(500);
    const after = Number(await page.getByTestId('total-count').textContent());
    expect(after).toBe(before + 1);
  });

  test('U05 批量生成 5 条', async ({ page }) => {
    await gotoDataTab(page);
    const before = Number(await page.getByTestId('total-count').textContent());
    await page.getByTestId('btn-generate').click();
    await expect(page.getByTestId('gen-count')).toBeVisible();
    await page.getByTestId('gen-count').fill('5');
    await page.getByTestId('gen-submit').click();
    await page.waitForTimeout(800);
    const after = Number(await page.getByTestId('total-count').textContent());
    expect(after).toBe(before + 5);
  });

  test('U06 选中 + 批量删除', async ({ page }) => {
    await gotoDataTab(page);
    const before = Number(await page.getByTestId('total-count').textContent());
    // Select first 2 rows via their row checkbox
    const rows = page.locator('tr[data-testid^="row-"]');
    const count = Math.min(2, await rows.count());
    for (let i = 0; i < count; i++) {
      const rid = (await rows.nth(i).getAttribute('data-testid'))!.replace('row-', '');
      await page.getByTestId(`select-${rid}`).click();
    }
    // Custom confirm dialog
    await page.getByTestId('btn-batch-delete').click();
    await page.getByTestId('confirm-ok').click();
    await page.waitForTimeout(600);
    const after = Number(await page.getByTestId('total-count').textContent());
    expect(after).toBe(before - count);
  });

  test('U07 分页：切换 pageSize 到 10', async ({ page }) => {
    await gotoDataTab(page);
    // Ensure >10 rows exist
    const total = Number(await page.getByTestId('total-count').textContent());
    if (total < 11) {
      const token = await getToken('admin', 'admin123');
      await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, token, { count: 15 });
      await page.reload();
      await page.click('button:has-text("数据")');
      await page.waitForSelector('[data-testid="data-table"]');
    }
    await page.getByTestId('page-size').click();
    await page.getByRole('option', { name: '10', exact: true }).click();
    await page.waitForTimeout(400);
    const rows = await page.locator('tr[data-testid^="row-"]').count();
    expect(rows).toBeLessThanOrEqual(10);
  });

  test('U08 列排序：点击 sort 按钮按 id 升序（ID 数值单调递增）', async ({ page }) => {
    await gotoDataTab(page);
    // Click ID sort twice to get ASC from default DESC, or just click once to toggle — our initial is null → ASC first click
    await page.getByTestId('sort-id').click();
    await page.waitForTimeout(500);
    const rows = page.locator('tr[data-testid^="row-"]');
    const count = Math.min(await rows.count(), 5);
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const tid = await rows.nth(i).getAttribute('data-testid');
      ids.push(Number(tid!.replace('row-', '')));
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  test('U09 FilterBar 添加 username 包含筛选条件', async ({ page }) => {
    await gotoDataTab(page);
    const rowsLoc = page.locator('tr[data-testid^="row-"]');
    const beforeCount = await rowsLoc.count();
    expect(beforeCount).toBeGreaterThan(0);
    // grab current username prefix
    const firstRow = rowsLoc.first();
    const rowId = (await firstRow.getAttribute('data-testid'))!.replace('row-', '');
    const val = (await page.getByTestId(`cell-${rowId}-username`).textContent() || '').trim();
    const partial = val.slice(0, 3);
    if (!partial) test.skip();
    // Open FilterBar add panel
    await page.getByTestId('filter-add-trigger').click();
    await page.getByTestId('filter-field-username').click();
    // Chip 0 created with default 'contains' op
    await page.getByTestId('filter-chip-value-0').fill(partial);
    await page.waitForTimeout(700);
    const after = await rowsLoc.count();
    expect(after).toBeGreaterThanOrEqual(1);
    // Verify all visible rows contain the partial
    for (let i = 0; i < Math.min(after, 5); i++) {
      const rid = (await rowsLoc.nth(i).getAttribute('data-testid'))!.replace('row-', '');
      const text = (await page.getByTestId(`cell-${rid}-username`).textContent() || '').toLowerCase();
      expect(text).toContain(partial.toLowerCase());
    }
    // Remove filter
    await page.getByTestId('filter-chip-remove-0').click();
  });

  test('U10 FilterBar id > N 数值操作符', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('filter-add-trigger').click();
    // user module fields don't include id directly; use status (number) instead
    await page.getByTestId('filter-field-status').click();
    // Change op to gt via Select
    await page.getByTestId('filter-chip-op-0').click();
    await page.getByRole('option', { name: '>' }).click();
    await page.getByTestId('filter-chip-value-0').fill('100');
    await page.waitForTimeout(700);
    // Verify all rows have status > 100
    const rowsLoc = page.locator('tr[data-testid^="row-"]');
    const n = Math.min(await rowsLoc.count(), 5);
    for (let i = 0; i < n; i++) {
      const rid = (await rowsLoc.nth(i).getAttribute('data-testid'))!.replace('row-', '');
      const txt = (await page.getByTestId(`cell-${rid}-status`).textContent() || '').trim();
      expect(Number(txt)).toBeGreaterThan(100);
    }
    await page.getByTestId('filter-clear-all').click();
  });

  test('U12 Header 高度与复选框居中', async ({ page }) => {
    await gotoDataTab(page);
    const th = page.getByTestId('th-username');
    const thHeight = await th.evaluate(el => el.getBoundingClientRect().height);
    expect(thHeight).toBeGreaterThanOrEqual(40);
    // Select-all checkbox centered in its th
    const selTh = page.getByTestId('th-__select__');
    const thBox = await selTh.boundingBox();
    const cb = page.getByTestId('select-all');
    const cbBox = await cb.boundingBox();
    expect(thBox && cbBox).toBeTruthy();
    if (thBox && cbBox) {
      const thCenterX = thBox.x + thBox.width / 2;
      const cbCenterX = cbBox.x + cbBox.width / 2;
      // Within 3px tolerance
      expect(Math.abs(thCenterX - cbCenterX)).toBeLessThan(3);
    }
  });

  test('U13 左冻结列纯白背景不透黑（hover 时也不变透明）', async ({ page }) => {
    await gotoDataTab(page);
    const rows = page.locator('tr[data-testid^="row-"]');
    const firstRow = rows.first();
    const rowId = (await firstRow.getAttribute('data-testid'))!.replace('row-', '');
    const idCell = page.getByTestId(`cell-${rowId}-id`).or(firstRow.locator('td').nth(1));
    // Hover the row
    await firstRow.hover();
    await page.waitForTimeout(100);
    const bg = await firstRow.locator('td.pinned-left').first().evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });
    // Must be fully opaque (alpha=1)
    const match = /rgba?\(([^)]+)\)/.exec(bg);
    expect(match).toBeTruthy();
    if (match) {
      const parts = match[1].split(',').map(s => s.trim());
      const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
      expect(alpha).toBe(1);
    }
  });

  test('U14 滚动条稳定：编辑并保存不引起水平抖动', async ({ page }) => {
    await gotoDataTab(page);
    const main = page.locator('main');
    const widthBefore = await main.evaluate(el => el.clientWidth);
    // Edit a cell then blur
    const firstRow = page.locator('tr[data-testid^="row-"]').first();
    const rowId = (await firstRow.getAttribute('data-testid'))!.replace('row-', '');
    const cell = page.getByTestId(`cell-${rowId}-username`);
    await cell.click();
    const input = cell.locator('input[data-testid="cell-input"]');
    await input.fill('stable_width_test');
    // Click outside to blur
    await page.locator('main').click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(600);
    const widthAfter = await main.evaluate(el => el.clientWidth);
    expect(widthBefore).toBe(widthAfter);
  });

  test('U15 页面 header 显示模块名和路径', async ({ page }) => {
    await gotoDataTab(page);
    const header = page.getByTestId('page-header');
    await expect(header).toBeVisible();
    await expect(page.getByTestId('page-header-title')).toContainText('用户管理');
    await expect(page.getByTestId('page-header-meta')).toContainText('/mock/user');
    // Back button to /modules
    await expect(page.getByTestId('page-header-back')).toBeVisible();
  });

  test('U11 FilterBar between 范围筛选', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('filter-add-trigger').click();
    await page.getByTestId('filter-field-status').click();
    await page.getByTestId('filter-chip-op-0').click();
    await page.getByRole('option', { name: '介于' }).click();
    await page.getByTestId('filter-chip-min-0').fill('100');
    await page.getByTestId('filter-chip-max-0').fill('5000');
    await page.waitForTimeout(700);
    const rowsLoc = page.locator('tr[data-testid^="row-"]');
    const n = Math.min(await rowsLoc.count(), 5);
    for (let i = 0; i < n; i++) {
      const rid = (await rowsLoc.nth(i).getAttribute('data-testid'))!.replace('row-', '');
      const txt = (await page.getByTestId(`cell-${rid}-status`).textContent() || '').trim();
      const v = Number(txt);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(5000);
    }
    await page.getByTestId('filter-clear-all').click();
  });
});

test.describe('列设置 ColumnSettings', () => {
  test.beforeAll(async () => {
    await waitForBackend();
    const token = await getToken('admin', 'admin123');
    await ensureUserModule(token);
    const { data } = await apiRequest('GET', `/api/data/${MODULE}?pageSize=1`, token);
    if (!data?.data || data.data.total < 5) {
      await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, token, { count: 10 });
    }
  });

  test('C01 打开列设置面板', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await expect(page.getByTestId('column-settings-panel')).toBeVisible();
    await expect(page.getByTestId('column-search')).toBeVisible();
    await expect(page.getByTestId('zone-left')).toBeVisible();
    await expect(page.getByTestId('zone-center')).toBeVisible();
    await expect(page.getByTestId('zone-right')).toBeVisible();
  });

  test('C02 隐藏列 — 取消 visible checkbox', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await expect(page.getByTestId('col-vis-username')).toBeVisible();
    // th present before
    await expect(page.getByTestId('th-username')).toBeVisible();
    await page.getByTestId('col-vis-username').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-username')).toHaveCount(0);
    // re-enable
    await page.getByTestId('col-vis-username').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-username')).toBeVisible();
  });

  test('C03 右固定一列', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    // email → right pin
    await page.getByTestId('pin-right-email').click();
    await page.waitForTimeout(200);
    const th = page.getByTestId('th-email');
    await expect(th).toHaveClass(/pinned-right/);
  });

  test('C04 左固定然后取消', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('pin-left-role').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-role')).toHaveClass(/pinned-left/);
    // unpin
    await page.getByTestId('pin-none-role').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-role')).not.toHaveClass(/pinned-left/);
  });

  test('C05 搜索列名过滤', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('column-search').fill('email');
    await page.waitForTimeout(150);
    // items containing email should be visible, others not
    await expect(page.getByTestId('col-item-email')).toBeVisible();
    await expect(page.getByTestId('col-item-username')).toHaveCount(0);
  });

  test('C06 密度切换', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('density-compact').click();
    // close panel to observe
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const first = page.locator('tr[data-testid^="row-"]').first().locator('td').first();
    const h = await first.evaluate(el => (el as HTMLElement).getBoundingClientRect().height);
    expect(h).toBeLessThan(36);
  });

  test('C07 全不选 + 重置默认', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('column-select-none').click();
    await page.waitForTimeout(200);
    // username should be hidden
    await expect(page.getByTestId('th-username')).toHaveCount(0);
    // reset
    await page.getByTestId('column-reset').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-username')).toBeVisible();
  });

  test('C08 保存 + 读取预设', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    // hide email
    await page.getByTestId('col-vis-email').click();
    await page.waitForTimeout(100);
    const clickJs = (sel: string) => page.getByTestId(sel).evaluate((el: HTMLElement) => el.click());
    await clickJs('preset-save-open');
    await page.getByTestId('preset-name-input').fill('精简视图');
    await clickJs('preset-save-confirm');
    await page.waitForTimeout(200);
    await expect(page.getByTestId('preset-精简视图')).toBeAttached();
    // reset, then load preset
    await clickJs('column-reset');
    await page.waitForTimeout(100);
    await expect(page.getByTestId('th-email')).toBeVisible();
    await clickJs('preset-精简视图');
    await page.waitForTimeout(200);
    await expect(page.getByTestId('th-email')).toHaveCount(0);
  });

  test('C09 列设置持久化 — 刷新后保留', async ({ page }) => {
    await gotoDataTab(page);
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('col-vis-role').click();
    await page.waitForTimeout(150);
    await expect(page.getByTestId('th-role')).toHaveCount(0);
    await page.reload();
    await page.click('button:has-text("数据")');
    await page.waitForSelector('[data-testid="data-table"]');
    await expect(page.getByTestId('th-role')).toHaveCount(0);
    // cleanup: reset
    await page.getByTestId('column-settings-trigger').click();
    await page.getByTestId('column-reset').click();
  });
});
