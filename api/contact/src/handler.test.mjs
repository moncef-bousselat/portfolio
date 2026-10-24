import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlerFromEnv } from './config.ts';
import { createHandler, fromCloudFront, visitorIp } from './handler.ts';
import { memoryLimiter } from './ratelimit.ts';

const form = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'A private message body.',
  token: 'XXXX.DUMMY.TOKEN.XXXX',
  website: '',
  elapsedMs: 9000,
};

/** An HTTP API payload 2.0 event, as API Gateway delivers it. */
function event({ method = 'POST', body = form, headers = {}, base64 = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    version: '2.0',
    routeKey: 'POST /api/contact',
    rawPath: '/api/contact',
    headers: { 'content-type': 'application/json', ...headers },
    body: base64 ? Buffer.from(text).toString('base64') : text,
    isBase64Encoded: base64,
    requestContext: {
      requestId: 'req-1',
      http: { method, path: '/api/contact', sourceIp: '198.51.100.1' },
    },
  };
}

/** A handler wired to fakes, with every call recorded. */
function setup(overrides = {}) {
  const calls = { verify: [], send: [], logs: [], secretReads: 0 };
  const handler = createHandler({
    from: 'contact@site.test',
    to: 'owner@site.test',
    expectedHostname: 'site.test',
    loadSecret: async () => {
      calls.secretReads += 1;
      return 'secret';
    },
    verify: async (options) => {
      calls.verify.push(options);
      return { ok: true };
    },
    send: async (mail) => {
      calls.send.push(mail);
    },
    now: () => new Date('2026-10-21T00:00:00Z'),
    log: (entry) => calls.logs.push(entry),
    ...overrides,
  });
  return { handler, calls };
}

const json = (result) => JSON.parse(result.body);

describe('handler: happy path', () => {
  it('verifies the token, sends one email and answers 200', async () => {
    const { handler, calls } = setup();
    const result = await handler(event());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(json(result), { ok: true });
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'no-store');

    assert.equal(calls.verify.length, 1);
    assert.equal(calls.verify[0].secret, 'secret');
    assert.equal(calls.verify[0].token, form.token);
    assert.equal(calls.verify[0].expectedHostname, 'site.test');

    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].to, 'owner@site.test');
    assert.equal(calls.send[0].replyTo, 'ada@example.com');
  });

  it('decodes a base64 body', async () => {
    const { handler, calls } = setup();
    assert.equal((await handler(event({ base64: true }))).statusCode, 200);
    assert.equal(calls.send.length, 1);
  });
});

describe('handler: refusals', () => {
  it('answers 405 with Allow to anything but POST', async () => {
    const { handler, calls } = setup();
    const result = await handler(event({ method: 'GET' }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.allow, 'POST');
    assert.equal(calls.verify.length, 0);
  });

  it('passes request-level failures through with their status', async () => {
    const { handler } = setup();
    const cases = [
      [event({ headers: { 'content-type': 'text/plain' } }), 415, 'unsupportedMediaType'],
      [event({ body: 'x'.repeat(40_000) }), 413, 'tooLarge'],
      [event({ body: '{' }), 400, 'badRequest'],
    ];
    for (const [input, status, error] of cases) {
      const result = await handler(input);
      assert.equal(result.statusCode, status);
      assert.deepEqual(json(result), { ok: false, error });
    }
  });

  it('answers 400 with per-field codes, before spending a Siteverify call', async () => {
    const { handler, calls } = setup();
    const result = await handler(event({ body: { ...form, email: 'nope', message: '' } }));
    assert.equal(result.statusCode, 400);
    assert.deepEqual(json(result), {
      ok: false,
      error: 'validation',
      fields: { email: 'invalid', message: 'required' },
    });
    assert.equal(calls.verify.length, 0);
    assert.equal(calls.secretReads, 0);
  });

  it('pretends success for a filled honeypot or a too-fast submission, sending nothing', async () => {
    for (const body of [
      { ...form, website: 'https://spam.example' },
      { ...form, elapsedMs: 200 },
    ]) {
      const { handler, calls } = setup();
      const result = await handler(event({ body }));
      assert.equal(result.statusCode, 200);
      assert.deepEqual(json(result), { ok: true });
      assert.equal(calls.verify.length, 0);
      assert.equal(calls.send.length, 0);
      assert.equal(calls.logs[0].outcome, 'suppressed');
    }
  });

  it('answers 403 when Turnstile rejects the token', async () => {
    const { handler, calls } = setup({
      verify: async () => ({ ok: false, reason: 'rejected', codes: ['timeout-or-duplicate'] }),
    });
    const result = await handler(event());
    assert.equal(result.statusCode, 403);
    assert.deepEqual(json(result), { ok: false, error: 'challenge' });
    assert.equal(calls.send.length, 0);
    assert.deepEqual(calls.logs[0].codes, ['timeout-or-duplicate']);
  });

  it('answers 503 when Turnstile cannot be reached', async () => {
    const { handler } = setup({
      verify: async () => ({ ok: false, reason: 'unavailable', codes: [] }),
    });
    const result = await handler(event());
    assert.equal(result.statusCode, 503);
    assert.deepEqual(json(result), { ok: false, error: 'unavailable' });
  });

  it('answers 503 when the secret cannot be loaded', async () => {
    const { handler, calls } = setup({
      loadSecret: async () => {
        throw new Error('AccessDenied');
      },
    });
    const result = await handler(event());
    assert.equal(result.statusCode, 503);
    assert.equal(calls.verify.length, 0);
  });

  it('answers 502 when sending fails', async () => {
    const { handler, calls } = setup({
      send: async () => {
        const error = new Error('Email address is not verified.');
        error.name = 'MessageRejected';
        throw error;
      },
    });
    const result = await handler(event());
    assert.equal(result.statusCode, 502);
    assert.deepEqual(json(result), { ok: false, error: 'sendFailed' });
    assert.equal(calls.logs[0].error, 'MessageRejected');
  });
});

describe('handler: logging', () => {
  it('never logs the visitor’s details or message, whatever the outcome', async () => {
    const outcomes = [
      setup(),
      setup({ verify: async () => ({ ok: false, reason: 'rejected', codes: ['x'] }) }),
      setup({
        send: async () => {
          throw new Error(`failed for ${form.email}: ${form.message}`);
        },
      }),
    ];
    for (const { handler, calls } of outcomes) {
      await handler(event({ headers: { 'cloudfront-viewer-address': '203.0.113.9:4431' } }));
      assert.equal(calls.logs.length, 1);
      const logged = JSON.stringify(calls.logs);
      for (const secret of [form.name, form.email, form.message, form.token, '203.0.113.9']) {
        assert.equal(logged.includes(secret), false, `log contains ${secret}`);
      }
      assert.equal(calls.logs[0].requestId, 'req-1');
    }
  });

  it('logs which fields failed, not their values', async () => {
    const { handler, calls } = setup();
    await handler(event({ body: { ...form, email: 'bad-address' } }));
    assert.deepEqual(calls.logs[0].fields, ['email']);
    assert.equal(JSON.stringify(calls.logs).includes('bad-address'), false);
  });
});

describe('handler: per-IP limit', () => {
  const viewer = (ip) => event({ headers: { 'cloudfront-viewer-address': `${ip}:4431` } });

  it('allows one message per visitor per window, answering 429 with Retry-After', async () => {
    const { handler, calls } = setup({ limiter: memoryLimiter(300) });
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 200);

    const second = await handler(viewer('203.0.113.9'));
    assert.equal(second.statusCode, 429);
    assert.deepEqual(json(second), { ok: false, error: 'rateLimited' });
    assert.equal(second.headers['retry-after'], '300');
    assert.equal(calls.send.length, 1);

    assert.equal((await handler(viewer('198.51.100.7'))).statusCode, 200);
  });

  it('opens again once the window has passed', async () => {
    let clock = new Date('2026-10-21T00:00:00Z');
    const { handler } = setup({ limiter: memoryLimiter(300), now: () => clock });
    await handler(viewer('203.0.113.9'));
    clock = new Date('2026-10-21T00:04:59Z');
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 429);
    clock = new Date('2026-10-21T00:05:00Z');
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 200);
  });

  it('spends no slot when Turnstile rejects, so nobody can lock out a shared IP', async () => {
    const limiter = memoryLimiter(300);
    const rejected = setup({
      limiter,
      verify: async () => ({ ok: false, reason: 'rejected', codes: [] }),
    });
    await rejected.handler(viewer('203.0.113.9'));
    const { handler } = setup({ limiter });
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 200);
  });

  it('gives the slot back when sending fails', async () => {
    const limiter = memoryLimiter(300);
    const failing = setup({
      limiter,
      send: async () => {
        throw new Error('ses down');
      },
    });
    assert.equal((await failing.handler(viewer('203.0.113.9'))).statusCode, 502);
    const { handler } = setup({ limiter });
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 200);
  });

  it('lets the message through when the limit store fails, and says so in the log', async () => {
    const { handler, calls } = setup({
      limiter: {
        windowSeconds: 300,
        claim: async () => {
          throw new Error('throttled');
        },
        release: async () => undefined,
      },
    });
    assert.equal((await handler(viewer('203.0.113.9'))).statusCode, 200);
    assert.deepEqual(
      calls.logs.map((entry) => entry.outcome),
      ['limitUnavailable', 'sent'],
    );
  });

  it('keys the limit on a hash, never the IP', async () => {
    const claimed = [];
    const { handler, calls } = setup({
      limiter: {
        windowSeconds: 300,
        claim: async (key) => (claimed.push(key), true),
        release: async () => undefined,
      },
    });
    await handler(viewer('203.0.113.9'));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].includes('203.0.113'), false);
    assert.equal(JSON.stringify(calls.logs).includes('203.0.113.9'), false);
  });
});

describe('handler: origin check', () => {
  const originSecret = 'a-long-random-origin-secret';

  it('refuses a request without the CloudFront secret before reading it', async () => {
    for (const headers of [{}, { 'x-origin-verify': 'wrong' }, { 'x-origin-verify': '' }]) {
      const { handler, calls } = setup({ originSecret });
      const result = await handler(event({ headers }));
      assert.equal(result.statusCode, 403);
      assert.deepEqual(json(result), { ok: false, error: 'forbidden' });
      assert.equal(calls.secretReads, 0);
      assert.equal(calls.verify.length + calls.send.length, 0);
      assert.equal(calls.logs[0].stage, 'origin');
    }
  });

  it('lets a request with the secret through', async () => {
    const { handler, calls } = setup({ originSecret });
    const result = await handler(event({ headers: { 'x-origin-verify': originSecret } }));
    assert.equal(result.statusCode, 200);
    assert.equal(calls.send.length, 1);
  });

  it('never logs the secret', async () => {
    const { handler, calls } = setup({ originSecret });
    await handler(event({ headers: { 'x-origin-verify': 'wrong' } }));
    assert.equal(JSON.stringify(calls.logs).includes('wrong'), false);
  });

  it('compares values of different lengths without throwing', () => {
    const withSecret = (value) => ({ ...event(), headers: { 'x-origin-verify': value } });
    assert.equal(fromCloudFront(withSecret('x'), originSecret), false);
    assert.equal(fromCloudFront(withSecret(originSecret + 'x'), originSecret), false);
    assert.equal(fromCloudFront(withSecret(originSecret), originSecret), true);
  });
});

describe('visitorIp', () => {
  const withHeaders = (headers) => ({ ...event(), headers });

  it('prefers CloudFront-Viewer-Address and strips the port', () => {
    assert.equal(
      visitorIp(withHeaders({ 'cloudfront-viewer-address': '203.0.113.9:4431' })),
      '203.0.113.9',
    );
    assert.equal(
      visitorIp(withHeaders({ 'cloudfront-viewer-address': '2001:db8::1:4431' })),
      '2001:db8::1',
    );
  });

  it('falls back to the source IP without CloudFront', () => {
    assert.equal(visitorIp(withHeaders({})), '198.51.100.1');
  });
});

describe('handlerFromEnv', () => {
  const env = {
    MAIL_TRANSPORT: 'console',
    MAIL_FROM: 'contact@site.test',
    MAIL_TO: 'owner@site.test',
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  };

  it('builds a handler from a complete local environment', () => {
    assert.equal(typeof handlerFromEnv(env), 'function');
  });

  for (const name of ['MAIL_FROM', 'MAIL_TO', 'MAIL_TRANSPORT']) {
    it(`fails at startup without ${name}`, () => {
      assert.throws(() => handlerFromEnv({ ...env, [name]: undefined }), new RegExp(name));
    });
  }

  it('requires the origin secret inside Lambda, not locally', () => {
    const lambda = {
      ...env,
      MAIL_TRANSPORT: 'ses',
      AWS_LAMBDA_FUNCTION_NAME: 'portfolio-contact',
      RATE_LIMIT_TABLE: 'portfolio-contact-limits',
    };
    assert.throws(() => handlerFromEnv(lambda), /ORIGIN_VERIFY_SECRET/);
    assert.equal(typeof handlerFromEnv({ ...lambda, ORIGIN_VERIFY_SECRET: 'x' }), 'function');
  });

  it('requires the limit table inside Lambda, where a memory limit means nothing', () => {
    const lambda = {
      ...env,
      MAIL_TRANSPORT: 'ses',
      AWS_LAMBDA_FUNCTION_NAME: 'portfolio-contact',
      ORIGIN_VERIFY_SECRET: 'x',
    };
    assert.throws(() => handlerFromEnv(lambda), /RATE_LIMIT_TABLE/);
    assert.equal(typeof handlerFromEnv({ ...lambda, RATE_LIMIT_WINDOW_SECONDS: '0' }), 'function');
  });

  for (const value of ['-1', '1.5', 'five']) {
    it(`refuses RATE_LIMIT_WINDOW_SECONDS=${JSON.stringify(value)}`, () => {
      assert.throws(
        () => handlerFromEnv({ ...env, RATE_LIMIT_WINDOW_SECONDS: value }),
        /RATE_LIMIT_WINDOW_SECONDS/,
      );
    });
  }

  it('fails at startup with no Turnstile secret source', () => {
    assert.throws(
      () => handlerFromEnv({ ...env, TURNSTILE_SECRET: undefined }),
      /TURNSTILE_SECRET/,
    );
  });
});
