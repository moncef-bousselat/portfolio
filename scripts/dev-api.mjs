/**
 * Local contact API: the real Lambda handler behind a plain HTTP server, so
 * the form can be exercised end to end with no AWS credentials.
 *
 *   npm run dev       site + this, together (Vite proxies /api/* here)
 *   npm run dev:api   this alone, restarting when the handler changes
 *
 * It plays API Gateway's part: only POST /api/contact reaches the handler,
 * which receives an HTTP API payload 2.0 event; anything else is the same
 * 404 API Gateway gives an unmatched route.
 *
 * Configuration is api/contact/.env (git-ignored; copy .env.example). Without
 * one, the defaults below apply: the console transport and Cloudflare's
 * always-pass dummy secret, so nothing leaves this machine.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { handlerFromEnv } from '../api/contact/src/config.ts';

const DEFAULTS = {
  MAIL_TRANSPORT: 'console',
  MAIL_FROM: 'contact@localhost.test',
  MAIL_TO: 'owner@localhost.test',
  // Cloudflare's dummy secret that accepts every token.
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  // Every local request comes from 127.0.0.1, so production's 300 s would
  // block each test message for five minutes. Long enough to see the 429.
  RATE_LIMIT_WINDOW_SECONDS: '60',
};
for (const [name, value] of Object.entries(DEFAULTS)) {
  process.env[name] ||= value;
}

const handler = handlerFromEnv(process.env);

const port = Number(process.env.CONTACT_API_PORT ?? 8787);
const host = '127.0.0.1';

/** A node request as an HTTP API payload 2.0 event. */
function toEvent(req, url, body) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = Array.isArray(value) ? value.join(',') : value;
  }
  return {
    version: '2.0',
    routeKey: 'POST /api/contact',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    body,
    isBase64Encoded: false,
    requestContext: {
      requestId: randomUUID(),
      http: {
        method: req.method,
        path: url.pathname,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'] ?? '',
      },
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method !== 'POST' || url.pathname !== '/api/contact') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    console.log(`404 ${req.method} ${url.pathname}`);
    return;
  }

  try {
    const result = await handler(toEvent(req, url, await readBody(req)));
    res.writeHead(result.statusCode ?? 200, result.headers);
    res.end(result.body);
  } catch (error) {
    // Lambda would answer this as a 500 with no detail; so does this.
    console.error(error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Internal Server Error' }));
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is in use. Pick another with CONTACT_API_PORT=<n>.`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(
    `Contact API on http://${host}:${port}/api/contact ` +
      `(MAIL_TRANSPORT=${process.env.MAIL_TRANSPORT})`,
  );
});
