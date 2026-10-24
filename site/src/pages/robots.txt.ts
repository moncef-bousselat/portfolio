import type { APIRoute } from 'astro';

/*
 * Everything may be crawled; the 404 pages say noindex themselves. Built
 * from `site` so the sitemap URL can never point at another domain.
 */
export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set `site` to build robots.txt');
  const sitemap = new URL('sitemap-index.xml', site);
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
