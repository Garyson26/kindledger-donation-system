/**
 * =============================================================================
 * CORS refusals are 403, not 500 (DP2)
 * =============================================================================
 *   npm run test:cors
 *
 * A request from an origin not in ALLOWED_ORIGINS is refused BEFORE its route
 * runs, and that is right. It was answered 500, because the CORS check refuses
 * by raising an error and the generic handler turned every error into a 500.
 * Alerting on 500s then fires on every blocked cross-origin request, and real
 * server faults are lost among them.
 *
 * Boots the real app.js. No database: the refusal happens before any route,
 * and the server guard treats an absent database as "unreachable", not as a
 * refusal (config/serverGuard.js).
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ALLOWED_ORIGINS = 'https://donate.example.org';
// An email transport that cannot deliver: app.js refuses to load without one
// once CP1 is merged, and this suite must not depend on which lands first.
delete process.env.RESEND_API_KEY;
process.env.EMAIL_USER = 'kindledger-tests@invalid.test';
process.env.EMAIL_PASSWORD = 'test-only-not-a-password';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';

const ALLOWED = 'https://donate.example.org';
const STRANGER = 'https://evil.example';

let server;
let base;

before(async () => {
  const app = require('../app');
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await require('../config/prisma').disconnect().catch(() => {});
  try {
    await require('../config/rateLimiters').disconnect();
  } catch {
    /* memory store: nothing to close */
  }
});

async function call(method, path, { origin, headers = {}, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

test('DP2: a GET from an origin not allowed is refused with 403, a JSON reason, and no CORS header', async () => {
  const res = await call('GET', '/api/categories', { origin: STRANGER });
  assert.equal(res.status, 403, `a CORS refusal is the client's problem, not a server fault: got ${res.status}`);
  assert.equal(typeof (res.json && res.json.error), 'string', `reason under "error": ${res.text.slice(0, 120)}`);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('DP2: a preflight from an origin not allowed is refused with 403', async () => {
  const res = await call('OPTIONS', '/api/auth/login', {
    origin: STRANGER,
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('DP2: the refusal still happens BEFORE the route - a login from that origin never reaches the handler', async () => {
  // The handler answers 400 "Invalid credentials" to a body with no password.
  // A 403 here means it never ran; a 400 would mean the request got through.
  const res = await call('POST', '/api/auth/login', { origin: STRANGER, body: { email: 'a@example.org' } });
  assert.equal(res.status, 403);
});

test('DP2 control: the allowed origin passes - preflight 204 with its own origin echoed', async () => {
  const res = await call('OPTIONS', '/api/auth/login', {
    origin: ALLOWED,
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
});

test('DP2 control: no Origin at all (curl, a server, a monitor) is not a CORS refusal', async () => {
  const res = await call('POST', '/api/auth/login', { body: { email: 'a@example.org' } });
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 400, 'it reaches the handler, which refuses the missing password');
});
