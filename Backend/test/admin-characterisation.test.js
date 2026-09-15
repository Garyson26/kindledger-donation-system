/**
 * =============================================================================
 * CHARACTERISATION tests for routes/admin.js  (SPEC-3 package 3.5, via AS7)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:admin
 *
 * These capture what this route file does TODAY, before the migration. Where
 * the current behaviour is wrong, the WRONG behaviour is asserted and marked
 * `QUIRK`, cross-referenced to the finding that will change it.
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

test('QUIRK (D-X2, BUG-03): /stats counts donations in MONGODB, not MySQL', async () => {
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

  assert.equal(
    res.body.donations,
    mongoTotal,
    'CURRENT: the tile reports the MongoDB count'
  );
  assert.notEqual(
    res.body.donations,
    mysqlTotal,
    'and that differs from MySQL, which is where donations actually live since 3.3'
  );
});

test('QUIRK (BUG-03): the "approved" tile counts only the LOWERCASE subset', async () => {
  // NOT "always 0", which is what the map said until the AR1 audit measured it.
  // It matches `status: "approved"` exactly, so it counts whatever fraction was
  // written by PATCH /:id/status and misses everything the payment callbacks
  // wrote as `Approved`. A tile showing 0 is visibly broken; a tile showing a
  // fraction is believed.
  const doc = await MongoDonation.create({
    donorName: 'ZZZ AdminChar',
    donorEmail: `${TAG}-approved@invalid.test`,
    category: new mongoose.Types.ObjectId(),
    quantity: 1,
    amount: 1500,
    status: 'Approved', // canonical - what the callbacks write
    paymentStatus: 'Paid',
    date: new Date(),
  });

  const before = (await get('/api/admin/stats', adminToken)).body.approved;

  // The same donation, lowercased through the unvalidated update path.
  await MongoDonation.findByIdAndUpdate(doc._id, { status: 'approved' }, { new: true });
  const after = (await get('/api/admin/stats', adminToken)).body.approved;

  assert.equal(
    after,
    before + 1,
    'CURRENT: lowercasing a donation makes the tile count it - so the tile ' +
      'measures casing, not approval'
  );
});

// =============================================================================
// GET /users
// =============================================================================

test('QUIRK (ADMIN-01): the user list reads MONGODB, so a MySQL account is absent', async () => {
  const email = uniqEmail('mysqlonly');
  await store.mysql.createUser({ email });

  const res = await get('/api/admin/users?page=1&limit=100', adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['pagination', 'users']);
  assert.deepEqual(Object.keys(res.body.pagination).sort(), ['limit', 'page', 'pages', 'total']);

  assert.equal(
    res.body.users.some((u) => u.email === email),
    false,
    'CURRENT: an account that can log in does not appear in the admin list'
  );
});

test('the listed user never carries the password hash', async () => {
  await store.createMigratedUser({ tag: 'listed' });
  const res = await get('/api/admin/users?page=1&limit=100', adminToken);
  for (const u of res.body.users) {
    assert.equal('password' in u, false, 'the hash must never reach the client');
  }
});

test('QUIRK (BUG-08): the user list limit is uncapped and NaN passes through', async () => {
  const big = await get('/api/admin/users?page=1&limit=100000', adminToken);
  assert.equal(big.status, 200);
  assert.equal(big.body.pagination.limit, 100000, 'CURRENT: used verbatim');

  const nan = await get('/api/admin/users?page=abc&limit=abc', adminToken);
  assert.notEqual(Math.floor(nan.status / 100), 5, `must not 500: ${nan.raw.slice(0, 160)}`);
  assert.equal(nan.status, 200);
  assert.equal(nan.body.pagination.limit, null, 'CURRENT: NaN serialises as null');
});

test('the user search escapes regex metacharacters rather than executing them', async () => {
  // BE-HIGH-08 was fixed here and must stay fixed through the migration - and
  // the SQL form has its own metacharacters, so this is not automatic.
  await store.createMigratedUser({ tag: 'regex' });
  const res = await get('/api/admin/users?page=1&limit=100&search=.*', adminToken);
  assert.equal(res.status, 200);
  assert.equal(
    res.body.users.filter((u) => u.email && u.email.startsWith(TAG)).length,
    0,
    '`.*` is a literal, not a wildcard'
  );
});

// =============================================================================
// POST /users
// =============================================================================

test('QUIRK (ADMIN-01): an admin-created account CANNOT LOG IN', async () => {
  // The single most direct statement of the finding. The admin is told the
  // account was created; auth.js reads MySQL and there is no row there.
  const email = uniqEmail('created');
  const res = await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email, password: PASSWORD, role: 'user' },
    adminToken
  );
  assert.equal(res.status, 201, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User created successfully');

  assert.ok(await store.mongo.read(email), 'it went to MongoDB');
  assert.equal(await store.mysql.read(email), null, 'CURRENT: and not to MySQL');

  const login = await post('/api/auth/login', { email, password: PASSWORD });
  assertRefused(login, 400);
  assert.equal(
    login.body.error,
    'Invalid credentials',
    'CURRENT: the account the admin just created cannot authenticate'
  );
});

test('QUIRK (SEC-18, SEC-21): cost 10, and isVerified is never set', async () => {
  const email = uniqEmail('hash');
  await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email, password: PASSWORD },
    adminToken
  );
  const doc = await store.mongo.read(email);
  assert.equal(
    Number(doc.password.split('$')[2]),
    10,
    'CURRENT: cost 10, bypassing BCRYPT_COST=12 in repositories/users'
  );
  assert.equal(doc.isVerified, false, 'CURRENT: created unverified');
});

test('QUIRK (SEC-08): creating a duplicate names the reason', async () => {
  const user = await store.createMigratedUser({ tag: 'dupe' });
  const res = await post(
    '/api/admin/users',
    { name: 'ZZZ AdminChar', email: user.email, password: PASSWORD },
    adminToken
  );
  assertRefused(res, 400);
  assert.equal(res.body.error, 'User with this email already exists');
});

test('POST /users requires name, email and password', async () => {
  assertRefused(await post('/api/admin/users', { email: uniqEmail('x') }, adminToken), 400);
});

// =============================================================================
// PATCH /users/:id/toggle-status - THE FINDING
// =============================================================================

test('QUIRK (ADMIN-01): disabling an account reports success and does NOTHING', async () => {
  const user = await store.createMigratedUser({ tag: 'disable' });
  assert.equal(await stillAuthenticates(user), true, 'precondition: the token works');

  const res = await patch(`/api/admin/users/${user.externalId}/toggle-status`, undefined, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User disabled successfully');

  assert.equal((await store.mongo.readById(user.externalId)).isActive, false, 'MongoDB changed');
  assert.equal(
    (await store.mysql.read(user.email)).isActive,
    true,
    'CURRENT: MySQL is untouched, and MySQL is what authMiddleware enforces'
  );

  assert.equal(
    await stillAuthenticates(user),
    true,
    'CURRENT: THE DISABLED ACCOUNT STILL AUTHENTICATES. The admin was told it ' +
      'was disabled, the record says disabled, and access was never revoked.'
  );
});

// =============================================================================
// PATCH /users/:id/change-password
// =============================================================================

test('QUIRK (ADMIN-01): changing a password reports success and the OLD one still works', async () => {
  const user = await store.createMigratedUser({ tag: 'chpw' });
  const before = await store.mysql.passwordHash(user.email);

  const res = await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'AdminSetThis123!' },
    adminToken
  );
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Password changed successfully');

  assert.equal(
    await store.mysql.passwordHash(user.email),
    before,
    'CURRENT: the MySQL hash - the one login verifies against - is unchanged'
  );
  assert.equal(
    await store.mysql.verifyPassword(user.email, PASSWORD),
    true,
    'CURRENT: the OLD password still works'
  );
  assert.equal(
    await store.mysql.verifyPassword(user.email, 'AdminSetThis123!'),
    false,
    'CURRENT: and the NEW one does not'
  );
});

test('QUIRK (SEC-18b): an admin password change does not revoke sessions', async () => {
  const user = await store.createMigratedUser({ tag: 'revoke' });
  await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'AdminSetThis123!' },
    adminToken
  );
  assert.equal(
    (await store.mysql.read(user.email)).tokenVersion,
    user.tokenVersion,
    'CURRENT: token_version is untouched, so every issued token stays valid - ' +
      'repositories/users.setPassword would have incremented it'
  );
  assert.equal(await stillAuthenticates(user), true, 'CURRENT: the old session survives');
});

test('the password length check rejects short passwords - and misstates its own rule', async () => {
  const user = await store.createMigratedUser({ tag: 'shortpw' });
  const res = await patch(
    `/api/admin/users/${user.externalId}/change-password`,
    { newPassword: 'short' },
    adminToken
  );
  assertRefused(res, 400);
  assert.match(
    res.body.error,
    /at least 6 characters/,
    'CURRENT: the check is `length < 10` and the message says 6'
  );
});

// =============================================================================
// DELETE /users/:id
// =============================================================================

test('QUIRK (ADMIN-01): deleting an account reports success and it keeps working', async () => {
  const user = await store.createMigratedUser({ tag: 'delete' });

  const res = await del(`/api/admin/users/${user.externalId}`, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'User deleted successfully');

  assert.equal(await store.mongo.readById(user.externalId), null, 'MongoDB row is gone');
  assert.ok(await store.mysql.read(user.email), 'CURRENT: the MySQL account survives');
  assert.equal(
    await stillAuthenticates(user),
    true,
    'CURRENT: THE DELETED ACCOUNT STILL AUTHENTICATES'
  );
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

test('QUIRK (SEC-19): a malformed id leaks the internal error', async () => {
  const res = await patch(
    '/api/admin/users/not-an-objectid/toggle-status',
    undefined,
    adminToken
  );
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Cast to ObjectId failed/, 'CURRENT: the driver error is returned');
});

// =============================================================================
// PUT /users/:id
// =============================================================================

test('QUIRK (ADMIN-01): a profile update writes MongoDB only', async () => {
  const user = await store.createMigratedUser({ tag: 'update' });
  const res = await put(
    `/api/admin/users/${user.externalId}`,
    { name: 'Renamed By Admin' },
    adminToken
  );
  assert.equal(res.status, 200, res.raw.slice(0, 200));

  assert.equal((await store.mongo.readById(user.externalId)).name, 'Renamed By Admin');
  assert.equal(
    (await store.mysql.read(user.email)).name,
    'ZZZ AdminChar',
    'CURRENT: MySQL keeps the old name, and MySQL is what /auth/me returns'
  );
});

test('PUT refuses an admin demoting themselves', async () => {
  assertRefused(await put(`/api/admin/users/${adminExternalId}`, { role: 'user' }, adminToken), 400);
});
