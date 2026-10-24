/**
 * Builds the handler from environment variables - the only place that reads
 * them. Shared by the Lambda entry point and the local API, so both start
 * from the same configuration rules and fail the same way when one is
 * missing.
 *
 *   MAIL_TRANSPORT               console | ses
 *   MAIL_FROM                    verified SES sender
 *   MAIL_TO                      the one recipient
 *   TURNSTILE_SECRET             literal secret (local, dummy keys)
 *   TURNSTILE_SECRET_PARAMETER   SSM SecureString name (Lambda)
 *   TURNSTILE_HOSTNAME           optional; required hostname of the challenge
 *   ORIGIN_VERIFY_SECRET         value CloudFront sends as x-origin-verify;
 *                                required in Lambda, unset locally
 *   RATE_LIMIT_TABLE             DynamoDB table for the per-IP limit; required
 *                                in Lambda, locally an in-memory limit instead
 *   RATE_LIMIT_WINDOW_SECONDS    one message per visitor per window (300);
 *                                0 turns the limit off
 */
import { createHandler } from './handler.ts';
import { createTransport } from './mail.ts';
import { dynamoLimiter, memoryLimiter, type RateLimiter } from './ratelimit.ts';
import { createSecretLoader } from './secret.ts';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function limiterFromEnv(env: Env): RateLimiter | undefined {
  const raw = env.RATE_LIMIT_WINDOW_SECONDS || '300';
  const windowSeconds = Number(raw);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 0) {
    throw new Error(
      `RATE_LIMIT_WINDOW_SECONDS must be a whole number of seconds, got ${JSON.stringify(raw)}.`,
    );
  }
  if (windowSeconds === 0) return undefined;
  if (env.RATE_LIMIT_TABLE) return dynamoLimiter({ table: env.RATE_LIMIT_TABLE, windowSeconds });
  // In Lambda a memory limit would be per execution environment, which is
  // no limit at all.
  if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('RATE_LIMIT_TABLE is not set.');
  return memoryLimiter(windowSeconds);
}

export function handlerFromEnv(env: Env) {
  const originSecret = env.ORIGIN_VERIFY_SECRET || undefined;
  // In Lambda, a missing secret would silently accept direct calls.
  if (!originSecret && env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('ORIGIN_VERIFY_SECRET is not set.');
  }

  return createHandler({
    originSecret,
    from: required(env, 'MAIL_FROM'),
    to: required(env, 'MAIL_TO'),
    expectedHostname: env.TURNSTILE_HOSTNAME || undefined,
    loadSecret: createSecretLoader({
      value: env.TURNSTILE_SECRET,
      parameterName: env.TURNSTILE_SECRET_PARAMETER,
    }),
    send: createTransport(env.MAIL_TRANSPORT, env),
    limiter: limiterFromEnv(env),
  });
}
