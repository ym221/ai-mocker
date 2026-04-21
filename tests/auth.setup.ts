import { test as setup, expect } from '@playwright/test';
import { waitForBackend } from './helpers';

const authFile = 'tests/.auth/user.json';

setup('authenticate', async ({ page }) => {
  await waitForBackend();
  await page.goto('/login');
  await page.fill('input[placeholder="请输入用户名"]', 'admin');
  await page.fill('input[placeholder="请输入密码"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 15000 });
  await page.context().storageState({ path: authFile });
});
