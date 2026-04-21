import { defineConfig } from '@playwright/test';

// Disable proxy for localhost connections (tests use localhost API)
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  retries: 2,
  workers: 1,
  use: {
    baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:5177',
    headless: true,
    navigationTimeout: 45000,
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
});
