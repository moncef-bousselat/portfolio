/**
 * Non-translatable site configuration: the links that are the same in every
 * language. Translatable strings (role, tagline, labels) live in src/i18n/.
 *
 * No personal email here - the repo is public. The contact address is a
 * Terraform variable, read only by the contact Lambda.
 */
export const site = {
  github: 'https://github.com/moncef-bousselat',
  linkedin: 'https://www.linkedin.com/in/moncefbousselat/',

  /**
   * Locales that have a CV PDF in public/cv/. A locale absent from this list
   * falls back to the default language's CV rather than linking a 404, so
   * adding or removing a translated CV is a one-line change here.
   */
  cvLocales: ['en', 'fr'],
} as const;

/**
 * Analytics provider. 'none' ships no script and no cookies; CloudFront's
 * console reports cover traffic. Switching to Umami is this one entry:
 * scripts/gen-headers.mjs reads it, so the script's origin goes into the
 * CSP's script-src and the data endpoint's into connect-src automatically.
 * Regenerate the headers (npm run headers) after changing it.
 *
 * hostUrl is where the tracker sends its data. Umami Cloud serves the script
 * from cloud.umami.is but receives on gateway.umami.is, so the two origins
 * differ; it is written into the script tag as data-host-url too, so the
 * tracker and the CSP can never disagree.
 */
export type AnalyticsConfig =
  { provider: 'none' } | { provider: 'umami'; src: string; hostUrl: string; websiteId: string };

export const analytics: AnalyticsConfig = {
  provider: 'umami',
  src: 'https://cloud.umami.is/script.js',
  hostUrl: 'https://gateway.umami.is',
  // Public by design: it is written into every page. It identifies the site
  // in the owner's Umami account; it grants nothing.
  websiteId: '497669b1-7915-4bc8-b796-f4495d0c674f',
};

/** Path to the CV for a locale, falling back to the default language. */
export function cvHref(lang: string): string {
  const available = (site.cvLocales as readonly string[]).includes(lang);
  return `/cv/cv-${available ? lang : 'en'}.pdf`;
}
