/**
 * Share links, built at render time: plain URLs to each platform's own
 * compose page, so sharing needs no third-party script, no CSP change and no
 * JavaScript of ours.
 *
 * The page URL each platform receives carries utm_source=<platform> and
 * utm_medium=share, so a visit from a shared post is credited to the
 * platform even when it arrives without a referrer (LinkedIn's in-app
 * browser sends none). Copy link and the system share sheet use the clean
 * URL instead: where it ends up is unknown, so a tag would say nothing.
 *
 * Endpoints, as each platform documents them (checked 2026-10-28):
 * - LinkedIn: share-offsite takes the url only; the preview comes from the
 *   page's og: tags.
 * - X: intent/tweet with text and url.
 * - Bluesky: intent/compose takes a single text, so the URL goes inside it.
 * - Reddit: submit with url and title.
 */

export const SHARE_PLATFORMS = ['linkedin', 'x', 'bluesky', 'reddit'] as const;
export type SharePlatform = (typeof SHARE_PLATFORMS)[number];

/** The page URL as shared to one platform, tagged for analytics. */
export function taggedUrl(pageUrl: string | URL, platform: SharePlatform): string {
  const url = new URL(pageUrl);
  url.searchParams.set('utm_source', platform);
  url.searchParams.set('utm_medium', 'share');
  return url.toString();
}

/** The platform's compose URL for sharing a page with this title. */
export function shareHref(platform: SharePlatform, pageUrl: string | URL, title: string): string {
  const url = taggedUrl(pageUrl, platform);
  const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

  switch (platform) {
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?${query({ url })}`;
    case 'x':
      return `https://x.com/intent/tweet?${query({ text: title, url })}`;
    case 'bluesky':
      return `https://bsky.app/intent/compose?${query({ text: `${title} ${url}` })}`;
    case 'reddit':
      return `https://www.reddit.com/submit?${query({ url, title })}`;
  }
}
