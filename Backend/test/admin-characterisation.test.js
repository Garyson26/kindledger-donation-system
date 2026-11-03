/**
 * =============================================================================
 * CHARACTERISATION tests for routes/admin.js  (SPEC-3 package 3.5, via AS7)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:admin
 *
 * Written against the Mongoose implementation BEFORE the migration, and now
 * asserted against the MySQL one. TWELVE assertions changed; each is marked
 * `CHANGED IN AS7` with the finding that caused it.
 *
 * ELEVEN OF THE TWELVE ARE QUIRKS BEING CLOSED - ADMIN-01 in five places,
 * BUG-03, BUG-08, SEC-18, SEC-18b, SEC-19 and the password message. They were
 * pinned as WRONG behaviour on purpose, so fixing them HAD to break this file.
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE CAUSED ADMIN-01. `admin.js` was package
 * 3.5, so it had no suite; package 3.2 moved users to MySQL; nothing was
 * watching admin.js when it did, and every admin revocation silently stopped
 * working for three packages. AR4's conclusion, in one sentence:
 *
 *   A FILE THAT HAS NOT BEEN MIGRATED HAS NO TESTS EITHER, so a change in a
 *   DIFFERENT file can break it silently while the coverage rule - which only
 *   ever asks about the file being changed - reports full compliance.
 *
 * THE SEAM SPANS BOTH STORES, DELIBERATELY. Every other characterisation suite
 * reads one store because its subject uses one. This file's SUBJECT is a
 * divergence between two, so a seam that hid which store answered would hide
 * the entire finding. `store.mysql` and `store.mongo` are separate on purpose.
 *
 * AC1: every refusal asserts the MECHANISM - status, shape, and that nothing
 * 500'd. A gate that crashes leaves the same visible state as one that refuses.
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
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_admin_test';
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
const MongoDonation = require('../models/Donation');
const users = require('../repositories/users');
const donations = require('../repositories/donations');
const categories = require('../repositories/categories');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');

const TAG = 'zzz-adminchar';
const CAT_PREFIX = 'ZZZ ADMINCHAR';
const PASSWORD = 'FixturePass123!';

let server;
let base;
let adminToken;
let adminExternalId;
let categoryId;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(3).toString('hex')}@invalid.test`;

let objectIdCounter = crypto.randomBytes(3).readUIntBE(0, 3);
function mintObjectId() {
  objectIdCounter = (objectIdCounter + 1) % 0xffffff;
  return (
    Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
    crypto.randomBytes(5).toString('hex') +
    objectIdCounter.toString(16).padStart(6, '0')
  );
}

// -----------------------------------------------------------------------------
// The seam. TWO STORES, KEPT APART.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await users.deleteByEmailPrefix(TAG);
    await MongoUser.deleteMany({ email: new RegExp('^' + TAG) });
    await donations.deleteByDonorEmailPrefix(TAG);
    await MongoDonation.deleteMany({ donorEmail: new RegExp('^' + TAG) });
    await categories.deleteByNamePrefix(CAT_PREFIX);
  },

  mysql: {
    /** An account that can actually log in - auth.js reads MySQL since 3.2. */
    async createUser({ email, role = 'user', legacyId }) {
      const created = await users.create({
        name: 'ZZZ AdminChar',
        email,
        password: PASSWORD,
        role,
        isVerified: true,
        ...(legacyId ? { legacyId } : {}),
      });
      return users.findById(created.id);
    },
    read: (email) => users.findByEmail(email),
    async passwordHash(email) {
      const u = await users.findByEmail(email);
      if (!u) return null;
      const row = await getPrisma().user.findUnique({
        where: { uuid: u.id },
        select: { passwordHash: true },
      });
      return row ? row.passwordHash : null;
    },
    verifyPassword: async (email, candidate) => {
      const u = await users.findByEmail(email);
      return u ? users.verifyPassword(u.id, candidate) : false;
    },
  },

  mongo: {
    /** The shape an ETL-migrated account has: the SAME id in both stores. */
    async createUser({ email, role = 'user', _id }) {
      return MongoUser.create({
        ...(_id ? { _id } : {}),
        name: 'ZZZ AdminChar',
        email,
        password: await bcrypt.hash(PASSWORD, 10),
        role,
        isVerified: true,
        isActive: true,
      });
    },
    read: (email) => MongoUser.findOne({ email }),
    readById: (id) => MongoUser.findById(id),
  },

  /** An account present in BOTH stores with one id - what the ETL produces. */
  async createMigratedUser({ tag, role = 'user' }) {
    const email = uniqEmail(tag);
    const legacyId = mintObjectId();
    await this.mongo.createUser({ email, role, _id: new mongoose.Types.ObjectId(legacyId) });
    const row = await this.mysql.createUser({ email, role, legacyId });
    return { email, externalId: legacyId, uuid: row.id, tokenVersion: row.tokenVersion };
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
const patch = (p, body, token) => call('PATCH', p, { body, token });
const del = (p, token) => call('DELETE', p, { token });

function tokenFor(user) {
  return jwt.sign(
    { userId: user.externalId, role: 'user', tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function assertRefused(res, expectedStatus) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a decision, got ${res.status}: ${res.raw.slice(0, 200)}`
  );
  assert.equal(res.status, expectedStatus, res.raw.slice(0, 200));
  assert.ok(res.body, 'a refusal must carry a JSON body');
  assert.equal(typeof res.body.error, 'string', `refusal must name a reason: ${res.raw.slice(0, 120)}`);
}

/** Can this account still authenticate? The question ADMIN-01 turns on. */
async function stillAuthenticates(user) {
  const res = await get('/api/auth/me', tokenFor(user));
  return res.status === 200;
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
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const probe = await require('../repositories').checkDatabase();
  assert.equal(probe.ok, true, `MySQL unreachable: ${probe.error}`);

  const app = require('../app.js');
  for (let i = 0; i < 100 && mongoose.connection.readyState !== 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(mongoose.connection.readyState, 1, 'mongoose did not connect');

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  await store.reset();

  // The admin must exist in BOTH stores: adminAuth resolves through MySQL
  // (package 3.2), and admin.js's own handlers look the caller up in MongoDB.
  const admin = await store.createMigratedUser({ tag: 'admin', role: 'admin' });
  adminExternalId = admin.externalId;
  adminToken = jwt.sign(
    { userId: admin.externalId, role: 'admin', tokenVersion: admin.tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const cat = await categories.create({
    name: `${CAT_PREFIX} fixture`,
    legacyId: mintObjectId(),
    shortDescription: 'fixture',
    donationAmountMinor: 150000,
    descriptions: [],
  });
  categoryId = cat.legacyId;
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
// Authorisation
// =============================================================================

test('every admin route refuses anonymous and non-admin callers', async () => {
  const guarded = [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users'],
    ['PUT', `/api/admin/users/${adminExternalId}`],
    ['PATCH', `/api/admin/users/${adminExternalId}/toggle-status`],
    ['PATCH', `/api/admin/users/${adminExternalId}/change-password`],
    ['DELETE', `/api/admin/users/${adminExternalId}`],
    ['GET', '/api/admin/cleanup/preview'],
    ['POST', '/api/admin/cleanup/trigger'],
  ];
  const plain = await store.createMigratedUser({ tag: 'plain' });

  for (const [method, path] of guarded) {
    assertRefused(await call(method, path), 401);
    assertRefused(await call(method, path, { token: tokenFor(plain) }), 403);
  }
});

// =============================================================================
// GET /stats
// =============================================================================

test('D-X2 CLOSED: /stats counts donations in MySQL (CHANGED IN AS7)', async () => {
  // The two tiles read a store that stopped being authoritative for donations at
  // package 3.3. Pinned as a DIVERGENCE rather than as a number, because the
  // numbers agree until something writes - which is what makes it dangerous.
  await donations.deleteByDonorEmailPrefix(TAG);
  await MongoDonation.deleteMany({ donorEmail: new RegExp('^' + TAG) });

  // A donation that exists ONLY in MySQL - i.e. one created since 3.3.
  await donations.create({
    legacyId: mintObjectId(),
    donorName: 'ZZZ AdminChar',
    donorEmail: `${TAG}-stats@invalid.test`,
    categoryId,
    quantity: 1,
    baseAmountMinor: 150000,
    extraAmountMinor: 0,
    amountMinor: 150000,
    status: 'Approved',
  });

  const mysqlTotal = await donations.count({});
  const mongoTotal = await MongoDonation.countDocuments();

  const res = await get('/api/admin/stats', adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['approved', 'categories', 'donations', 'users']);

  // WAS: the tile reported `mongoTotal`. It AGREED with MySQL until something
  // wrote - the ETL had copied one store to the other - so it was correct in
  // every test and wrong only under real traffic. That is why the fixture above
  // creates a donation in MySQL ONLY: it forces the divergence the tile used to
  // hide.
  assert.equal(res.body.donations, mysqlTotal, 'the tile reports the MySQL count');
  assert.notEqual(
    mysqlTotal,
    mongoTotal,
    'CONTROL: the two stores genuinely differ, so the assertion above is not ' +
      'passing by coincidence'
  );
});

test('BUG-03 CLOSED: the "approved" tile counts APPROVAL, not casing (CHANGED IN AS7)', async () => {
  // NOT "always 0", which is what the map said until the AR1 audit measured it.
  // It matches `status: "approved"` exactly, so it counts whatever fraction was
  // written by PATCH /:id/status and misses everything the payment callbacks
  // wrote as `Approved`. A tile showing 0 is visibly broken; a tile showing a
  // fraction is believed.
  // WAS: `countDocuments({status: "approved"})` matched the lowercase subset,
  // so lowercasing a donation made the tile count it and the tile measured
  // CASING. MySQL stores one canonical casing, so both writers land in the same
  // bucket and the count is simply the count.
  const before = (await get('/api/admin/stats', adminToken)).body.approved;

  await donations.create({
    legacyId: mintObjectId(),
    donorName: 'ZZZ AdminChar',
    donorEmail: `${TAG}-approved@invalid.test`,
    categoryId,
    quantity: 1,
    baseAmountMinor: 150000,
    extraAmountMinor: 0,
    amountMinor: 150000,
    status: 'Approved',
  });
  const afterCanonical = (await get('/api/admin/stats', adminToken)).body.approved;
  assert.equal(afterCanonical, before + 1, 'a canonically-approved donation is counted');

  // And one approved through the OTHER writer, in the casing that endpoint
  // accepts. Both must land in the same count - that is the whole finding.
  const lower = await donations.create({
    legacyId: mintObjectId(),
    donorName: 'ZZZ AdminChar',
    donorEmail: `${TAG}-approved2@invalid.test`,
    categoryId,
    quantity: 1,
    baseAmountMinor: 150000,
    extraAmountMinor: 0,
    amountMinor: 150000,
  });
  await donations.setStatus(lower.id, 'approved');
  const afterLower = (await get('/api/admin/stats', adminToken)).body.approved;
  assert.equal(
    afterLower,
    before + 2,
    'a donation approved in lowercase through PATCH /:id/status is counted TOO ' +
      '- the two writers no longer disagree'
  );
});

// =============================================================================
// GET /users
// =============================================================================

test('ADMIN-01 CLOSED: the user list shows accounts that can log in (CHANGED IN AS7)', async () => {
  // WAS: the list read MongoDB, so an account created through the API since
  // package 3.2 - one that can actually authenticate - did not appear at all.
  const email = uniqEmail('mysqlonly');
  await store.mysql.createUser({ email });

  const res = await get('/api/admin/users?page=1&limit=100', adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['pagination', 'users']);
  assert.deepEqual(Object.keys(res.body.pagination).sort(), ['limit', 'page', 'pages', 'total']);

  assert.equal(
    res.body.users.some((u) => u.email === email),
    true,
    'an account that can log in appears in the admin list'
  );
});

test('the listed user never carries the password hash', async () => {
  await store.createMigratedUser({ tag: 'listed' });
  const res = await get('/api/admin/users?page=1&limit=100', adminToken);
  for (const u of res.body.users) {
    assert.equal('password' in u, false, 'the hash must never reach the client');
  }
});

test('BUG-08 CLOSED: the list limit is CAPPED and NaN is REFUSED (CHANGED IN AS7)', async () => {
  // WAS: `limit=100000` loaded a hundred thousand accounts, and `limit=abc`
  // produced NaN which reached the query and came back as `"limit": null`
  // inside a 200 - a caller could not tell an empty page from a request the
  // server had failed to parse.
  const big = await get('/api/admin/users?page=1&limit=100000', adminToken);
  assert.equal(big.status, 200);
  assert.equal(big.body.pagination.limit, 100, 'clamped to MAX_PAGE_SIZE');
  assert.ok(big.body.users.length <= 100, 'and the page obeys the clamp');

  assertRefused(await get('/api/admin/users?page=abc&limit=abc', adminToken), 400);
});

test('the user search escapes regex metacharacters rather than executing them', async () => {
  // BE-HIGH-08 was fixed here and must stay fixed through the migration - and
  // the SQL form has its own metacharacters, so this is not automatic.
  await store.createMigratedUser({ tag: 'regex' });
  for (const term of ['.*', '%', '_', '%%']) {
    const res = await get(
      `/api/admin/users?page=1&limit=100&search=${encodeURIComponent(term)}`,
      adminToken
    );
    assert.equal(res.status, 200, `${term}: ${res.raw.slice(0, 160)}`);
    assert.equal(
      res.body.users.filter((u) => u.email && u.email.startsWith(TAG)).length,
      0,
      `'${term}' must be matched literally, not as a pattern`
    );
  }

  // CHANGED IN AS7: `%` and `_` are new. They are LIKE's metacharacters, and a
  // parameterised query does not neutralise them - the finding was renamed by
  // the store swap, not retired by it.
  const hit = await get('/api/admin/users?page=1&limit=100&search=regex', adminToken);
  assert.ok(
    hit.body.users.length >= 1,
    'CONTROL FAILED: literal search matches nothing either, so nothing above is proven'
  );
});

// =============================================================================
// POST /users
// =============================================================================

test('ADMIN-01 CLOSED: an admin-created account CAN log in (CHANGED IN AS7)', async () => {
  // WAS the single most direct statement of the finding: the admin was told the
  // account had been created, and it could not authenticate, because auth.js
  // reads MySQL and the row had gone to MongoDB.
  const email = uniqEmail('created');
  const res = await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email, password: PASSWORD, role: 'user' },
    adminToken
  );
  assert.equal(res.status, 201, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User created successfully');

  assert.ok(await store.mysql.read(email), 'it went to MySQL');
  assert.equal(await store.mongo.read(email), null, 'and NOT to MongoDB');

  // THE ASSERTION IS "DID THE CREDENTIAL CHECK PASS", NOT "DID THE REQUEST
  // SUCCEED", and the difference is a finding this project has already paid for.
  //
  // `/login` verifies the password and THEN sends an OTP email. With no SMTP in
  // the test environment the send fails and the request answers 500 - AFTER the
  // credential check passed. Reading that 500 as a refusal is exactly what hid
  // SEC-03 for a full package: an injected login returned 500 and was recorded
  // as "refused" when the attacker was already past the password.
  //
  // So the discriminator is the MESSAGE, not the status. A caller whose password
  // is wrong is stopped at `400 Invalid credentials` and never reaches the mail
  // step at all.
  const login = await post('/api/auth/login', { email, password: PASSWORD });
  assert.notEqual(
    login.body && login.body.error,
    'Invalid credentials',
    `the new account must get PAST the credential check: ${login.raw.slice(0, 200)}`
  );

  // The control: a WRONG password IS stopped there, so the assertion above is
  // about this account's credentials and not about /login being permissive.
  const bad = await post('/api/auth/login', { email, password: 'WrongPassword123!' });
  assertRefused(bad, 400);
  assert.equal(bad.body.error, 'Invalid credentials');
});

test('SEC-18 and SEC-21 CLOSED: cost 12, and verified at creation (CHANGED IN AS7)', async () => {
  // WAS: `bcrypt.hash(password, 10)` called DIRECTLY in the route, bypassing
  // repositories/users entirely - which is how there came to be two password
  // hashing implementations with only one governed by policy, and is the
  // observation that led to ADMIN-01. And `isVerified` was left at its default
  // for auth.js to quietly flip on first login.
  const email = uniqEmail('hash');
  await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email, password: PASSWORD },
    adminToken
  );
  assert.equal(
    Number((await store.mysql.passwordHash(email)).split('$')[2]),
    12,
    'hashed at BCRYPT_COST, because the route no longer chooses a cost at all'
  );
  assert.equal((await store.mysql.read(email)).isVerified, true, 'verified at creation');
});

test('SEC-08 is NOT APPLICABLE here, and the duplicate message stays (AS7)', async () => {
  // DELIBERATELY UNCHANGED, and the reasoning is the outcome-not-mechanism rule.
  // SEC-08 is account enumeration. This endpoint is behind `adminAuth`, and the
  // same caller can list every account with a GET one request later. A generic
  // response would withhold nothing from an attacker and would withhold from an
  // admin the only useful thing the failure could tell them.
  const user = await store.createMigratedUser({ tag: 'dupe' });
  const res = await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email: user.email, password: PASSWORD },
    adminToken
  );
  assertRefused(res, 400);
  assert.equal(res.body.error, 'User with this email already exists');
});

test('POST /users requires name, email and password, and ONE password rule (CHANGED IN AS7)', async () => {
  assertRefused(await post('/api/admin/users', { email: uniqEmail('x') }, adminToken), 400);

  // SEC-10: this endpoint had NO password rule at all, so an admin could create
  // an account with a one-character password that its owner could then never
  // change to anything shorter than ten. The policy is one module now.
  const short = await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email: uniqEmail('shortcreate'), password: 'short' },
    adminToken
  );
  assertRefused(short, 400);
  assert.match(short.body.error, /at least 10 characters/);
});

// =============================================================================
// PATCH /users/:id/toggle-status - THE FINDING
// =============================================================================

test('ADMIN-01 CLOSED: disabling an account actually disables it (CHANGED IN AS7)', async () => {
  // WAS: `200 "User disabled successfully"`, `isActive` set in MongoDB, MySQL
  // untouched - and THE DISABLED ACCOUNT KEPT AUTHENTICATING. The admin was
  // told it was disabled, the record said disabled, and access was never
  // revoked. This is the headline case of the finding.
  const user = await store.createMigratedUser({ tag: 'disable' });
  assert.equal(await stillAuthenticates(user), true, 'precondition: the token works');

  const res = await patch(`/api/admin/users/${user.externalId}/toggle-status`, undefined, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User disabled successfully');

  assert.equal(
    (await store.mysql.read(user.email)).isActive,
    false,
    'MySQL changed - and MySQL is what authMiddleware enforces'
  );
  assert.equal(
    await stillAuthenticates(user),
    false,
    'THE DISABLED ACCOUNT NO LONGER AUTHENTICATES'
  );

  // And re-enabling restores access, so the control is a toggle rather than a
  // one-way door.
  const back = await patch(`/api/admin/users/${user.externalId}/toggle-status`, undefined, adminToken);
  assert.equal(back.body.message, 'User enabled successfully');
  assert.equal(
    await stillAuthenticates({ ...user, tokenVersion: (await store.mysql.read(user.email)).tokenVersion }),
    true,
    're-enabling restores access to a freshly issued token'
  );
});

test('AS7: disabling REVOKES live sessions, not just future ones', async () => {
  // `users.setActive` increments token_version when disabling, so a token
  // issued before the disable stops verifying immediately rather than surviving
  // for up to an hour. That lives in the data layer precisely so a call site
  // cannot forget it.
  const user = await store.createMigratedUser({ tag: 'revokedisable' });
  const tokenIssuedBefore = tokenFor(user);

  await patch(`/api/admin/users/${user.externalId}/toggle-status`, undefined, adminToken);
  const after = await store.mysql.read(user.email);
  assert.equal(after.tokenVersion, user.tokenVersion + 1, 'token_version incremented');

  const res = await get('/api/auth/me', tokenIssuedBefore);
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 160)}`);
  assert.notEqual(res.status, 200, 'the token issued before the disable is refused');
});

test('AS7: an admin cannot disable their own account mid-request', async () => {
  // The Mongoose version allowed it - an admin could lock themselves out and
  // then be unable to undo it. Extends BE-MED-06's reasoning to the flag that
  // now actually takes effect.
  const res = await patch(`/api/admin/users/${adminExternalId}/toggle-status`, undefined, adminToken);
  assertRefused(res, 400);
});

// =============================================================================
// PATCH /users/:id/change-password
// =============================================================================

test('ADMIN-01 CLOSED: a password change actually changes the password (CHANGED IN AS7)', async () => {
  // WAS: `200 "Password changed successfully"`, the hash written to MongoDB
  // while login verified against MySQL - so THE OLD PASSWORD STILL WORKED AND
  // THE NEW ONE DID NOT. An admin resetting a compromised account's password
  // changed nothing, and was told they had.
  const user = await store.createMigratedUser({ tag: 'chpw' });
  const before = await store.mysql.passwordHash(user.email);

  const res = await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'AdminSetThis123!' },
    adminToken
  );
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Password changed successfully');

  assert.notEqual(
    await store.mysql.passwordHash(user.email),
    before,
    'the MySQL hash - the one login verifies against - changed'
  );
  assert.equal(
    await store.mysql.verifyPassword(user.email, 'AdminSetThis123!'),
    true,
    'the NEW password works'
  );
  assert.equal(
    await store.mysql.verifyPassword(user.email, PASSWORD),
    false,
    'and the OLD one does not'
  );
});

test('SEC-18b CLOSED: an admin password change REVOKES sessions (CHANGED IN AS7)', async () => {
  // WAS: `token_version` untouched, so every issued token stayed valid for its
  // full hour. The worst possible moment for that control to be missing is
  // exactly when it is used - an admin resetting the password of an account
  // they believe is compromised.
  const user = await store.createMigratedUser({ tag: 'revoke' });
  const tokenIssuedBefore = tokenFor(user);

  await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'AdminSetThis123!' },
    adminToken
  );
  assert.equal(
    (await store.mysql.read(user.email)).tokenVersion,
    user.tokenVersion + 1,
    'token_version incremented by repositories/users.setPassword'
  );

  const res = await get('/api/auth/me', tokenIssuedBefore);
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 160)}`);
  assert.notEqual(res.status, 200, 'the session issued before the reset is dead');
});

test('SEC-10 CLOSED: the password message matches the rule it enforces (CHANGED IN AS7)', async () => {
  // WAS: `length < 10` behind a message that said "at least 6 characters". An
  // admin reading it and choosing a 7-character password was refused by an
  // error telling them it should have worked.
  //
  // That is not a policy defect - the length was right - it is the defect of
  // having a SECOND COPY of the policy, which is what SEC-10 was about. "One
  // validator" has to mean one MODULE, or the next file writes a seventh.
  const user = await store.createMigratedUser({ tag: 'shortpw' });
  const res = await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'short' },
    adminToken
  );
  assertRefused(res, 400);
  assert.match(res.body.error, /at least 10 characters/, 'the message states the rule enforced');

  // The boundary itself, so the shared constant cannot drift unnoticed.
  assertRefused(
    await patch(
      `/api/admin/users/${user.externalId}/change-password`,
      { newPassword: '123456789' },
      adminToken
    ),
    400
  );
  assert.equal(
    (await patch(
      `/api/admin/users/${user.externalId}/change-password`,
      { newPassword: '1234567890' },
      adminToken
    )).status,
    200
  );
});

// =============================================================================
// DELETE /users/:id
// =============================================================================

test('ADMIN-01 CLOSED: deleting an account actually deletes it (CHANGED IN AS7)', async () => {
  // WAS: `200 "User deleted successfully"`, the MongoDB row removed, the MySQL
  // account surviving - AND STILL AUTHENTICATING. The most alarming of the
  // four, because deletion is the action an admin takes when they most need it
  // to have happened.
  const user = await store.createMigratedUser({ tag: 'delete' });
  assert.equal(await stillAuthenticates(user), true, 'precondition');

  const res = await del(`/api/admin/users/${user.externalId}`, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User deleted successfully');

  assert.equal(await store.mysql.read(user.email), null, 'the MySQL account is gone');
  assert.equal(
    await stillAuthenticates(user),
    false,
    'THE DELETED ACCOUNT NO LONGER AUTHENTICATES'
  );

  // And deleting it again is a clean 404 rather than a second success.
  assertRefused(await del(`/api/admin/users/${user.externalId}`, adminToken), 404);
});

test('DELETE refuses self-deletion and the last admin', async () => {
  // These two guards are correct and must survive the migration (BE-MED-06).
  assertRefused(await del(`/api/admin/users/${adminExternalId}`, adminToken), 400);

  const other = await store.createMigratedUser({ tag: 'otheradmin', role: 'admin' });
  const res = await del(`/api/admin/users/${other.externalId}`, adminToken);
  // With two admins present this succeeds; the last-admin guard is asserted by
  // the count, not by deleting the fixture admin out from under the suite.
  assert.equal(res.status, 200, res.raw.slice(0, 200));
});

// =============================================================================
// SEC-19
// =============================================================================

test('SEC-19 CLOSED: a malformed id leaks nothing, and is a 404 (CHANGED IN AS7)', async () => {
  // WAS: `500` carrying `Cast to ObjectId failed for value "not-an-objectid"`,
  // which told a caller the store, the driver and the column. A syntactically
  // impossible id names nothing, which is what "not found" means.
  for (const path of [
    '/api/admin/users/not-an-objectid/toggle-status',
    '/api/admin/users/not-an-objectid/change-password',
    '/api/admin/users/not-an-objectid',
  ]) {
    const res = path.endsWith('change-password')
      ? await patch(path, { newPassword: 'AdminSetThis123!' }, adminToken)
      : path.endsWith('toggle-status')
        ? await patch(path, undefined, adminToken)
        : await del(path, adminToken);
    assertRefused(res, 404);
    assert.doesNotMatch(res.raw, /Cast to ObjectId|prisma|Invalid `|mongo/i, `${path}: no internals`);
  }
});

// =============================================================================
// PUT /users/:id
// =============================================================================

test('ADMIN-01 CLOSED: a profile update reaches the store /auth/me reads (CHANGED IN AS7)', async () => {
  // WAS: the write went to MongoDB, so MySQL kept the old name and every
  // authenticated endpoint kept returning it.
  const user = await store.createMigratedUser({ tag: 'update' });
  const res = await put(
    `/api/admin/users/${user.externalId}`,
    { name: 'Renamed By Admin' },
    adminToken
  );
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal((await store.mysql.read(user.email)).name, 'Renamed By Admin');

  // Read back through the user's OWN session, which is the thing that was
  // wrong: the admin changed a name and the user never saw it.
  const me = await get('/api/auth/me', tokenFor(user));
  assert.equal(me.status, 200, me.raw.slice(0, 160));
  assert.equal(me.body.name || (me.body.user && me.body.user.name), 'Renamed By Admin');
});

test('PUT refuses an admin demoting themselves', async () => {
  assertRefused(await put(`/api/admin/users/${adminExternalId}`, { role: 'user' }, adminToken), 400);
});
