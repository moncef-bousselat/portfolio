import { expect, test as base } from '@playwright/test';

/*
 * Every test runs offline apart from the preview server: requests to any
 * other host (Cloudflare's Turnstile script, mostly) are aborted, so no
 * result depends on a third party being up. The page also records CSP
 * violations and console errors, and the test fails if any appear, which
 * turns every smoke test into a CSP check as well.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: async ({ page }, use) => {
    const problems: string[] = [];

    await page.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      return hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient');
    });

    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      // The aborted third-party requests report themselves; nothing else may.
      if (message.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) {
        problems.push(message.text());
      }
    });

    await use(problems);
    expect(problems, 'console errors or CSP violations').toEqual([]);
  },
});

export { expect };
