/**
 * =============================================================================
 * SEC-03 - unauthenticated authentication bypass on the login path
 * =============================================================================
 *   docker run -d --name kl-mongo -p 27017:27017 mongo:7
 *   npm run test:sec03
 *
 * THE FINDING, stated as an outcome rather than a mechanism. It was filed as
 * "NoSQL operator injection", which describes how the input is mishandled and
 * hides what it achieves: posting
 *
 *     {"email": {"$ne": null}, "password": "<any password any user has>"}
 *
 * matches the first user in the collection, passes `bcrypt.compare` against
 * THAT user's hash, and continues past the credential check into OTP
 * generation. The attacker is authenticated as an account whose address they
 * never knew.
 *
 * WHY THESE ASSERT THE MECHANISM AND NOT ONLY THE OUTCOME (AC1).
 *
 * In any environment without SMTP the injected login returns
 * `500 {"error":"Failed to send OTP email"}` - because the send fails AFTER the
 * credential check has already been passed. A test asserting only "the attacker
 * got no session" passes against the VULNERABLE code, because the attacker
 * indeed got no session: the mail server was down.
 *
 * That is exactly how this was first mistaken for a refusal. So every scenario
 * below asserts three things: the status is 400 and NOT 5xx, the body is the
 * standard refusal, and NO LOGIN OTP WAS WRITTEN - the last being the only
 * direct evidence that execution never reached the code past `bcrypt.compare`.
 * =============================================================================
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_sec03_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');

const EMAIL_PREFIX = 'zzz-sec03';
const PASSWORD = 'VictimPassword123!';

let server;
let base;
let victimEmail;

const uniq = (t) => `${EMAIL_PREFIX}-${t}-${crypto.randomBytes(3).toString('hex')}@invalid.test`;

// -----------------------------------------------------------------------------
// Storage seam. Phase 3 reimplements these against Prisma/MySQL.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await User.deleteMany({ email: new RegExp('^' + EMAIL_PREFIX) });
    await PendingSignup.deleteMany({ email: new RegExp('^' + EMAIL_PREFIX) });
  },

  async createUser(email) {
    await User.deleteOne({ email });
    await User.create({
      name: 'ZZZ SEC03 Victim',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      isVerified: true,
      isActive: true,
    });
    return email;
  },

  /**
   * Has ANY user been issued a login OTP?
   *
   * This is the mechanism assertion. `loginOTP` is written at auth.js:253,
   * which is only reachable after `bcrypt.compare` has succeeded - so a stored
   * OTP is direct evidence that the credential check was passed.
   */
  async anyLoginOtpIssued() {
    const n = await User.countDocuments({
      email: new RegExp('^' + EMAIL_PREFIX),
      loginOTP: { $exists: true, $ne: null },
    });
    return n > 0;
  },

  async anyPendingSignup() {
    return (await PendingSignup.countDocuments({ email: new RegExp('^' + EMAIL_PREFIX) })) > 0;
  },
};

/**
 * Every request gets its own client address.
 *
 * `authLimiter` allows 5 per minute PER IP, and this suite makes far more than
 * five legitimate requests. Without distinct addresses the later scenarios get
 * 429 and assert against the limiter instead of against the guard - which is
 * how the first run of this suite failed, on a test about signup that had
 * nothing to do with rate limiting.
 *
 * The same technique the SEC-02 suite uses, and for the same reason: two
 * controls that both answer 4xx are easy to confuse for one another.
 *
 * Worth recording: a request the GUARD rejects never reaches `authLimiter`,
 * because `router.use` runs before the per-route middleware. So an attacker
 * probing with operators does not consume a real user's rate-limit budget -
 * which is the right way round, and was not designed, merely noticed.
 */
let clientSeq = 0;
function nextClientIp() {
  clientSeq += 1;
  return `198.51.100.${(clientSeq % 250) + 1}`;
}

async function post(path, body, ip = nextClientIp()) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, raw };
}

/**
 * The three assertions every injection scenario makes (AC1).
 *
 * `notEqual(5xx)` is the one that matters most: a 500 here would mean the
 * request was processed far enough to fail somewhere else, which is the state
 * this finding was hiding in.
 */
async function assertRefusedAndNotAuthenticated(res, expectedError) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a refusal, got ${res.status} - a 5xx means the request was PROCESSED ` +
      `and failed later, which is how SEC-03 read as a refusal: ${res.raw.slice(0, 160)}`
  );
  assert.equal(res.status, 400, res.raw.slice(0, 160));
  assert.equal(res.body && res.body.error, expectedError);
  assert.equal(
    await store.anyLoginOtpIssued(),
    false,
    'A LOGIN OTP WAS ISSUED - execution reached past bcrypt.compare, so the ' +
      'credential check was passed. This is the bypass, not a near miss.'
  );
}

function mongoHostPort(uri) {
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(uri);
  return { host: m ? m[1] : '127.0.0.1', port: m && m[2] ? Number(m[2]) : 27017 };
}

before(async () => {
  const { host, port } = mongoHostPort(process.env.MONGODB_URI);
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (why) => {
      sock.destroy();
      reject(
        new Error(
          `This suite needs MongoDB at ${host}:${port} (${why}).\n` +
            '  docker run -d --name kl-mongo -p 27017:27017 mongo:7\n' +
            '  Override with TEST_MONGODB_URI.'
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

  const app = require('../app.js');
  for (let i = 0; i < 100 && mongoose.connection.readyState !== 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(mongoose.connection.readyState, 1, 'mongoose did not connect');

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    await store.reset();
  } finally {
    if (server) server.close();
    await mongoose.connection.close();
  }
});

beforeEach(async () => {
  await store.reset();
  victimEmail = await store.createUser(uniq('victim'));
});

// =============================================================================
// The bypass itself
// =============================================================================

test('SEC-03 the $ne operator is refused, and never reaches OTP generation', async () => {
  // THE EXPLOIT. The attacker knows no address; they supply an operator that
  // matches everyone, and a password that happens to be the victim's.
  const res = await post('/api/auth/login', { email: { $ne: null }, password: PASSWORD });
  await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
});

test('SEC-03 every operator shape is refused, not just $ne', async () => {
  // A fix that special-cased `$ne` would leave the class open. The guard
  // rejects the TYPE, so the particular operator does not matter.
  for (const email of [
    { $ne: null },
    { $gt: '' },
    { $regex: '.*' },
    { $exists: true },
    { $in: ['a@b.c', 'd@e.f'] },
    { $nin: [] },
    { $not: { $eq: 'nobody@invalid.test' } },
  ]) {
    const res = await post('/api/auth/login', { email, password: PASSWORD });
    await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
  }
});

test('SEC-03 an ARRAY is refused too', async () => {
  // typeof [] === 'object', and an array reaching a query position is the same
  // class. Asserted because "not an object" is easy to write as a check that
  // misses arrays.
  const res = await post('/api/auth/login', { email: ['a@b.c'], password: PASSWORD });
  await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
});

test('SEC-03 a non-string scalar in email is refused', async () => {
  for (const email of [42, true]) {
    const res = await post('/api/auth/login', { email, password: PASSWORD });
    await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
  }
});

test('SEC-03 an operator in PASSWORD is refused as well', async () => {
  // `password` is not in query-operator position today - it goes to
  // bcrypt.compare. It is rejected anyway, because the guard rejects the type
  // rather than depending on an enumeration of call sites staying accurate as
  // handlers change.
  const res = await post('/api/auth/login', { email: victimEmail, password: { $ne: null } });
  await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
});

// =============================================================================
// The refusal must be indistinguishable from a wrong password (SEC-08)
// =============================================================================

test('the injection refusal is byte-identical to a wrong-password refusal', async () => {
  // SEC-08 is already closed on /login: unknown address and wrong password both
  // answer `400 Invalid credentials`. A distinctive message for the injection
  // case would reopen enumeration for anyone probing with an operator - they
  // could tell "this endpoint rejects operators" from "no such user".
  // Three separate addresses: the limiter caps at 5/min per IP and three
  // logins from one address would risk a 429 being compared against a 400.
  const injected = await post('/api/auth/login', { email: { $ne: null }, password: PASSWORD });
  const wrongPassword = await post('/api/auth/login', { email: victimEmail, password: 'nope' });
  const unknown = await post('/api/auth/login', { email: uniq('nobody'), password: PASSWORD });

  assert.equal(injected.status, wrongPassword.status);
  assert.equal(injected.status, unknown.status);
  assert.equal(injected.body.error, wrongPassword.body.error);
  assert.equal(injected.body.error, unknown.body.error);
  assert.equal(injected.body.error, 'Invalid credentials');
});

// =============================================================================
// Every other auth entry point
// =============================================================================

test('SEC-03 every auth endpoint that queries by email is guarded', async () => {
  // The finding is not "login is vulnerable" - it is that 11 `findOne({ email })`
  // sites take the value unvalidated. Each entry point is exercised.
  const cases = [
    ['/api/auth/signup', { name: 'x', email: { $ne: null }, password: PASSWORD }],
    ['/api/auth/signup/verify-otp', { email: { $ne: null }, otp: '123456' }],
    ['/api/auth/signup/resend-otp', { email: { $ne: null } }],
    ['/api/auth/login/verify-otp', { email: { $ne: null }, otp: '123456' }],
    ['/api/auth/login/resend-otp', { email: { $ne: null } }],
    ['/api/auth/forgot-password/request', { email: { $ne: null } }],
    ['/api/auth/forgot-password/verify', { email: { $ne: null }, code: '123456' }],
    [
      '/api/auth/forgot-password/reset',
      { email: { $ne: null }, code: '123456', newPassword: 'Attacker123!' },
    ],
  ];

  for (const [path, body] of cases) {
    const res = await post(path, body);
    assert.notEqual(
      Math.floor(res.status / 100),
      5,
      `${path} returned ${res.status}: ${res.raw.slice(0, 140)}`
    );
    assert.equal(res.status, 400, `${path}: ${res.raw.slice(0, 140)}`);
    assert.equal(typeof res.body.error, 'string', `${path} must name a reason`);
  }

  // Nothing was created or issued by any of them.
  assert.equal(await store.anyLoginOtpIssued(), false);
  assert.equal(await store.anyPendingSignup(), false, 'no pending signup was created');

  // The victim's password is untouched - /forgot-password/reset did not run.
  const victim = await User.findOne({ email: victimEmail });
  assert.equal(await bcrypt.compare(PASSWORD, victim.password), true);
});

// =============================================================================
// The guard must not break legitimate traffic
// =============================================================================

test('a normal login still works and still issues an OTP', async () => {
  // The other half of a hotfix: it must not close the endpoint it protects.
  // A 500 here is the SMTP send failing in this environment, which is fine -
  // what matters is that execution REACHED it, which the stored OTP proves.
  const res = await post('/api/auth/login', { email: victimEmail, password: PASSWORD });

  assert.notEqual(res.status, 400, `a valid login must not be refused: ${res.raw.slice(0, 160)}`);
  assert.notEqual(res.status, 429, 'a 429 here would mean this asserted against the RATE LIMITER');
  assert.equal(
    await store.anyLoginOtpIssued(),
    true,
    'a legitimate login must still reach OTP generation'
  );
});

test('a wrong password is still refused, and issues no OTP', async () => {
  const res = await post('/api/auth/login', { email: victimEmail, password: 'WrongPass999!' });
  await assertRefusedAndNotAuthenticated(res, 'Invalid credentials');
});

test('an absent email is still handled by the handler, not swallowed by the guard', async () => {
  // The guard skips null and undefined on purpose: "missing" is a client bug
  // with an existing, more useful message, and taking that over would change
  // behaviour beyond the finding's scope.
  const res = await post('/api/auth/forgot-password/request', {});
  assert.notEqual(Math.floor(res.status / 100), 5, res.raw.slice(0, 160));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /required/i, 'the handler answered, not the guard');
});

test('a legitimate signup is unaffected by the guard', async () => {
  const res = await post('/api/auth/signup', {
    name: 'ZZZ Legit',
    email: uniq('legit'),
    password: 'LegitPassword123!',
  });

  // NOT refused by the guard. That is the whole assertion here.
  assert.notEqual(res.status, 400, `a valid signup must not be refused: ${res.raw.slice(0, 160)}`);
  assert.notEqual(res.status, 429, 'a 429 here would mean this asserted against the RATE LIMITER');

  // In an environment without SMTP this ends as 500 "Failed to send
  // verification email" - and the handler then ROLLS BACK the pending signup
  // it had already written (auth.js:95-99). So "no pending signup exists" is
  // CORRECT here and is not evidence the guard blocked anything.
  //
  // An earlier version of this test asserted the pending signup survived, which
  // was wrong about the code rather than about the guard: it assumed a working
  // mail server. The rollback is a feature, and asserting the error text is
  // what distinguishes "the guard let it through and the mail failed" from
  // "the guard refused it".
  if (Math.floor(res.status / 100) === 5) {
    assert.match(
      res.body.error,
      /verification email/i,
      'it reached the EMAIL SEND, which is past every query this hotfix guards'
    );
  } else {
    assert.equal(await store.anyPendingSignup(), true, 'with SMTP, the pending signup persists');
  }
});
