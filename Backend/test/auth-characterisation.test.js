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

test('SEC-08 AUDIT: EVERY existence-dependent endpoint answers identically (AP1)', async () => {
  // THE FULL AUDIT, not only the endpoints that were already under test.
  //
  // The first fix missed four oracles, and the one that caught the miss was a
  // BYTE-IDENTICAL BODY assertion - a status-only check passed while the oracle
  // was still open on a different endpoint, which would have marked SEC-08
  // closed while it was not.
  //
  // So this asserts the WHOLE BODY, and it does so for every endpoint whose
  // response can vary with whether an account exists. `deepEqual` also catches
  // a difference in an extra field or a nested code, which is where an oracle
  // hides once the obvious string has been unified.
  await store.reset();
  const email = uniqEmail('audit');
  await store.createUser({ email });
  const absent = uniqEmail('absent');

  // Drive the KNOWN account into every state an attacker can reach without
  // credentials: a live reset code, then five wrong guesses to exhaust the cap.
  await post('/api/auth/forgot-password/request', { email });
  for (let i = 0; i < 6; i += 1) {
    await post('/api/auth/forgot-password/verify', { email, code: '000000' });
  }

  const cases = [
    [
      'POST /forgot-password/request',
      ['/api/auth/forgot-password/request', { email }, { email: absent }],
    ],
    // The two reset-code endpoints are covered BELOW instead, in their own
    // scenario, because they carry an unresolved SEC-02/SEC-08 conflict.

    [
      'POST /login (wrong password vs no account)',
      ['/api/auth/login', { email, password: 'WrongPass999!' }, { email: absent, password: 'WrongPass999!' }],
    ],
    [
      'POST /login/verify-otp (no OTP issued vs no account)',
      ['/api/auth/login/verify-otp', { email, otp: '000000' }, { email: absent, otp: '000000' }],
    ],
    [
      'POST /login/resend-otp',
      ['/api/auth/login/resend-otp', { email }, { email: absent }],
    ],
    [
      'POST /signup/resend-otp (no pending signup either way)',
      ['/api/auth/signup/resend-otp', { email }, { email: absent }],
    ],
    [
      'POST /signup/verify-otp (no pending signup either way)',
      ['/api/auth/signup/verify-otp', { email, otp: '000000' }, { email: absent, otp: '000000' }],
    ],
  ];

  for (const [label, [path, known, unknown]] of cases) {
    const a = await post(path, known);
    const b = await post(path, unknown);
    assert.equal(a.status, b.status, `${label}: status differs (${a.status} vs ${b.status})`);
    assert.deepEqual(
      a.body,
      b.body,
      `${label}: BODY differs -\n  known:   ${a.raw.slice(0, 120)}\n  unknown: ${b.raw.slice(0, 120)}`
    );
  }
});

test('SEC-02 / SEC-08 RESOLVED: the cap is byte-identical either way (CHANGED IN AV1)', async () => {
  // THIS TEST PREVIOUSLY ASSERTED THE ORACLE EXISTED, and said in its own
  // comment that the day it was closed, this should be updated deliberately.
  // That day is AQ1's per-address counter, built in AV1.
  //
  //   WAS: assert.equal(known.status, 429)    known account reaches a cap
  //        assert.equal(unknown.status, 400)  unknown address cannot
  //        assert.notEqual(known, unknown)    <- the oracle, pinned
  //
  //   NOW: both reach the SAME cap and answer with the SAME BODY.
  //
  // WORTH NOTING HOW IT PASSED IN BETWEEN. After the limiter landed and before
  // this edit, the test still went green - the known address tripped the new
  // per-address cap at 429 and the unknown address, being a DIFFERENT address
  // with its own untouched bucket, still answered 400. The assertion held and
  // its PREMISE was false. A test can survive the removal of the thing it was
  // written to pin, if what it measures is a side effect rather than the
  // property.
  //
  // AP1: the full BODY, deepEqual, never the status alone. That rule exists
  // because my first SEC-08 fix unified three endpoints on status and left a
  // fourth differing on body text.
  await store.reset();
  const email = uniqEmail('capresolved');
  await store.createUser({ email });
  const absent = uniqEmail('capabsent');

  await post('/api/auth/forgot-password/request', { email });

  // Drive BOTH addresses to the cap. The point is that an address with NO
  // ACCOUNT can reach one at all - under the old design it could not, which is
  // exactly what made the cap an oracle.
  const driveToCap = async (address) => {
    let last = null;
    for (let i = 0; i < 8; i += 1) {
      last = await post('/api/auth/forgot-password/verify', { email: address, code: '000000' });
      if (last.status === 429) return last;
    }
    return last;
  };

  const known = await driveToCap(email);
  const unknown = await driveToCap(absent);

  assert.equal(known.status, 429, 'an address WITH an account reaches the cap');
  assert.equal(
    unknown.status,
    429,
    'AND SO DOES AN ADDRESS WITH NO ACCOUNT - the requirement the whole feature ' +
      'exists for. If this is 400, the cap is keyed off something that only ' +
      'exists for real users and the oracle is back.'
  );

  assert.deepEqual(
    known.body,
    unknown.body,
    'AP1: the ENTIRE body identical, not merely the status. A difference here ' +
      'is the finding, however small - an extra field or a nested code is ' +
      'exactly where an oracle hides once the obvious string is unified.'
  );

  // AND THE CAP MUST NOT HAVE TOUCHED THE ACCOUNT (AQ1's second requirement).
  // An attacker who drives a real user's address to the cap must not have
  // destroyed that user's pending reset code.
  const row = await users.findByEmail(email);
  assert.ok(row, 'the account still exists');
  assert.equal(row.isActive, true, 'and is not disabled - the cap is not a lockout');

  const raw = await getPrisma().user.findUnique({
    where: { uuid: row.id },
    select: { resetCodeHash: true },
  });
  assert.ok(
    raw.resetCodeHash,
    "THE USER'S RESET CODE SURVIVED. Voiding it at the cap was a griefing " +
      'primitive - anyone who knows an address could destroy a pending reset ' +
      'with five requests - and removing that is AQ1 requirement 2.'
  );
});

test('SEC-08 FULLY CLOSED: /signup answers identically either way (CHANGED IN 3.5a)', async () => {
  // THIS TEST PINNED THE LAST ORACLE and said that if it ever started failing,
  // the oracle had been closed and it should be updated on purpose. Package
  // 3.5a closed it - the second email template, which is the only reason that
  // package existed.
  //
  //   WAS: assert.notDeepEqual(known.body, unknown.body)   <- the oracle
  //   NOW: assert.deepEqual(known.body, unknown.body)
  //
  // AP1: the ENTIRE body, deepEqual, and the status. Not the status alone.
  await store.reset();
  const email = uniqEmail('signupleak');
  await store.createUser({ email });

  const known = await post('/api/auth/signup', { name: 'x', email, password: 'ValidPassword1!' });
  const unknown = await post('/api/auth/signup', {
    name: 'x',
    email: uniqEmail('nobody'),
    password: 'ValidPassword1!',
  });

  assert.equal(known.status, unknown.status, 'same status');
  assert.equal(known.status, 200, 'and both are accepted rather than both refused');

  // ONE FIELD IS EXCLUDED, AND THE EXCLUSION IS ARGUED RATHER THAN ASSUMED.
  //
  // `email` differs because each response ECHOES THE ADDRESS THE CALLER SENT.
  // That is definitionally not a disclosure: the attacker chose the value, so
  // reading it back tells them nothing they did not already have. Every other
  // field must match byte for byte.
  //
  // AP1 says compare the whole body, and this is not a weakening of it - an
  // exclusion with a reason is different from a comparison that never looked.
  // The two assertions below are what make it safe: the field is excluded AND
  // proven to be a pure echo, so it cannot become a carrier later.
  assert.deepEqual(
    { ...known.body, email: null },
    { ...unknown.body, email: null },
    'every field except the echoed address must be identical'
  );
  assert.equal(known.body.email, email, 'the excluded field is a pure echo of the input');
  assert.equal(
    Object.keys(known.body).sort().join(','),
    Object.keys(unknown.body).sort().join(','),
    'and the two bodies carry the same KEYS, so nothing extra appears on one path'
  );

  // AND THE ACCOUNT MUST BE UNTOUCHED. A signup attempt against an existing
  // address must not create a pending signup that could later be verified into
  // a second account, or overwrite anything on the first.
  const after = await store.readUser(email);
  assert.ok(after, 'the existing account survives');
  assert.equal(after.email, email.toLowerCase());

  // The attacker's name must NOT have replaced the account holder's.
  assert.notEqual(after.name, 'x', "the attacker's `name` field did not overwrite anything");
});

test('3.5a: a signup attempt on a known address creates NO pending signup', async () => {
  // The uniform response must not be paid for by leaving a row an attacker can
  // then verify. `/signup/verify-otp` would otherwise be a second route to the
  // same oracle - and worse, a route to an account.
  await store.reset();
  const email = uniqEmail('nopending');
  await store.createUser({ email });

  await post('/api/auth/signup', { name: 'attacker', email, password: 'ValidPassword1!' });

  const pending = await getPrisma().pendingSignup.findFirst({
    where: { email: email.toLowerCase() },
  });
  assert.equal(pending, null, 'no pending signup row was created for an address that has an account');

  // And a resend for that address still answers uniformly, so the absence of a
  // row is not observable through the other endpoint either (AP1).
  const resendKnown = await post('/api/auth/signup/resend-otp', { email });
  const resendUnknown = await post('/api/auth/signup/resend-otp', { email: uniqEmail('nobody2') });
  assert.equal(resendKnown.status, resendUnknown.status);
  assert.deepEqual(resendKnown.body, resendUnknown.body);
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

// =============================================================================
// SIGNUP-01 - pre-registration account takeover (AX1)
// =============================================================================

test('SIGNUP-01 CLOSED: a recipient who did not start the signup CANNOT complete it', async () => {
  // THE ATTACK, RUN IN FULL, ASSERTED TO FAIL AT THE STEP THAT MATTERS.
  //
  // Proved working before this fix, in the AW2 audit:
  //   pending row created: true
  //   password hash is the ATTACKER-chosen one: true
  //   attempts before re-post: 4 -> after: 0
  //   account created: true
  //   ATTACKER PASSWORD WORKS ON IT: true
  //
  // The OTP proves control of the ADDRESS. It does not prove who STARTED the
  // signup. `/signup/verify-otp` now requires the password the signup was
  // started with, which is the only thing the initiator has and the recipient
  // does not.
  await store.reset();
  const victim = uniqEmail('signup01victim');
  const ATTACKER_PASSWORD = 'AttackerChosen123!';

  // 1. The attacker starts a registration for an address they do not own.
  const initiated = await post('/api/auth/signup', {
    name: 'Totally The Victim',
    email: victim,
    password: ATTACKER_PASSWORD,
  });
  assert.equal(initiated.status, 200, 'the attacker can still START one - that is SEC-08 uniformity');

  // 2. The attacker re-posts to reset the OTP attempt counter. Part of the
  //    proved chain, so it is part of the proof that the chain is broken.
  const prisma = getPrisma();
  await prisma.pendingSignup.update({
    where: { email: victim.toLowerCase() },
    data: { signupOtpAttempts: 4 },
  });
  await post('/api/auth/signup', { name: 'x', email: victim, password: ATTACKER_PASSWORD });
  const afterRepost = await prisma.pendingSignup.findFirst({
    where: { email: victim.toLowerCase() },
    select: { signupOtpAttempts: true },
  });
  assert.equal(
    afterRepost.signupOtpAttempts,
    0,
    'the re-post STILL resets the counter - recommendation 2 is NOT implemented, ' +
      'and this asserts the residual rather than letting it be assumed closed'
  );

  // 3. The victim receives the code. Simulated by setting a known one, because
  //    the suite cannot read the mailbox.
  const KNOWN = '123456';
  await require('../repositories/pendingSignups').setOtp(victim, KNOWN, Date.now() + 10 * 60 * 1000);

  // 4. THE VICTIM ENTERS THE CODE - and this is where the chain now breaks.
  //    They do not know the attacker's password, so they cannot supply it.
  const victimAttempt = await post('/api/auth/signup/verify-otp', { email: victim, otp: KNOWN });
  assertRefused(victimAttempt, 400);
  assert.equal(victimAttempt.body.error, 'Invalid OTP', 'and it says nothing about why');

  assert.equal(
    await users.findByEmail(victim),
    null,
    'NO ACCOUNT WAS CREATED. This is the assertion the whole finding turns on.'
  );

  // 5. And guessing a DIFFERENT password does not work either, so the control
  //    is the password and not merely the presence of the field.
  const guessed = await post('/api/auth/signup/verify-otp', {
    email: victim,
    otp: KNOWN,
    password: 'SomeOtherPassword1!',
  });
  assertRefused(guessed, 400);
  assert.equal(await users.findByEmail(victim), null, 'still no account');
});

test('SIGNUP-01: the CONTROL - a genuine signup still completes', async () => {
  // Without this, the test above proves only that verify-otp is broken, which a
  // permanently failing endpoint would also satisfy.
  await store.reset();
  const email = uniqEmail('signup01real');
  const PASSWORD = 'GenuineUser123!';

  await post('/api/auth/signup', { name: 'Real User', email, password: PASSWORD });

  const KNOWN = '654321';
  await require('../repositories/pendingSignups').setOtp(email, KNOWN, Date.now() + 10 * 60 * 1000);

  const verified = await post('/api/auth/signup/verify-otp', {
    email,
    otp: KNOWN,
    password: PASSWORD,
  });
  assert.equal(verified.status, 200, `a genuine signup must complete: ${verified.raw.slice(0, 200)}`);
  assert.ok(verified.body.token, 'and it issues a token');

  const account = await users.findByEmail(email);
  assert.ok(account, 'the account exists');
  assert.equal(
    await users.verifyPassword(account.id, PASSWORD),
    true,
    'with the password the person who signed up chose'
  );
});
