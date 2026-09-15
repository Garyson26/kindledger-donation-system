/**
 * =============================================================================
 * Password-reset brute-force controls - SEC-02, and SEC-04's trust proxy
 * =============================================================================
 *   docker run -d --name kl-mongo -p 27017:27017 mongo:7
 *   npm run test:auth
 *
 * The companion to payment-callbacks.test.js. Same rationale: the SEC-02 and
 * SEC-04 fixes shipped with no committed tests, and Phase 3 will move the user
 * store to MySQL. These are the assertions that must survive that.
 *
 * Same portability discipline: all storage access goes through the `store`
 * seam, assertions are on HTTP responses and persisted state, and nothing
 * touches Mongoose internals.
 *
 * TWO INDEPENDENT CONTROLS, TESTED SEPARATELY. The per-IP rate limiter and the
 * per-account attempt counter are both capped at 5, which makes them easy to
 * confuse. They defend different things: the limiter stops one IP, the counter
 * stops a distributed attack. Each scenario below uses its own
 * X-Forwarded-For so the limiter's budget cannot mask the counter - an earlier
 * version of this suite reported a false failure for exactly that reason.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_auth_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
// SPEC-2 section 4.1: THE SEAM SWITCHES WITH THE ROUTES IT SETS UP DATA FOR.
// Package 3.2 migrated auth.js to MySQL, so these three function bodies move
// with it. THE SIX SCENARIOS BELOW ARE UNTOUCHED - that is the whole point of
// having written them against a seam, and if any of them had needed an edit the
// additive model would have been breached (SPEC-3 section 4.1).
const users = require('../repositories/users');
const prismaModule = require('../config/prisma');

const ORIGINAL_PASSWORD = 'OriginalPass123!';
const EMAIL_PREFIX = 'zzz-auth-test';
const VALID_CODE = '123456';

let server;
let base;

// -----------------------------------------------------------------------------
// Storage seam. Phase 3 reimplements these against Prisma/MySQL.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await users.deleteByEmailPrefix(EMAIL_PREFIX);
  },

  /** A verified user holding a live reset code. */
  async createUserWithResetCode(tag, attempts = 0) {
    const email = `${EMAIL_PREFIX}-${tag}@invalid.test`;
    await users.deleteByEmailPrefix(email);

    const created = await users.create({
      name: 'ZZZ Auth Test',
      email,
      password: ORIGINAL_PASSWORD,
      isVerified: true,
    });
    await users.setResetCode(created.id, VALID_CODE, Date.now() + 15 * 60 * 1000);

    // Seeded by INCREMENTING rather than by writing the column, so the fixture
    // goes through the same path the route does. A fixture that sets a security
    // counter directly can drift from the mechanism it is meant to exercise.
    for (let i = 0; i < attempts; i += 1) {
      await users.incrementResetAttempts(created.id);
    }

    return { id: created.legacyId || created.id, email };
  },

  /** Plain normalised view; no storage types leak past here. */
  async readUser(email) {
    const u = await users.findByEmail(email);
    if (!u) return null;
    return {
      email: u.email,
      resetAttempts: u.resetCodeAttempts ?? 0,
      // The repository never returns the hash (SEC-13), so presence is read
      // from the expiry, which `setResetCode` and `setPassword` write and clear
      // together.
      hasResetCode: Boolean(u.resetCodeExpiresAt),
      passwordIsOriginal: await users.verifyPassword(u.id, ORIGINAL_PASSWORD),
      passwordMatches: (candidate) => users.verifyPassword(u.id, candidate),
    };
  },
};

// -----------------------------------------------------------------------------
async function post(path, body, clientIp) {
  const headers = { 'Content-Type': 'application/json' };
  if (clientIp) headers['X-Forwarded-For'] = clientIp;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, error: json.error, body: json };
}

const resetReq = (email, code, ip) =>
  post('/api/auth/forgot-password/reset', { email, code, newPassword: 'AttackerPass123!' }, ip);

function mongoHostPort(uri) {
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(uri);
  return { host: m ? m[1] : '127.0.0.1', port: m && m[2] ? Number(m[2]) : 27017 };
}

async function assertMongoReachable() {
  const { host, port } = mongoHostPort(process.env.MONGODB_URI);
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (why) => {
      sock.destroy();
      reject(
        new Error(
          `This suite needs MongoDB at ${host}:${port} (${why}).\n` +
            '  docker run -d --name kl-mongo -p 27017:27017 mongo:7'
        )
      );
    };
    sock.setTimeout(4000, () => fail('timeout'));
    sock.once('error', (e) => fail(e.message));
    sock.once('connect', () => {
      sock.destroy();
      resolve();
    });
  });
}

before(async () => {
  await assertMongoReachable();
  const app = require('../app.js');
  for (let i = 0; i < 100 && mongoose.connection.readyState !== 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(mongoose.connection.readyState, 1, 'mongoose did not reach a connected state');

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await store.reset();
});

after(async () => {
  try {
    await store.reset();
  } finally {
    if (server) server.close();
    await mongoose.connection.close();
    await prismaModule.disconnect();
  }
});

// =============================================================================
// SEC-02 - the attempt counter
// =============================================================================

test('SEC-02 each wrong reset code increments the attempt counter', async () => {
  // resetPasswordAttempts existed in the schema and was written but NEVER
  // read, so the 6-digit code was brute-forceable inside its 15-minute
  // window. This is the control that was designed and left unwired.
  const { email } = await store.createUserWithResetCode('increment');

  const observed = [];
  for (let i = 0; i < 5; i++) {
    const r = await resetReq(email, '000' + String(i).padStart(3, '0'), '10.20.0.1');
    const u = await store.readUser(email);
    observed.push(`${r.status}/${u.resetAttempts}`);
  }

  const u = await store.readUser(email);
  assert.equal(u.resetAttempts, 5, `attempts did not reach 5; saw ${observed.join(' ')}`);
  assert.equal(u.passwordIsOriginal, true, 'password must be unchanged');
});

test('SEC-02 at the cap even the CORRECT code is refused and voided', async () => {
  // Seeded at the cap so the per-IP limiter cannot mask the counter.
  const { email } = await store.createUserWithResetCode('atcap', 5);

  const r = await resetReq(email, VALID_CODE, '10.20.0.2');
  const u = await store.readUser(email);

  assert.equal(r.status, 429);
  assert.match(r.error, /Too many attempts/i, `unexpected message: ${r.error}`);
  assert.equal(u.hasResetCode, false, 'the reset code must be voided at the cap');
  assert.equal(u.passwordIsOriginal, true, 'password must be unchanged');
});

test('SEC-02 a legitimate reset below the cap still succeeds', async () => {
  // The control must not break the feature it protects.
  const { email } = await store.createUserWithResetCode('legit', 2);

  const r = await post(
    '/api/auth/forgot-password/reset',
    { email, code: VALID_CODE, newPassword: 'LegitNewPass123!' },
    '10.20.0.3'
  );
  const u = await store.readUser(email);

  assert.equal(r.status, 200);
  assert.equal(await u.passwordMatches('LegitNewPass123!'), true, 'password was not changed');
  assert.equal(u.resetAttempts, 0, 'counter must reset on success');
  assert.equal(u.hasResetCode, false, 'the code must be consumed');
});

test('SEC-02 the attempt counter is NOT reset by a correct code at /verify', async () => {
  // /verify only checks the code; /reset still has to accept it. Clearing the
  // count on a correct guess would hand an attacker a fresh budget of 5 for
  // every lucky hit.
  const { email } = await store.createUserWithResetCode('verify-noreset', 3);

  const r = await post('/api/auth/forgot-password/verify', { email, code: VALID_CODE }, '10.20.0.4');
  const u = await store.readUser(email);

  assert.equal(r.status, 200);
  assert.equal(u.resetAttempts, 3, 'a correct code at /verify must not clear the counter');
});

// =============================================================================
// SEC-02 - the rate limiter, and SEC-04's trust proxy
// =============================================================================

test('SEC-02 the rate limiter is mounted on /forgot-password/reset', async () => {
  const { email } = await store.createUserWithResetCode('limiter');

  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await resetReq(email, '999999', '10.20.1.1');
    if (r.status === 429 && /Too many requests/i.test(r.error || '')) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'a burst from one IP was never rate limited');
});

test('SEC-04 trust proxy keys the limiter per client, not globally', async () => {
  // Uses /login with an unknown email, which returns 400 without touching any
  // counter, so this measures ONLY the limiter's keying.
  //
  // NOTE ON WHAT THIS PROVES. The header is set directly by this test, with no
  // proxy in front. It shows Express READS X-Forwarded-For under
  // trust proxy 1 - it does not show the header is trustworthy. With no proxy
  // deployed, X-Forwarded-For is wholly client-supplied. See the comment above
  // app.set('trust proxy', 1) for the deployment assumption that makes the
  // value correct.
  const login = (ip) =>
    post('/api/auth/login', { email: `nobody-${ip}@invalid.test`, password: 'x' }, ip);

  let exhausted = false;
  let sent = 0;
  for (let i = 0; i < 12; i++) {
    const r = await login('10.20.9.9');
    sent += 1;
    if (r.status === 429) {
      exhausted = true;
      break;
    }
  }
  assert.equal(exhausted, true, `one client was never limited after ${sent} requests`);

  const other = await login('10.20.9.10');
  assert.notEqual(
    other.status,
    429,
    'a different client was blocked by the first one, so the limiter is keyed globally'
  );
});
