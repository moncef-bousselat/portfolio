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
 * scripts/gen-headers.mjs reads it, so the script's origin is added to the
 * CSP's script-src and connect-src automatically. Regenerate the headers
 * (npm run headers) after changing it.
 */
export type AnalyticsConfig =
  { provider: 'none' } | { provider: 'umami'; src: string; websiteId: string };

export const analytics: AnalyticsConfig = { provider: 'none' };

/** Path to the CV for a locale, falling back to the default language. */
export function cvHref(lang: string): string {
  const available = (site.cvLocales as readonly string[]).includes(lang);
  return `/cv/cv-${available ? lang : 'en'}.pdf`;
}
