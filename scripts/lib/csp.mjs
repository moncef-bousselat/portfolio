/**
 * The pure half of header generation: find the inline styles a build emits,
 * hash them, and assemble the security headers. No file system access here,
 * so all of it is unit-tested directly.
 *
 * script-src stays strictly 'self'. style-src carries the sha256 of each
 * inline <style> block (Astro's <Font> @font-face rules) and nothing else.
 * Inline style="" attributes are not allowed at all: there is
 * no 'unsafe-hashes', so a browser would drop them. Shiki's token colours are
 * classes instead (site/src/lib/shiki-classes.ts), which keeps the policy
 * independent of what posts contain.
 */
import { createHash } from 'node:crypto';

/**
 * CloudFront's quota on the Content-Security-Policy value of a response
 * headers policy. Exceeding it fails the apply, not the build, so it is
 * enforced here where the failure is cheap.
 */
export const MAX_CSP_LENGTH = 1783;

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** sha256 source expression, as CSP expects: base64 of the raw digest. */
export function hashSource(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Browsers hash an attribute's decoded value, not its source text, so
 * `style="a&amp;b"` must be hashed as `a&b`.
 */
function decodeAttribute(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[ref.toLowerCase()];
    if (named === undefined) {
      throw new Error(`Unhandled HTML entity ${match} in a style attribute`);
    }
    return named;
  });
}

/**
 * Inline style sources in one HTML document: <style> blocks to hash, and
 * style="" attributes, which the caller rejects.
 *
 * <style> element contents are raw text and are hashed verbatim. Attributes
 * are decoded the way a browser reads them, and looked for inside start tags
 * only: text content cannot open a tag,
 * since a literal "<" in text is always escaped, so a post that merely talks
 * about style="..." is not mistaken for one.
 */
export function collectInlineStyles(html) {
  const blocks = [];
  const attributes = [];

  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    blocks.push(match[1]);
  }

  for (const [tag] of html.matchAll(/<[a-z][a-z0-9-]*\b[^<>]*>/gi)) {
    const attribute = tag.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if (attribute) {
      attributes.push(decodeAttribute(attribute[1] ?? attribute[2] ?? attribute[3]));
    }
  }

  return { blocks, attributes };
}

/** Origin of a URL, for allowing a third-party script or its endpoint. */
function originOf(url, what) {
  const { protocol, origin } = new URL(url);
  if (protocol !== 'https:') {
    throw new Error(`Analytics ${what} must be served over https: ${url}`);
  }
  return origin;
}

/**
 * The Content-Security-Policy value.
 *
 * default-src 'none' means anything not listed is refused outright, so a
 * new kind of resource fails loudly in `npm run preview` instead of quietly
 * inheriting a permissive default.
 */
export function buildCsp({ blocks = [], analytics = { provider: 'none' }, turnstile = false }) {
  const blockHashes = [...new Set(blocks.map(hashSource))].sort();

  // The script and the endpoint it reports to may differ (Umami Cloud's do).
  const enabled = analytics.provider !== 'none';
  const analyticsScript = enabled ? [originOf(analytics.src, 'script')] : [];
  const analyticsEndpoint = enabled
    ? [originOf(analytics.hostUrl ?? analytics.src, 'endpoint')]
    : [];
  const challenge = turnstile ? [TURNSTILE_ORIGIN] : [];

  const directives = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", ...challenge, ...analyticsScript]],
    ['style-src', ["'self'", ...blockHashes]],
    ['img-src', ["'self'"]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...analyticsEndpoint]],
    ['frame-src', challenge.length > 0 ? challenge : null],
    ['manifest-src', ["'self'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['upgrade-insecure-requests', []],
  ];

  const policy = directives
    .filter(([, sources]) => sources !== null)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');

  if (policy.length > MAX_CSP_LENGTH) {
    throw new Error(
      `CSP is ${policy.length} characters; CloudFront allows ${MAX_CSP_LENGTH}. ` +
        'Too many distinct inline <style> blocks.',
    );
  }

  return policy;
}

/**
 * The full header set, in the shape both consumers read: Terraform maps it
 * onto a response headers policy, the preview server onto plain headers via
 * toHttpHeaders(). Field names follow the CloudFront policy's own blocks.
 */
export function buildHeaders(cspInput) {
  return {
    contentSecurityPolicy: buildCsp(cspInput),
    strictTransportSecurity: {
      // Two years: the value hstspreload.org asks for, should preload ever
      // be wanted. Preload itself stays off - it is a commitment that is
      // slow to undo, and nothing here needs it.
      maxAgeSeconds: 63072000,
      includeSubdomains: true,
      preload: false,
    },
    contentTypeOptions: 'nosniff',
    // Legacy companion to frame-ancestors 'none', for browsers that predate it.
    frameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
    custom: {
      'Permissions-Policy': [
        'accelerometer=()',
        'browsing-topics=()',
        'camera=()',
        'geolocation=()',
        'gyroscope=()',
        'magnetometer=()',
        'microphone=()',
        'payment=()',
        'usb=()',
      ].join(', '),
    },
  };
}

/** Render the shared header config as HTTP header name/value pairs. */
export function toHttpHeaders(config) {
  const hsts = config.strictTransportSecurity;

  return {
    'Content-Security-Policy': config.contentSecurityPolicy,
    'Strict-Transport-Security': [
      `max-age=${hsts.maxAgeSeconds}`,
      ...(hsts.includeSubdomains ? ['includeSubDomains'] : []),
      ...(hsts.preload ? ['preload'] : []),
    ].join('; '),
    'X-Content-Type-Options': config.contentTypeOptions,
    'X-Frame-Options': config.frameOptions,
    'Referrer-Policy': config.referrerPolicy,
    ...config.custom,
  };
}
