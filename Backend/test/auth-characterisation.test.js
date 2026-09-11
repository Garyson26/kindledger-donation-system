/**
 * =============================================================================
 * CHARACTERISATION tests for auth.js + users.js + middleware/  (package 3.2)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:auth-char
 *
 * The companion to auth-reset.test.js, which already covers SEC-02 and is a
 * REGRESSION suite that must pass unchanged. This one is a CHARACTERISATION
 * suite: it pins what the rest of the authentication surface does today, before
 * the migration, including the parts that are wrong.
 *
 * BUG-11 IS ALREADY FIXED at the point these were written, which is the whole
 * reason they can assert what they assert. Per AG2, a test asserting a refusal
 * REASON has to know which key to read; while three keys were in play the
 * helper had to accept all of them and could not verify that any particular one
 * carried the reason. Every assertion below reads `error`, and that is only
 * possible because the shape was unified first.
 *
 * AC1: every refusal asserts status, shape and that nothing 500'd.
 * AE4: response shapes are enumerated from what comes back, not inferred.
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
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_authchar_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');

const TAG = 'zzz-authchar';
const PASSWORD = 'FixturePass123!';

let server;
let base;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(3).toString('hex')}@invalid.test`;

// -----------------------------------------------------------------------------
// Storage seam. Package 3.2 reimplements these against repositories/users.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await User.deleteMany({ email: new RegExp('^' + TAG) });
    await PendingSignup.deleteMany({ email: new RegExp('^' + TAG) });
  },

  async createUser({ email, role = 'user', isVerified = true, isActive = true }) {
    await User.deleteOne({ email });
    const doc = await User.create({
      name: 'ZZZ AuthChar',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      role,
      isVerified,
      isActive,
    });
    return doc._id.toString();
  },

  async readUser(email) {
    const u = await User.findOne({ email });
    if (!u) return null;
    return {
      id: u._id.toString(),
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      isVerified: u.isVerified,
      /** Present so SEC-13 and SEC-18 can be asserted without exposing values. */
      storesResetCodeInPlaintext: Boolean(u.resetPasswordCode) && /^\d{6}$/.test(u.resetPasswordCode || ''),
      storesLoginOtpInPlaintext: Boolean(u.loginOTP) && /^\d{6}$/.test(u.loginOTP || ''),
      bcryptCost: u.password ? Number(u.password.split('$')[2]) : null,
      passwordMatches: (candidate) => bcrypt.compare(candidate, u.password),
    };
  },

  async readPendingSignup(email) {
    const p = await PendingSignup.findOne({ email });
    if (!p) return null;
    return {
      email: p.email,
      storesOtpInPlaintext: Boolean(p.signupOTP) && /^\d{6}$/.test(p.signupOTP || ''),
      bcryptCost: p.password ? Number(p.password.split('$')[2]) : null,
    };
  },
};

// -----------------------------------------------------------------------------
async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
const get = (p, token) => call('GET', p, { token });
const post = (p, body, token) => call('POST', p, { body, token });
const put = (p, body, token) => call('PUT', p, { body, token });

/**
 * AC1 + BUG-11. Note what this can now assert: that `error` SPECIFICALLY
 * carries the reason. Before the unification it had to accept any of three
 * keys, which verified almost nothing.
 */
function assertRefused(res, expectedStatus) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a decision, got ${res.status}: ${res.raw.slice(0, 200)}`
  );
  assert.equal(res.status, expectedStatus, res.raw.slice(0, 200));
  assert.ok(res.body, 'a refusal must carry a JSON body');
  assert.equal(
    typeof res.body.error,
    'string',
    `the reason must be under "error": ${res.raw.slice(0, 160)}`
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
      reject(new Error(`This suite needs MongoDB at ${host}:${port} (${why}).`));
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
  await store.reset();
});

after(async () => {
  try {
    await store.reset();
  } finally {
    if (server) server.close();
    await mongoose.connection.close();
  }
});

// =============================================================================
// BUG-11 - the unified refusal shape, asserted at every layer
// =============================================================================

test('BUG-11: every layer names its reason under `error`', async () => {
  // Before the fix: route handlers used `error`, adminAuth used `message`, and
  // authMiddleware used `msg`. The frontend reads `data.error || data.message`,
  // so all four authMiddleware refusals reached the user as "Request failed".
  const email = uniqEmail('bug11');
  await store.createUser({ email });

  const noToken = await get('/api/auth/me');                         // authMiddleware
  const badToken = await get('/api/auth/me', 'not-a-jwt');            // authMiddleware catch
  const nonAdmin = await get('/api/admin/stats', jwt.sign(           // adminAuth
    { userId: (await store.readUser(email)).id, role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  ));

  for (const [label, res] of [['no token', noToken], ['bad token', badToken], ['non-admin', nonAdmin]]) {
    assert.equal(typeof res.body.error, 'string', `${label}: reason under "error"`);
    assert.equal(res.body.message, res.body.error, `${label}: "message" mirrors it for the frontend`);
    assert.equal('msg' in res.body, false, `${label}: "msg" is gone - nothing read it`);
  }
});

test('BUG-11: the reason is a real sentence, not a generic placeholder', async () => {
  // The point of the fix. These strings existed before; nobody could see them.
  const noToken = await get('/api/auth/me');
  assertRefused(noToken, 401);
  assert.match(noToken.body.error, /No token/i);

  const badToken = await get('/api/auth/me', 'not-a-jwt');
  assertRefused(badToken, 401);
  assert.match(badToken.body.error, /Invalid token/i);
});

// =============================================================================
// authMiddleware
// =============================================================================

test('authMiddleware refuses an expired token, and accepts a live one', async () => {
  const email = uniqEmail('mw');
  const id = await store.createUser({ email });

  const expired = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '-1h',
  });
  assertRefused(await get('/api/auth/me', expired), 401);

  const live = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await get('/api/auth/me', live)).status, 200);
});

test('QUIRK: a token for a DELETED user is a 404, not a 401', async () => {
  // The token is valid; the subject is gone. Pinned because 404 from an
  // authentication layer is unusual - a client cannot distinguish "your session
  // is invalid, log in again" from "the thing you asked for does not exist".
  const email = uniqEmail('ghost');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  await User.deleteOne({ email });

  const res = await get('/api/auth/me', token);
  assertRefused(res, 404);
});

test('QUIRK (SEC-05): a DISABLED account is still fully authenticated', async () => {
  // isActive exists on the model and admin.js toggles it, but NO route or
  // middleware reads it. "Disable user" has no effect whatsoever: the account
  // keeps working, and an admin who clicks it believes otherwise.
  const email = uniqEmail('disabled');
  const id = await store.createUser({ email, isActive: false });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const me = await get('/api/auth/me', token);
  assert.equal(me.status, 200, 'CURRENT: a disabled account is accepted');

  const login = await post('/api/auth/login', { email, password: PASSWORD });
  assert.notEqual(login.status, 403, 'CURRENT: login does not check isActive either');
});

test('QUIRK (SEC-05): there is no token revocation - old tokens survive a password change', async () => {
  // No tokenVersion anywhere in routes/, middleware/ or models/. A token issued
  // before a password reset stays valid for its full hour.
  const email = uniqEmail('revoke');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const changed = await post(
    '/api/auth/change-password',
    { oldPassword: PASSWORD, newPassword: 'BrandNewPass456!' },
    token
  );
  assert.equal(changed.status, 200, changed.raw.slice(0, 160));

  const stillWorks = await get('/api/auth/me', token);
  assert.equal(stillWorks.status, 200, 'CURRENT: the pre-change token still works');
});

// =============================================================================
// SEC-03 - NoSQL operator injection
// =============================================================================

test('SEC-03 IS AN AUTHENTICATION BYPASS, not merely an injectable query', async () => {
  // 12+ `findOne({ email })` call sites with no String() coercion anywhere, so
  // `{"email": {"$ne": null}}` is a query OPERATOR rather than an address and
  // matches the first user in the collection.
  //
  // AN EARLIER DRAFT OF THIS TEST UNDERSTATED THE FINDING. It asserted only
  // that the operator "reaches the query". Running it showed something worse:
  // the request gets as far as GENERATING AND STORING A LOGIN OTP, and that
  // code is only reachable AFTER `bcrypt.compare` has succeeded
  // (auth.js:238-256). So the attacker is past the credential check and holds
  // a pending OTP for an account whose address they never had to know.
  //
  // The 500 that comes back is the SMTP send failing in this environment, not a
  // refusal - which is exactly why an outcome-only assertion would have called
  // this "rejected" and moved on (AC1).
  await store.reset();
  const email = uniqEmail('inject');
  await store.createUser({ email });

  const res = await post('/api/auth/login', { email: { $ne: null }, password: PASSWORD });

  assert.equal(
    res.body && res.body.error === 'Invalid credentials',
    false,
    'CURRENT: the operator is NOT rejected as a bad credential'
  );

  // The proof: an OTP was written for the matched user. Only reachable past the
  // password check.
  const u = await User.findOne({ email });
  assert.ok(u, 'the fixture user exists');
  assert.equal(
    /^\d{6}$/.test(u.loginOTP || ''),
    true,
    'CURRENT: a login OTP was issued for an account the caller never named'
  );
});

// =============================================================================
// SEC-08 - user enumeration
// =============================================================================

test('SEC-08 is ALREADY CLOSED on /login - the two cases are indistinguishable', async () => {
  // Recorded as a correction. The security review lists SEC-08 as user
  // enumeration "on five endpoints", and I assumed /login was one of them.
  // It is not: both an unknown address and a wrong password return
  // `400 {"error":"Invalid credentials"}`, byte for byte (auth.js:235-239).
  //
  // Pinned so the migration cannot REINTRODUCE the difference - which is easy
  // to do, because the natural repository implementation returns null for a
  // missing user and false for a bad password, and reporting those separately
  // reads like better error handling.
  const email = uniqEmail('enum');
  await store.createUser({ email });

  const unknown = await post('/api/auth/login', {
    email: uniqEmail('nobody'),
    password: PASSWORD,
  });
  const wrongPassword = await post('/api/auth/login', { email, password: 'WrongPass999!' });

  assert.equal(unknown.status, wrongPassword.status, 'same status');
  assert.equal(unknown.body.error, wrongPassword.body.error, 'same reason, byte for byte');
  assert.equal(unknown.body.error, 'Invalid credentials');

  // The remaining SEC-08 surface is on the OTHER endpoints the review names;
  // this assertion covers /login only and says so.
});

// =============================================================================
// SEC-10 - password policy
// =============================================================================

test('QUIRK (SEC-10): change-password accepts a trivially weak password', async () => {
  const email = uniqEmail('weak');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const res = await post(
    '/api/auth/change-password',
    { oldPassword: PASSWORD, newPassword: 'a' },
    token
  );
  assert.equal(res.status, 200, 'CURRENT: a one-character password is accepted');
  assert.equal(await (await store.readUser(email)).passwordMatches('a'), true);
});

// =============================================================================
// SEC-13 and SEC-18 - storage of secrets
// =============================================================================

test('QUIRK (SEC-13): the login OTP is stored in PLAINTEXT', async () => {
  // Driven through /login rather than /forgot-password because the OTP is
  // SAVED BEFORE THE EMAIL IS SENT (auth.js:253-256), so the storage shape is
  // observable even with no SMTP in this environment. An earlier draft used
  // forgot-password and saw nothing, because the send failed first - which
  // would have read as "SEC-13 is fixed".
  await store.reset();
  const email = uniqEmail('sec13');
  await store.createUser({ email });

  await post('/api/auth/login', { email, password: PASSWORD });

  const u = await store.readUser(email);
  assert.equal(
    u.storesLoginOtpInPlaintext,
    true,
    'CURRENT: a readable 6-digit code sits in the user document'
  );
});

test('QUIRK (SEC-18): passwords are hashed at bcrypt cost 10', async () => {
  const email = uniqEmail('sec18');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  await post('/api/auth/change-password', { oldPassword: PASSWORD, newPassword: 'NewPass789!' }, token);

  assert.equal((await store.readUser(email)).bcryptCost, 10, 'CURRENT: cost 10, not 12');
});

// =============================================================================
// GET /api/auth/me and PUT /api/users/profile
// =============================================================================

test('AE4: what GET /api/auth/me ACTUALLY returns', async () => {
  const email = uniqEmail('me');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const res = await get('/api/auth/me', token);
  assert.equal(res.status, 200);

  // Enumerated from the response. The critical assertion is the absence of the
  // hash, which no amount of reading the handler would confirm as reliably.
  assert.equal('password' in res.body, false, 'the hash must never be returned');
  assert.equal('resetPasswordCode' in res.body, false);
  assert.equal('loginOTP' in res.body, false);
  assert.equal(res.body.email, email);
});

test('PUT /api/users/profile requires a token and updates the caller', async () => {
  const email = uniqEmail('profile');
  const id = await store.createUser({ email });
  const token = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  assertRefused(await put('/api/users/profile', { name: 'X' }), 401);

  const res = await put('/api/users/profile', { name: 'ZZZ Renamed', phone: '123' }, token);
  assert.equal(res.status, 200, res.raw.slice(0, 160));
  assert.equal('password' in (res.body.user || res.body), false, 'no hash in the response');
});

test('QUIRK: /api/auth/me and /api/users/profile verify the JWT inline, not via the middleware', async () => {
  // Code-hygiene finding from PROJECT.md, pinned behaviourally: both duplicate
  // the verification, so any check added to authMiddleware would miss them.
  // SEC-05's isActive enforcement is exactly such a check, which is why this
  // matters for the migration rather than being tidiness.
  //
  // Observable consequence: they answer with DIFFERENT reasons for the same
  // missing-token case than the middleware does.
  const meNoToken = await get('/api/auth/me');
  const profileNoToken = await put('/api/users/profile', { name: 'X' });
  const middlewareNoToken = await post('/api/auth/change-password', { oldPassword: 'x', newPassword: 'y' });

  assert.equal(meNoToken.status, 401);
  assert.equal(profileNoToken.status, 401);
  assert.equal(middlewareNoToken.status, 401);

  // THE DUPLICATION IS VISIBLE FROM OUTSIDE, and this is how. The two inline
  // copies agree with EACH OTHER and differ from the middleware:
  //
  //   /auth/me          "No token provided"              (inline copy)
  //   /users/profile    "No token provided"              (inline copy)
  //   authMiddleware    "No token, authorization denied"
  //
  // Two implementations of one check, and the pair that drifted is the pair
  // nobody maintains. SEC-05 is the reason this matters rather than being
  // untidiness: an isActive check added to authMiddleware would not apply to
  // either of these endpoints, and nothing would say so.
  assert.equal(
    meNoToken.body.error,
    profileNoToken.body.error,
    'the two inline copies agree with each other'
  );
  assert.notEqual(
    meNoToken.body.error,
    middlewareNoToken.body.error,
    'and BOTH differ from the middleware they should be using'
  );
});
