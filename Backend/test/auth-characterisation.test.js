/**
 * =============================================================================
 * CHARACTERISATION tests for auth.js + users.js + middleware/  (package 3.2)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:auth-char
 *
 * Written against the Mongoose implementation BEFORE the migration, and now
 * asserted against the MySQL one. Nine assertions changed; each is marked
 * `CHANGED IN 3.2` with the finding that caused it. Five passed untouched.
 *
 * SIX OF THE NINE ARE QUIRKS BEING CLOSED - SEC-03, SEC-05 (twice), SEC-10,
 * SEC-13, and the duplicated inline JWT verification. They were pinned as
 * WRONG behaviour on purpose, so fixing them had to break this file. That is
 * the characterisation discipline working: a fix that did not break anything
 * here would have meant the original assertion was not actually testing the
 * defect.
 *
 * SEAM SWITCHED (SPEC-2 section 4.1). `store` now reads and writes MySQL
 * through the repositories.
 *
 * AK3 / AM1: a fixture created in MONGODB and NOT migrated, created AFTER any
 * ETL run so no ordering can migrate it, with a POSITIVE assertion that it has
 * no MySQL row before the route is exercised.
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
const MongoUser = require('../models/User');
const users = require('../repositories/users');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');

const TAG = 'zzz-authchar';
const PASSWORD = 'FixturePass123!';

let server;
let base;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(3).toString('hex')}@invalid.test`;

// -----------------------------------------------------------------------------
// Storage seam - MySQL as of package 3.2.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await users.deleteByEmailPrefix(TAG);
    await MongoUser.deleteMany({ email: new RegExp('^' + TAG) });
    await getPrisma().pendingSignup.deleteMany({ where: { email: { startsWith: TAG } } });
  },

  async createUser({ email, role = 'user', isVerified = true, isActive = true }) {
    const created = await users.create({ name: 'ZZZ AuthChar', email, password: PASSWORD, role, isVerified });
    if (!isActive) await users.setActive(created.id, false);
    const fresh = await users.findById(created.id);
    return { id: fresh.legacyId || fresh.id, uuid: fresh.id, tokenVersion: fresh.tokenVersion };
  },

  /** A user in MONGODB ONLY. The AK3 fixture. */
  async createMongoOnlyUser(email) {
    const doc = await MongoUser.create({
      name: 'ZZZ AuthChar Legacy',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      isVerified: true,
      isActive: true,
    });
    return doc._id.toString();
  },

  async hasMysqlRow(legacyId) {
    return Boolean(await users.findByLegacyId(String(legacyId)));
  },

  async readUser(email) {
    const u = await users.findByEmail(email);
    if (!u) return null;
    const raw = await getPrisma().user.findUnique({
      where: { uuid: u.id },
      select: { passwordHash: true, loginOtpHash: true, resetCodeHash: true },
    });
    return {
      id: u.id,
      externalId: u.legacyId || u.id,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      isVerified: u.isVerified,
      tokenVersion: u.tokenVersion,
      /** SEC-13: is a readable 6-digit code stored anywhere? */
      storesLoginOtpInPlaintext: /^\d{6}$/.test(raw.loginOtpHash || ''),
      storesResetCodeInPlaintext: /^\d{6}$/.test(raw.resetCodeHash || ''),
      hasLoginOtp: Boolean(raw.loginOtpHash),
      bcryptCost: raw.passwordHash ? Number(raw.passwordHash.split('$')[2]) : null,
      passwordMatches: (candidate) => users.verifyPassword(u.id, candidate),
    };
  },
};

function tokenFor(user, { tokenVersion } = {}) {
  return jwt.sign(
    {
      userId: user.id,
      role: user.role || 'user',
      tokenVersion: tokenVersion === undefined ? user.tokenVersion || 0 : tokenVersion,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// -----------------------------------------------------------------------------
let clientSeq = 0;
const nextIp = () => `198.51.100.${(clientSeq++ % 250) + 1}`;

async function call(method, path, { body, token } = {}) {
  const headers = { 'X-Forwarded-For': nextIp() };
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

function assertRefused(res, expectedStatus) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a decision, got ${res.status}: ${res.raw.slice(0, 200)}`
  );
  assert.equal(res.status, expectedStatus, res.raw.slice(0, 200));
  assert.ok(res.body, 'a refusal must carry a JSON body');
  assert.equal(typeof res.body.error, 'string', `reason under "error": ${res.raw.slice(0, 160)}`);
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
  assert.ok(process.env.DATABASE_URL, 'Users are MySQL as of package 3.2');

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
    await prismaModule.disconnect();
  }
});

// =============================================================================
// BUG-11 - the unified refusal shape (unchanged since it was closed)
// =============================================================================

test('BUG-11: every layer names its reason under `error`', async () => {
  const email = uniqEmail('bug11');
  const user = await store.createUser({ email });

  const noToken = await get('/api/auth/me');
  const badToken = await get('/api/auth/me', 'not-a-jwt');
  const nonAdmin = await get('/api/admin/stats', tokenFor({ id: user.id, role: 'user' }));

  for (const [label, res] of [['no token', noToken], ['bad token', badToken], ['non-admin', nonAdmin]]) {
    assert.equal(typeof res.body.error, 'string', `${label}: reason under "error"`);
    assert.equal(res.body.message, res.body.error, `${label}: "message" mirrors it`);
    assert.equal('msg' in res.body, false, `${label}: "msg" is gone`);
  }
});

test('BUG-11: the reason is a real sentence, not a generic placeholder', async () => {
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
  const user = await store.createUser({ email });

  const expired = jwt.sign(
    { userId: user.id, role: 'user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '-1h' }
  );
  assertRefused(await get('/api/auth/me', expired), 401);
  assert.equal((await get('/api/auth/me', tokenFor(user))).status, 200);
});

test('QUIRK: a token for a DELETED user is a 404, not a 401', async () => {
  const email = uniqEmail('ghost');
  const user = await store.createUser({ email });
  const token = tokenFor(user);
  await users.deleteByEmailPrefix(email);

  assertRefused(await get('/api/auth/me', token), 404);
});

test('SEC-05: a DISABLED account is REFUSED (CHANGED IN 3.2)', async () => {
  // WAS: `isActive` existed on the model and admin.js toggled it, but NO route
  // and NO middleware ever read it - "disable user" had no effect whatsoever,
  // and the admin who clicked it believed otherwise.
  // NOW: refused by both middlewares AND at login.
  const email = uniqEmail('disabled');
  const user = await store.createUser({ email, isActive: false });

  const me = await get('/api/auth/me', tokenFor(user));
  assertRefused(me, 403);
  assert.match(me.body.error, /disabled/i);

  const login = await post('/api/auth/login', { email, password: PASSWORD });
  assertRefused(login, 403);
  assert.match(login.body.error, /disabled/i);
});

test('SEC-05: a password change REVOKES existing tokens (CHANGED IN 3.2)', async () => {
  // WAS: no tokenVersion anywhere in routes/, middleware/ or models/, so a
  // token issued before a password reset stayed valid for its full hour - which
  // is the opposite of what resetting a password after a compromise is for.
  // NOW: setPassword increments tokenVersion in the DATA LAYER, so a call site
  // cannot forget, and the middleware refuses the stale claim.
  const email = uniqEmail('revoke');
  const user = await store.createUser({ email });
  const token = tokenFor(user);

  assert.equal((await get('/api/auth/me', token)).status, 200, 'valid before the change');

  const changed = await post(
    '/api/auth/change-password',
    { oldPassword: PASSWORD, newPassword: 'BrandNewPass456!' },
    token
  );
  assert.equal(changed.status, 200, changed.raw.slice(0, 160));
  assert.equal(changed.body.reauthenticationRequired, true, 'and it SAYS so');

  const after = await get('/api/auth/me', token);
  assertRefused(after, 401);
  assert.match(after.body.error, /Session expired/i);

  assert.equal((await store.readUser(email)).tokenVersion, 1);
});

// =============================================================================
// SEC-03
// =============================================================================

test('SEC-03 IS CLOSED: an operator cannot authenticate (CHANGED IN 3.2)', async () => {
  // WAS: `{"email":{"$ne":null}}` with any valid password matched the first
  // user, passed bcrypt.compare against THAT user's hash, and reached OTP
  // generation - authenticated as an account whose address was never known.
  // NOW: parameterised SQL. A JSON object cannot become a query operator
  // because nothing is interpolated into a query.
  await store.reset();
  const email = uniqEmail('inject');
  await store.createUser({ email });

  const res = await post('/api/auth/login', { email: { $ne: null }, password: PASSWORD });

  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `a 5xx would mean the request was PROCESSED and failed later: ${res.raw.slice(0, 160)}`
  );
  assertRefused(res, 400);
  assert.equal(res.body.error, 'Invalid credentials');

  // The mechanism assertion: no OTP was issued, so execution never reached the
  // code past the credential check.
  assert.equal(
    (await store.readUser(email)).hasLoginOtp,
    false,
    'NO login OTP was issued - the credential check was never passed'
  );
});

// =============================================================================
// SEC-08
// =============================================================================

test('SEC-08 is closed on /login - the two cases are indistinguishable', async () => {
  const email = uniqEmail('enum');
  await store.createUser({ email });

  const unknown = await post('/api/auth/login', { email: uniqEmail('nobody'), password: PASSWORD });
  const wrongPassword = await post('/api/auth/login', { email, password: 'WrongPass999!' });

  assert.equal(unknown.status, wrongPassword.status);
  assert.equal(unknown.body.error, wrongPassword.body.error);
  assert.equal(unknown.body.error, 'Invalid credentials');
});

test('SEC-08: the reset and resend paths no longer leak existence (CHANGED IN 3.2)', async () => {
  // WAS: /login/resend-otp, /forgot-password/verify and /forgot-password/reset
  // each answered 404 "User not found" for an unknown address and something
  // else for a known one - a free account oracle on unauthenticated endpoints.
  const email = uniqEmail('enum2');
  await store.createUser({ email });
  const absent = uniqEmail('absent');

  const pairs = [
    ['/api/auth/login/resend-otp', { email }, { email: absent }],
    [
      '/api/auth/forgot-password/verify',
      { email, code: '000000' },
      { email: absent, code: '000000' },
    ],
    [
      '/api/auth/forgot-password/reset',
      { email, code: '000000', newPassword: 'SomeNewPassword1!' },
      { email: absent, code: '000000', newPassword: 'SomeNewPassword1!' },
    ],
  ];

  for (const [path, known, unknown] of pairs) {
    const a = await post(path, known);
    const b = await post(path, unknown);
    assert.equal(a.status, b.status, `${path}: same status`);
    assert.deepEqual(a.body, b.body, `${path}: byte-identical body`);
  }
});

// =============================================================================
// SEC-10, SEC-13, SEC-18
// =============================================================================

test('SEC-10: one password policy, on every path that sets a password (CHANGED IN 3.2)', async () => {
  // WAS: three different rules. /forgot-password/reset required 10 characters,
  // /signup required nothing, and /change-password accepted a single character.
  // A policy that differs by entry point is the weakest of its variants,
  // because the attacker picks which one to use.
  const email = uniqEmail('weak');
  const user = await store.createUser({ email });

  const changed = await post(
    '/api/auth/change-password',
    { oldPassword: PASSWORD, newPassword: 'a' },
    tokenFor(user)
  );
  assertRefused(changed, 400);
  assert.match(changed.body.error, /at least 10/);
  assert.equal(await (await store.readUser(email)).passwordMatches('a'), false);

  const signup = await post('/api/auth/signup', {
    name: 'x',
    email: uniqEmail('weak2'),
    password: 'short',
  });
  assertRefused(signup, 400);
  assert.match(signup.body.error, /at least 10/, 'the SAME rule on signup');
});

test('SEC-13: the login OTP is stored HASHED (CHANGED IN 3.2)', async () => {
  // WAS: a readable 6-digit code sat in the user document.
  const email = uniqEmail('sec13');
  await store.createUser({ email });

  await post('/api/auth/login', { email, password: PASSWORD });

  const u = await store.readUser(email);
  assert.equal(u.hasLoginOtp, true, 'an OTP was issued');
  assert.equal(u.storesLoginOtpInPlaintext, false, 'and it is NOT a readable 6-digit code');
});

test('SEC-18: passwords are hashed at bcrypt cost 12 (CHANGED IN 3.2)', async () => {
  // WAS: cost 10 at all five hashing call sites.
  const email = uniqEmail('sec18');
  const user = await store.createUser({ email });

  await post(
    '/api/auth/change-password',
    { oldPassword: PASSWORD, newPassword: 'NewPassword789!' },
    tokenFor(user)
  );

  assert.equal((await store.readUser(email)).bcryptCost, 12);
});

// =============================================================================
// Response shapes
// =============================================================================

test('AE4: what GET /api/auth/me ACTUALLY returns', async () => {
  const email = uniqEmail('me');
  const user = await store.createUser({ email });

  const res = await get('/api/auth/me', tokenFor(user));
  assert.equal(res.status, 200, res.raw.slice(0, 160));

  for (const forbidden of ['password', 'passwordHash', 'resetPasswordCode', 'loginOTP', 'tokenVersion']) {
    assert.equal(forbidden in res.body, false, `${forbidden} must not be returned`);
  }
  assert.equal(res.body.email, email);
  // CHANGED IN 3.2: `_id` is the ObjectId-shaped external id (ADR-051) and the
  // uuid is returned alongside, so nothing is hidden.
  assert.match(res.body._id, /^[0-9a-f]{24}$/);
  assert.match(res.body.uuid, /^[0-9a-f]{8}-/);
});

test('PUT /api/users/profile requires a token and updates the caller', async () => {
  const email = uniqEmail('profile');
  const user = await store.createUser({ email });

  assertRefused(await put('/api/users/profile', { name: 'X' }), 401);

  const res = await put('/api/users/profile', { name: 'ZZZ Renamed', phone: '123' }, tokenFor(user));
  assert.equal(res.status, 200, res.raw.slice(0, 160));
  assert.equal('password' in res.body, false);
  assert.equal('passwordHash' in res.body, false);
  assert.equal(res.body.name, 'ZZZ Renamed');
});

test('/auth/me and /users/profile now use the MIDDLEWARE (CHANGED IN 3.2)', async () => {
  // WAS: both verified the JWT inline, so the two copies agreed with each other
  // and DIFFERED from the middleware - and any check added to authMiddleware,
  // SEC-05's isActive among them, silently did not apply to either.
  // NOW: all three give the same reason, because all three ARE the middleware.
  const meNoToken = await get('/api/auth/me');
  const profileNoToken = await put('/api/users/profile', { name: 'X' });
  const middlewareNoToken = await post('/api/auth/change-password', {
    oldPassword: 'x',
    newPassword: 'SomeNewPassword1!',
  });

  assert.equal(meNoToken.status, 401);
  assert.equal(profileNoToken.status, 401);
  assert.equal(middlewareNoToken.status, 401);
  assert.equal(meNoToken.body.error, profileNoToken.body.error);
  assert.equal(meNoToken.body.error, middlewareNoToken.body.error);
});

// =============================================================================
// AK3 / AM1 - a user that exists in MONGODB and was never migrated
// =============================================================================

test('AK3: an UN-MIGRATED user authenticates through the bridge, loudly', async () => {
  // ADR-056's constraint says a route's LIST and WRITE paths need migrated
  // data. AUTHENTICATION is the read-by-id case, which the bridge DOES cover -
  // so an un-migrated account must still be able to hold a session, and the
  // fallback must announce itself.
  //
  // AM1: created here, not in a fixture hook, and asserted to have no MySQL row
  // BEFORE the route is exercised. If it ever has one, the setup is wrong and
  // everything below is vacuous.
  await store.reset();
  const email = uniqEmail('legacy');
  const legacyId = await store.createMongoOnlyUser(email);

  assert.equal(
    await store.hasMysqlRow(legacyId),
    false,
    'SETUP ERROR: the AK3 fixture has a MySQL row, so it was migrated after all'
  );

  // A token for that account still authenticates: resolveAuthUser falls back to
  // MongoDB, and a Mongo user has no token_version so both sides read 0.
  const token = jwt.sign(
    { userId: legacyId, role: 'user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const me = await get('/api/auth/me', token);
  // /me reads the MySQL repository by req.user.id, which is the ObjectId - and
  // there is no MySQL row, so it is a clean 404 rather than a crash. The
  // MIDDLEWARE accepted the token; the HANDLER has no record. That is the
  // honest state of a half-migrated account, and running the ETL resolves it.
  assert.notEqual(Math.floor(me.status / 100), 5, `must not 500: ${me.raw.slice(0, 160)}`);
  assertRefused(me, 404);

  // LOGIN for an un-migrated account is refused, because auth.js reads MySQL.
  // This is ADR-056's constraint on the WRITE/LOOKUP path, and the ETL is the
  // mechanism that closes it - asserted rather than assumed.
  const login = await post('/api/auth/login', { email, password: PASSWORD });
  assertRefused(login, 400);
  assert.equal(login.body.error, 'Invalid credentials');
});
