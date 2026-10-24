// @ts-check
import { defineConfig, envField, fontProviders } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { shikiStyleToClass } from './src/lib/shiki-classes.ts';

/**
 * What every committed font face shares: swap, and Google's "latin"
 * unicode-range, which the files are cut to. Declaring it keeps the CSS the
 * same as what the google provider generated.
 */
/** @type {{ display: 'swap', unicodeRange: [string, ...string[]] }} */
const latin = {
  display: 'swap',
  unicodeRange: [
    'U+0000-00FF',
    'U+0131',
    'U+0152-0153',
    'U+02BB-02BC',
    'U+02C6',
    'U+02DA',
    'U+02DC',
    'U+0304',
    'U+0308',
    'U+0329',
    'U+2000-206F',
    'U+20AC',
    'U+2122',
    'U+2191',
    'U+2193',
    'U+2212',
    'U+2215',
    'U+FEFF',
    'U+FFFD',
  ],
};

const fonts = './src/assets/fonts';

export default defineConfig({
  // Drives canonical URLs, hreflang alternates and the RSS feed's absolute
  // links. Terraform's `domain_name` variable must match this value, since
  // that is what provisions the ACM certificate and the Route 53 records.
  site: 'https://moncefbousselat.com',
  output: 'static',

  integrations: [
    mdx(),
    /*
     * sitemap-index.xml + sitemap-0.xml, each page listed with its EN/FR
     * alternates (the same pairs as the hreflang links in BaseLayout).
     * robots.txt (src/pages/robots.txt.ts) points crawlers at it. The 404
     * pages are noindex, so they stay out.
     */
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', fr: 'fr' } },
      filter: (page) => !/\/404\/?$/.test(new URL(page).pathname),
    }),
  ],

  /*
   * The Turnstile site key is public by design: it is rendered into the
   * contact page. Optional, because local builds use Cloudflare's dummy key
   * (see ContactForm.astro); the release workflow refuses to build without
   * the real one, from the PUBLIC_TURNSTILE_SITE_KEY repository variable.
   */
  env: {
    schema: {
      PUBLIC_TURNSTILE_SITE_KEY: envField.string({
        context: 'server',
        access: 'public',
        optional: true,
      }),
    },
  },

  /*
   * English is the default and is served unprefixed at /; French lives under
   * /fr/. prefixDefaultLocale stays false so the canonical English URLs have
   * no /en/ segment.
   *
   * Astro's i18n routing does NOT fall back automatically here: a missing
   * French page would 404. The brief wants the English content rendered at the
   * French URL with a notice instead, so that fallback is handled in the
   * content layer when collections land, not by routing config.
   */
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false,
    },
  },

  /*
   * Fonts are self-hosted from files committed in src/assets/fonts/, so the
   * browser never calls fonts.googleapis.com or fonts.gstatic.com - which is
   * what lets the CSP stay strict (no third-party font-src).
   *
   * They are committed rather than downloaded at build time (the google
   * provider) because the generated @font-face CSS is inlined, and the CSP
   * allows it by hash: a build that fetched slightly different files or CSS
   * from Google failed the header check with no change of ours. From disk,
   * the same commit always builds the same CSS. The files are the ones
   * Google served (OFL, licence alongside); to update them, replace the
   * files, then run npm run build && npm run headers.
   *
   * IBM Plex Sans + IBM Plex Mono: one family, two voices. Mono carries
   * headings, labels and dates; sans carries body text.
   *
   * Plex Sans is one variable file per style, declared at the only two
   * weights the design uses, 400 and 600. Plex Mono has no variable build,
   * so it is one static file per weight.
   *
   * latin subset only. It already covers U+0152-0153 (the French OE
   * ligature) along with all accented Latin-1, so latin-ext would only add
   * Eastern-European glyphs this site never renders.
   *
   * No preload: it is per-family and all-variants, which meant 8 blocking font
   * requests on first paint including italics most pages never use. Without
   * it every face downloads lazily when a glyph actually needs it, and
   * font-display: swap plus optimizedFallbacks covers the gap - the better
   * trade against the Lighthouse >= 95 bar.
   */
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'IBM Plex Sans',
      cssVariable: '--font-sans',
      options: {
        // One variable file per style, declared at the two weights used.
        variants: [
          { ...latin, weight: 400, style: 'normal', src: [`${fonts}/plex-sans-normal.woff2`] },
          { ...latin, weight: 600, style: 'normal', src: [`${fonts}/plex-sans-normal.woff2`] },
          { ...latin, weight: 400, style: 'italic', src: [`${fonts}/plex-sans-italic.woff2`] },
          { ...latin, weight: 600, style: 'italic', src: [`${fonts}/plex-sans-italic.woff2`] },
        ],
      },
      fallbacks: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      // Metric-adjusted fallback, so the swap does not shift layout.
      optimizedFallbacks: true,
    },
    {
      provider: fontProviders.local(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-mono',
      options: {
        variants: [
          { ...latin, weight: 400, style: 'normal', src: [`${fonts}/plex-mono-400.woff2`] },
          { ...latin, weight: 600, style: 'normal', src: [`${fonts}/plex-mono-600.woff2`] },
        ],
      },
      fallbacks: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      optimizedFallbacks: true,
    },
  ],

  /*
   * Nothing inline, so the Content-Security-Policy can be a plain
   * script-src 'self'; style-src 'self' with no hashes and no meta tag.
   *
   * Astro otherwise inlines small hoisted <script> blocks and small
   * stylesheets straight into the HTML, which a strict CSP would block unless
   * every one of their sha256 hashes were tracked in the header. Keeping the
   * output external moves that problem out of existence.
   *
   * Astro 7 does offer security.csp, which emits a <meta http-equiv> CSP with
   * the hashes computed for you - but the CSP for this site is a CloudFront
   * response header (one source of truth shared with the local preview
   * server), and frame-ancestors is ignored in a meta CSP, so the header has
   * to carry it regardless. Two overlapping policies would then both be
   * enforced. External files avoid all of it.
   *
   * Cost: small assets are no longer inlined as data URIs, so they become
   * separate requests. With immutable caching on hashed filenames that is a
   * fair trade, and arguably better for caching.
   */
  build: {
    inlineStylesheets: 'never',
  },

  vite: {
    build: {
      assetsInlineLimit: 0,
    },
    // The contact API, as CloudFront's /api/* behaviour routes it in
    // production: same origin, so no CORS. `npm run dev` starts both.
    server: {
      proxy: {
        '/api/': `http://127.0.0.1:${process.env.CONTACT_API_PORT ?? 8787}`,
      },
    },
  },

  markdown: {
    shikiConfig: {
      // Token colours come from github-dark; its background is overridden in
      // global.css (see the pre.astro-code rule and the reason there).
      theme: 'github-dark',
      wrap: false,
      // Inline styles become classes (styles/shiki.css), so the CSP needs no
      // hash per token colour and posts never change the response headers.
      transformers: [shikiStyleToClass()],
    },
  },
});
