/**
 * POST /api/contact, as API Gateway's HTTP API delivers it (payload 2.0).
 *
 *   origin check -> validate -> bot check -> Turnstile -> per-IP limit -> send
 *
 * Every dependency arrives through createHandler, so tests drive the real
 * request flow with fakes and the local API (scripts/dev-api.mjs) drives it
 * with the console transport.
 *
 * Logs record the outcome only. Never the message, the name, the address or
 * the visitor's IP: CloudWatch is not where visitors' details should live.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { composeMail, type MailTransport } from './mail.ts';
import { limitKey, type RateLimiter } from './ratelimit.ts';
import { verifyTurnstile, type VerifyOptions, type VerifyResult } from './turnstile.ts';
import { validate, type Field, type FieldError } from './validate.ts';

/** What the form receives. `error` is a stable code the page translates. */
export type ResponseBody =
  | { ok: true }
  | { ok: false; error: 'validation'; fields: Partial<Record<Field, FieldError>> }
  | {
      ok: false;
      error:
        | 'forbidden'
        | 'methodNotAllowed'
        | 'unsupportedMediaType'
        | 'tooLarge'
        | 'badRequest'
        | 'challenge'
        | 'rateLimited'
        | 'unavailable'
        | 'sendFailed';
    };

export interface HandlerDeps {
  from: string;
  to: string;
  /**
   * The value CloudFront sends as x-origin-verify. When set, a request
   * without it is refused before anything else runs. Unset locally.
   */
  originSecret?: string;
  /** Hostname the Turnstile challenge must have been solved on, if checked. */
  expectedHostname?: string;
  loadSecret: () => Promise<string>;
  send: MailTransport;
  /** One message per visitor per window. Without it, no per-IP limit. */
  limiter?: RateLimiter;
  verify?: (options: VerifyOptions) => Promise<VerifyResult>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

type Result = APIGatewayProxyStructuredResultV2;

function respond(
  statusCode: number,
  body: ResponseBody,
  headers: Record<string, string> = {},
): Result {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

/**
 * True when the request carries the secret CloudFront adds on its way to the
 * API (infra/main/contact.tf). The execute-api URL also answers directly, so
 * without this a caller could skip CloudFront and set CloudFront-Viewer-
 * Address to any IP they like. Compared as hashes, in constant time, so the
 * check leaks nothing about the value through timing.
 */
export function fromCloudFront(event: APIGatewayProxyEventV2, secret: string): boolean {
  const given = event.headers?.['x-origin-verify'];
  if (!given) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * The visitor's IP. Behind CloudFront, sourceIp is the edge server, so the
 * viewer's address comes from CloudFront-Viewer-Address ("ip:port"), which
 * CloudFront sets itself. It can be trusted because the origin check above
 * refuses anything that did not come through CloudFront. Locally there is
 * no CloudFront and sourceIp is the visitor.
 */
export function visitorIp(event: APIGatewayProxyEventV2): string | undefined {
  const viewer = event.headers?.['cloudfront-viewer-address'];
  if (viewer) {
    const colon = viewer.lastIndexOf(':');
    return colon > 0 ? viewer.slice(0, colon) : viewer;
  }
  return event.requestContext?.http?.sourceIp || undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createHandler(deps: HandlerDeps) {
  const verify = deps.verify ?? verifyTurnstile;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async (event: APIGatewayProxyEventV2): Promise<Result> => {
    const record = (outcome: string, statusCode: number, extra: Record<string, unknown> = {}) =>
      log({ outcome, status: statusCode, requestId: event.requestContext?.requestId, ...extra });

    if (deps.originSecret !== undefined && !fromCloudFront(event, deps.originSecret)) {
      record('forbidden', 403, { stage: 'origin' });
      return respond(403, { ok: false, error: 'forbidden' });
    }

    if (event.requestContext?.http?.method !== 'POST') {
      record('methodNotAllowed', 405);
      return respond(405, { ok: false, error: 'methodNotAllowed' }, { allow: 'POST' });
    }

    const raw = event.body ?? '';
    const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    const verdict = validate(body, event.headers?.['content-type']);

    if (!verdict.ok) {
      if (verdict.error === 'validation') {
        record('invalid', 400, { fields: Object.keys(verdict.fields) });
        return respond(400, { ok: false, error: 'validation', fields: verdict.fields });
      }
      record(verdict.error, verdict.status);
      return respond(verdict.status, { ok: false, error: verdict.error });
    }

    const { submission } = verdict;

    // Looks like a success to the bot, sends nothing, and does not spend a
    // Siteverify call on it.
    if (submission.suspicious) {
      record('suppressed', 200);
      return respond(200, { ok: true });
    }

    let secret: string;
    try {
      secret = await deps.loadSecret();
    } catch (error) {
      record('unavailable', 503, { stage: 'secret', error: errorName(error) });
      return respond(503, { ok: false, error: 'unavailable' });
    }

    const challenge = await verify({
      secret,
      token: submission.token,
      remoteIp: visitorIp(event),
      expectedHostname: deps.expectedHostname,
    });
    if (!challenge.ok) {
      const status = challenge.reason === 'rejected' ? 403 : 503;
      record(challenge.reason === 'rejected' ? 'challenge' : 'unavailable', status, {
        stage: 'turnstile',
        codes: challenge.codes,
      });
      return respond(status, {
        ok: false,
        error: challenge.reason === 'rejected' ? 'challenge' : 'unavailable',
      });
    }

    // After Turnstile, so a slot is only spent by someone who solved it.
    // A limiter failure lets the message through: the limit is a second
    // line behind Turnstile, not worth losing a real message over.
    const ip = visitorIp(event);
    const slot = deps.limiter && ip ? limitKey(ip, secret) : undefined;
    if (deps.limiter && slot) {
      let claimed = true;
      try {
        claimed = await deps.limiter.claim(slot, now());
      } catch (error) {
        log({
          outcome: 'limitUnavailable',
          requestId: event.requestContext?.requestId,
          error: errorName(error),
        });
      }
      if (!claimed) {
        record('rateLimited', 429);
        return respond(
          429,
          { ok: false, error: 'rateLimited' },
          { 'retry-after': String(deps.limiter.windowSeconds) },
        );
      }
    }

    try {
      await deps.send(composeMail(submission, { from: deps.from, to: deps.to }, now()));
    } catch (error) {
      // Nothing was sent, so the visitor may try again straight away.
      if (deps.limiter && slot) await deps.limiter.release(slot).catch(() => undefined);
      record('sendFailed', 502, { error: errorName(error) });
      return respond(502, { ok: false, error: 'sendFailed' });
    }

    record('sent', 200);
    return respond(200, { ok: true });
  };
}
