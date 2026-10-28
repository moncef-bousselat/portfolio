import { expect, test } from './fixtures';

/*
 * One test per thing that has to keep working after any content edit or
 * dependency update. Selectors follow the markup's meaning (roles, the
 * data-* hooks the islands use) rather than content, so new projects or
 * entries do not break them.
 */

for (const { path, lang } of [
  { path: '/', lang: 'en' },
  { path: '/fr/', lang: 'fr' },
]) {
  test(`home loads in ${lang}`, async ({ page, problems }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Moncef Bousselat');
    expect(problems).toEqual([]);
  });
}

test('a timeline entry expands and collapses', async ({ page, problems }) => {
  await page.goto('/');
  // The first entry starts open; take the first one that does not. By
  // position, since a :not([open]) locator would re-resolve once it opens.
  const all = page.locator('.entry details');
  const index = await all.evaluateAll((entries) =>
    entries.findIndex((entry) => !(entry as HTMLDetailsElement).open),
  );
  expect(index, 'a collapsed timeline entry').toBeGreaterThanOrEqual(0);
  const entry = all.nth(index);

  await entry.locator('summary').click();
  await expect(entry).toHaveAttribute('open', '');
  await entry.locator('summary').click();
  await expect(entry).not.toHaveAttribute('open', '');
  expect(problems).toEqual([]);
});

test('a project opens as a modal from a deep link, and Escape closes it', async ({
  page,
  problems,
}) => {
  await page.goto('/projects/');
  const slug = await page.locator('dialog.panel').first().getAttribute('id');
  expect(slug).toBeTruthy();

  await page.goto(`/projects/#${slug}`);
  const panel = page.locator(`dialog#${slug}`);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  // The island clears the hash in the dialog's close event, which the
  // browser fires as a separate task after the dialog hides: wait for it
  // rather than reading the URL once. Reading it once failed on a CI run.
  await expect(page).toHaveURL((url) => url.hash === '');
  expect(problems).toEqual([]);
});

test('a project page shares tagged links, and copy link copies the clean URL', async ({
  page,
  context,
  problems,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Only projects with a write-up have a page of their own; take one the
  // index links to.
  await page.goto('/projects/');
  const path = await page
    .locator('a[href^="/projects/"]:not([href="/projects/"]):not([href*="#"])')
    .first()
    .getAttribute('href');
  expect(path, 'a project detail page').toMatch(/^\/projects\/[^/]+\/$/);
  await page.goto(path ?? '');

  const share = page.getByRole('complementary', { name: 'Share' });
  const linkedin = new URL(
    (await share.getByRole('link', { name: /Share on LinkedIn/ }).getAttribute('href')) ?? '',
  );
  expect(linkedin.origin).toBe('https://www.linkedin.com');
  const shared = new URL(linkedin.searchParams.get('url') ?? '');
  expect(shared.pathname).toBe(path);
  expect(shared.searchParams.get('utm_source')).toBe('linkedin');

  await share.getByRole('button', { name: 'Copy link' }).click();
  await expect(share.getByRole('status')).toHaveText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `https://moncefbousselat.com${path}`,
  );
  expect(problems).toEqual([]);
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('a project deep link still shows the panel, inline', async ({ page, problems }) => {
    await page.goto('/projects/');
    const slug = await page.locator('dialog.panel').first().getAttribute('id');
    await page.goto(`/projects/#${slug}`);
    await expect(page.locator(`dialog#${slug}`)).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test('an untranslated project shows the fallback notice in French', async ({ page, problems }) => {
  await page.goto('/fr/projects/');
  const notice = 'pas encore traduite';
  const slug = await page
    // A CSS selector, not getByRole: the panels are hidden until opened, and
    // role queries skip hidden elements.
    .locator('dialog.panel', { has: page.locator('[role="note"]', { hasText: notice }) })
    .first()
    .getAttribute('id');
  expect(slug, 'at least one project has no French translation').toBeTruthy();

  await page.goto(`/fr/projects/#${slug}`);
  await expect(page.locator(`dialog#${slug}`).getByRole('note')).toContainText(notice);
  expect(problems).toEqual([]);
});

test('the contact form validates before sending anything', async ({ page, problems }) => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/contact')) posts.push(request.method());
  });

  await page.goto('/contact/');
  // Enabled by the island; disabled in the HTML for visitors without JS.
  await expect(page.locator('[data-fields]')).toBeEnabled();

  await page.locator('[data-submit]').click();
  const name = page.locator('#contact-name');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();
  await expect(page.locator('#contact-name-error')).toHaveText('Enter your name.');
  await expect(page.locator('[data-status]')).toHaveText('Please correct the highlighted fields.');

  await page.locator('#contact-email').fill('not-an-email');
  await page.locator('[data-submit]').click();
  await expect(page.locator('#contact-email')).toHaveAttribute('aria-invalid', 'true');

  expect(posts).toEqual([]);
  expect(problems).toEqual([]);
});

for (const { path, locale, role } of [
  { path: '/projects/', locale: 'en_US', role: 'Cloud & DevOps Engineer' },
  { path: '/fr/projects/', locale: 'fr_FR', role: 'Ingénieur Cloud & DevOps' },
]) {
  test(`${path} carries a link preview card`, async ({ page, request, problems }) => {
    await page.goto(path);
    const meta = (property: string) =>
      page
        .locator(`meta[property="${property}"], meta[name="${property}"]`)
        .getAttribute('content');

    expect(await meta('og:title')).toBe(await page.title());
    expect(await meta('og:url')).toBe(`https://moncefbousselat.com${path}`);
    expect(await meta('og:locale')).toBe(locale);
    expect(await meta('og:image:alt')).toBe(`Moncef Bousselat, ${role}`);
    expect(await meta('twitter:card')).toBe('summary_large_image');

    // Absolute on the live domain; served here under the same path.
    const image = new URL((await meta('og:image')) ?? '');
    expect(image.origin).toBe('https://moncefbousselat.com');
    const served = await request.get(image.pathname);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/png');
    expect(problems).toEqual([]);
  });
}

test('the CSP allows every third-party script the page loads, and where it reports', async ({
  page,
}) => {
  // With analytics off this checks nothing on the home page; with Umami on,
  // it is the guard against a tracker the CSP would silently block.
  const response = await page.goto('/');
  const policy = response?.headers()['content-security-policy'] ?? '';
  const sources = (name: string) =>
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .find(([directive]) => directive === name)
      ?.slice(1) ?? [];

  const scripts = await page.locator('script[src^="https://"]').evaluateAll((tags) =>
    tags.map((tag) => ({
      src: tag.getAttribute('src'),
      host: tag.getAttribute('data-host-url'),
    })),
  );
  for (const { src, host } of scripts) {
    expect(sources('script-src')).toContain(new URL(src ?? '').origin);
    if (host) expect(sources('connect-src')).toContain(new URL(host).origin);
  }
});

test('robots.txt names the sitemap, and the sitemap lists both languages', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Sitemap: https://moncefbousselat.com/sitemap-index.xml');

  const sitemap = await request.get('/sitemap-0.xml');
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain('<loc>https://moncefbousselat.com/</loc>');
  expect(xml).toContain('hreflang="fr" href="https://moncefbousselat.com/fr/"');
  expect(xml).not.toContain('/404');
});
