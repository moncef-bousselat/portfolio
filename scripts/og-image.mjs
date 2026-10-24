/**
 * Renders the default share images, one per language, into
 * site/src/assets/og/og-<lang>.png (1200x630, what Open Graph and X expect).
 *
 *   npm run og
 *
 * Run it after changing the name or role in src/i18n/, the palette in
 * tokens.css, the fonts or the favicon. The PNGs are committed, like the
 * fonts: the build only copies them, so it stays offline and the same commit
 * always ships the same images. Everything drawn comes from those sources,
 * read here, so nothing is written down twice.
 *
 * Rendered by Playwright's Chromium (a dev dependency for the smoke tests),
 * with the committed IBM Plex files and no network.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const read = (path, encoding = 'utf8') => readFileSync(new URL(path, root), encoding);

/** One string from a locale dictionary. Single-quoted values only. */
function uiString(lang, key) {
  const source = read(`site/src/i18n/${lang}.ts`);
  const match = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`).exec(source);
  if (!match) throw new Error(`${key} not found in site/src/i18n/${lang}.ts`);
  return match[1];
}

function token(name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(
    read('site/src/styles/tokens.css'),
  );
  if (!match) throw new Error(`--${name} not found in tokens.css`);
  return match[1];
}

const font = (file) =>
  `url(data:font/woff2;base64,${read(`site/src/assets/fonts/${file}`, 'base64')}) format('woff2')`;

const colors = {
  bg: token('color-bg'),
  text: token('color-text'),
  muted: token('color-text-muted'),
  accent: token('color-accent'),
};
const domain = new URL(/site:\s*'([^']+)'/.exec(read('site/astro.config.mjs'))[1]).host;
const mark = read('site/public/favicon.svg');

const html = (lang) => `<!doctype html>
<html lang="${lang}">
<style>
  @font-face { font-family: Sans; font-weight: 600; src: ${font('plex-sans-normal.woff2')}; }
  @font-face { font-family: Mono; font-weight: 400; src: ${font('plex-mono-400.woff2')}; }
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; box-sizing: border-box; padding: 80px 88px;
    display: flex; flex-direction: column; background: ${colors.bg};
  }
  .mark { width: 112px; height: 112px; margin-left: -12px; }
  .mark svg { width: 100%; height: 100%; display: block; }
  h1 {
    margin: auto 0 0; font: 600 96px/1.05 Sans; letter-spacing: -0.02em; color: ${colors.text};
  }
  .role { margin: 24px 0 0; font: 400 44px/1.2 Mono; color: ${colors.accent}; }
  .domain { margin: auto 0 0; font: 400 30px/1 Mono; color: ${colors.muted}; }
</style>
<body>
  <div class="mark">${mark}</div>
  <h1>${uiString(lang, 'site.title')}</h1>
  <p class="role">${uiString(lang, 'site.role')}</p>
  <p class="domain">${domain}</p>
</body>
</html>`;

const outDir = new URL('site/src/assets/og/', root);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  // Nothing leaves this machine: fonts and the mark are inlined above.
  await page.route('**/*', (route) => route.abort());
  for (const lang of ['en', 'fr']) {
    await page.setContent(html(lang));
    // Runs in the page, where document exists; a string keeps it out of
    // this file's Node globals.
    await page.evaluate('document.fonts.ready');
    const path = new URL(`og-${lang}.png`, outDir);
    await page.screenshot({ path: path.pathname });
    console.log(`Wrote ${path.pathname.replace(root.pathname, '')}`);
  }
} finally {
  await browser.close();
}
