/**
 * =============================================================================
 * The rate limiters ON A REDIS STORE - RATE-01 and RATE-02 (remediation map DH1)
 * =============================================================================
 *   npm run test:rate-limiter-redis
 *
 * WHY THIS SUITE EXISTS. Every other suite runs the limiters without REDIS_URL,
 * so each limiter builds its own MemoryStore - and both defects below exist
 * only when the limiters share Redis. CI and local runs could not see them;
 * the first production log did. The same shape as the suites that only ever
 * passed inside the container: the configuration under test was not the one
 * that ships.
 *
 * WHAT IS FAKE, AND WHAT IS NOT. Only the `redis` client is replaced, through
 * require.cache, with an in-memory Redis that answers the two scripts
 * rate-limit-redis loads and keeps key expiry on a clock the test controls.
 * Everything above it is the real code: config/rateLimiters.js, the real
 * rate-limit-redis and express-rate-limit, mounted on real routes. The
 * assertions are HTTP status codes, not what the fake was sent.
 *
 * ORDER MATTERS, AND IS PRODUCTION'S. app.js loads routes/auth.js (authLimiter,
 * then resetAttemptLimiter) before routes/payment.js (paymentInitiateLimiter).
 * RATE-01 depends on which limiter initialises last, so every test builds them
 * in that order.
 * =============================================================================
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const RATE_LIMITERS = path.join(__dirname, '..', 'config', 'rateLimiters.js');
const REDIS_MODULE = require.resolve('redis');

function timeoutError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

/**
 * Just enough Redis for rate-limit-redis 6: SCRIPT LOAD, EVALSHA of its
 * increment and get scripts (semantics transcribed from their Lua), DECR, DEL.
 * `down` makes every command time out, as a cold start that cannot reach Redis
 * does.
 */
class FakeRedis {
  constructor() {
    this.now = 0;
    this.keys = new Map();
    this.scripts = new Map();
    this.down = false;
  }

  advance(ms) {
    this.now += ms;
  }

  pttl(key) {
    const entry = this.keys.get(key);
    if (!entry) return -2;
    const left = entry.expiresAt - this.now;
    if (left <= 0) {
      this.keys.delete(key);
      return -2;
    }
    return left;
  }

  async send(args) {
    if (this.down) throw timeoutError();
    const [command, ...rest] = args;
    if (command === 'SCRIPT') {
      const sha = `sha${this.scripts.size + 1}`;
      this.scripts.set(sha, rest[1]);
      return sha;
    }
    if (command === 'EVALSHA') {
      const [sha, , key, windowMs] = rest;
      const source = this.scripts.get(sha);
      if (!source) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      const ttl = this.pttl(key);
      if (source.includes('INCR')) {
        if (ttl <= 0) {
          this.keys.set(key, { hits: 1, expiresAt: this.now + Number(windowMs) });
          return [1, Number(windowMs)];
        }
        const entry = this.keys.get(key);
        entry.hits += 1;
        return [entry.hits, ttl];
      }
      const entry = this.keys.get(key);
      return [entry ? String(entry.hits) : false, ttl];
    }
    if (command === 'DECR') {
      const entry = this.keys.get(rest[0]);
      if (entry) entry.hits -= 1;
      return entry ? entry.hits : -1;
    }
    if (command === 'DEL') return this.keys.delete(rest[0]) ? 1 : 0;
    throw new Error(`FakeRedis: unexpected command ${command}`);
  }

  client() {
    return {
      on() {},
      connect: async () => {},
      unref() {},
      isOpen: true,
      quit: async () => {},
      sendCommand: (args) => this.send(args),
    };
  }
}

let fake;
let server;
let base;
let savedRedisUrl;

/**
 * A fresh copy of config/rateLimiters.js on the fake Redis, with production's
 * three limiters created in production's order and mounted on real routes.
 */
async function startApp() {
  delete require.cache[RATE_LIMITERS];
  require.cache[REDIS_MODULE] = {
    id: REDIS_MODULE,
    filename: REDIS_MODULE,
    loaded: true,
    exports: { createClient: () => fake.client() },
  };
  const rl = require(RATE_LIMITERS);

  const auth = rl.authLimiter();
  const resetAttempt = rl.resetAttemptLimiter();
  const paymentInitiate = rl.paymentInitiateLimiter();
  assert.equal(rl.storeKind(), 'redis', 'the suite must be exercising the Redis store');

  const app = express();
  app.use(express.json());
  const ok = (req, res) => res.json({ ok: true });
  app.post('/login', auth, ok);
  app.post('/forgot-password/verify', resetAttempt, ok);
  app.post('/payment/initiate', paymentInitiate, ok);

  // Let every limiter's store initialisation settle, as it would between a
  // cold start and the first request.
  await new Promise((resolve) => setTimeout(resolve, 20));

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function post(route, body = {}) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function postTimes(n, route, body) {
  const statuses = [];
  for (let i = 0; i < n; i++) statuses.push(await post(route, body));
  return statuses;
}

beforeEach(() => {
  savedRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://fake-redis.invalid:6379';
  fake = new FakeRedis();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  delete require.cache[RATE_LIMITERS];
  delete require.cache[REDIS_MODULE];
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
});

// -----------------------------------------------------------------------------
// RATE-01: each limiter keeps its own window
// -----------------------------------------------------------------------------

test('RATE-01: the reset-code cap still refuses 61 seconds later - its window is 15 minutes, not 60 s', async () => {
  await startApp();
  const body = { email: 'victim@example.org' };

  assert.deepEqual(await postTimes(5, '/forgot-password/verify', body), [200, 200, 200, 200, 200]);
  assert.equal(await post('/forgot-password/verify', body), 429, 'the sixth attempt is refused');

  fake.advance(61 * 1000);
  assert.equal(
    await post('/forgot-password/verify', body),
    429,
    'RATE-01: 61 s later the cap must STILL refuse. 200 here means the reset-attempt keys expire on ' +
      "another limiter's 60 s window, so the cap is 5 per minute instead of 5 per 15 minutes"
  );

  fake.advance(15 * 60 * 1000);
  assert.equal(await post('/forgot-password/verify', body), 200, 'and once the 15 minutes have passed, it allows again');
});

test('RATE-01: the login limiter keeps its own 60 s window, unaffected by the 15-minute one', async () => {
  await startApp();

  assert.deepEqual(await postTimes(6, '/login'), [200, 200, 200, 200, 200, 429]);
  fake.advance(61 * 1000);
  assert.equal(await post('/login'), 200, 'the login window is one minute, so it allows again after 61 s');
});

// -----------------------------------------------------------------------------
// RATE-02: a Redis timeout at start-up is recovered from
// -----------------------------------------------------------------------------

test('RATE-02: Redis unreachable at start-up, then back - limited routes work instead of answering 500', async () => {
  fake.down = true;
  await startApp(); // every store initialisation times out, as on the pdx1 cold start
  fake.down = false;

  assert.deepEqual(
    await postTimes(3, '/login'),
    [200, 200, 200],
    'RATE-02: Redis is healthy now. 500 here means the instance kept the failed start-up and refuses ' +
      'every limited request until it is recycled'
  );
  assert.deepEqual(await postTimes(2, '/payment/initiate'), [200, 200], 'donation initiation recovers too');
});

test('RATE-02: after recovering, the limiter counts - recovery is not a bypass', async () => {
  fake.down = true;
  await startApp();
  fake.down = false;

  assert.deepEqual(await postTimes(6, '/login'), [200, 200, 200, 200, 200, 429]);
});

test('PINNED, A DECISION: while Redis is unreachable, a limited route is refused rather than let through unlimited', async () => {
  // Fail CLOSED. Unchanged by RATE-02's fix, which is about recovering once
  // Redis is back. Whether a limiter that cannot count should instead let the
  // request through is Gary's decision (remediation map DH1); if it is made,
  // this test changes with it, deliberately.
  await startApp();
  fake.down = true;

  const status = await post('/login');
  assert.equal(status >= 500, true, `expected a refusal while Redis is down, got ${status}`);
});
