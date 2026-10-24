import { defineConfig, devices } from '@playwright/test';

/*
 * Smoke tests against the production build, served by scripts/preview.mjs
 * exactly as CloudFront serves it: same viewer-request function, same
 * headers and CSP. Build first:
 *
 *   npm run build && npm run headers && npm run test:e2e
 *
 * No retries: a test that passes on a second try is a flaky test, and the
 * point of this suite is a result that means something.
 */
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4500',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4500/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
