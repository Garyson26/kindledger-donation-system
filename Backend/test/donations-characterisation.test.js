/**
 * =============================================================================
 * CHARACTERISATION tests for routes/donations.js  (SPEC-3 package 3.3)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:donations
 *
 * Written against the Mongoose implementation BEFORE the migration, and now
 * asserted against the MySQL one. EIGHT assertions changed; each is marked
 * `CHANGED IN 3.3` with the finding that caused it.
 *
 * SEVEN OF THE EIGHT ARE QUIRKS BEING CLOSED - BUG-01, BUG-02, BUG-06, BUG-08,
 * BUG-12, SEC-16 and SEC-19. They were pinned as WRONG behaviour on purpose, so
 * fixing them HAD to break this file. A fix that broke nothing here would mean
 * the original assertion was not testing the defect.
 *
 * SEAM SWITCHED (SPEC-2 section 4.1). `store` now reads and writes MySQL
 * through the repositories. Donations are the last entity this suite held in
 * MongoDB; what remains of Mongoose here is the AK3 fixture, whose whole
 * purpose is to NOT be in MySQL.
 *
 * AK3 / AM1: a donation created in MONGODB and NOT migrated, created AFTER any
 * ETL run so no ordering can migrate it, with a POSITIVE assertion that it has
 * no MySQL row before the route is exercised.
 *
 * AE4: PIN WHAT THE ENDPOINT ACTUALLY RETURNED, NOT WHAT THE CODE APPEARS TO
 * ASK FOR. Package 3.1 found `populate("category", "name description price")`
 * requesting two fields that are not on the Category schema, so that call only
 * ever returned `name`. Reading a field list is reading an INTENTION. Several
 * assertions below therefore enumerate the keys actually present in the
 * response rather than trusting the query that produced it.
 *
 * AC1: EVERY REFUSAL ASSERTS THE MECHANISM. Status code, response shape, and
 * that nothing 500'd. A gate that crashes leaves the same visible state as a
 * gate that refuses, which is how SEC-14 hid behind a green test.
 *
 * PORTABILITY. All storage access goes through the `store` seam. Donations are
 * still MongoDB in this package; categories are MySQL as of 3.1, which is why
 * the seam spans both.
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
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_don_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// MongoDB models. Retained ONLY for the AK3 fixture - the donation that is
// deliberately never migrated, so that "absent from MySQL" can be asserted
// rather than assumed.
const MongoDonation = require('../models/Donation');
const categories = require('../repositories/categories');
const donations = require('../repositories/donations');
const users = require('../repositories/users');
const prismaModule = require('../config/prisma');

const TAG = 'zzz-don-test';
const CAT_PREFIX = 'ZZZ DON TEST';

let server;
let base;
let adminToken;
let ownerToken;
let strangerToken;
let ownerId;
let categoryId; // the ObjectId-shaped external id (ADR-051)

const uniq = (t) => `${TAG}-${t}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * A fresh 24-hex external identifier (ADR-051).
 *
 * The fixtures mint their own rather than letting the repository default,
 * because the routes exchange the ObjectId form and a fixture that skipped it
 * would exercise a code path no client uses.
 */
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
// Storage seam - MySQL as of package 3.3.
// -----------------------------------------------------------------------------
// SPEC-2 section 4.1: the suite talks to `store`, never to a driver, so
// switching the store was these function bodies and not 24 rewritten tests.
// Everything below returns the EXTERNAL identifier (ADR-051: a 24-hex
// ObjectId), because that is what the routes and the clients exchange.
// -----------------------------------------------------------------------------
const store = {
  async resetDonations() {
    await donations.deleteByDonorEmailPrefix(TAG);
    await MongoDonation.deleteMany({ donorEmail: new RegExp('^' + TAG) });
  },

  async resetAll() {
    await this.resetDonations();
    await users.deleteByEmailPrefix(TAG);
    await categories.deleteByNamePrefix(CAT_PREFIX);
  },

  async createCategory(name) {
    const row = await categories.create({
      name,
      legacyId: mintObjectId(),
      shortDescription: 'fixture',
      donationAmountMinor: 150000,
      descriptions: [],
    });
    return row.legacyId;
  },

  /** A donation. `userId` null makes it a guest donation. */
  async createDonation({
    tag,
    userId = null,
    amount = 1500,
    paymentStatus = 'Pending',
    status = 'Pending',
    date = new Date(),
    category = categoryId,
  }) {
    const row = await donations.create({
      legacyId: mintObjectId(),
      donorName: 'ZZZ Donor ' + tag,
      donorEmail: `${TAG}-${tag}@invalid.test`,
      userId: userId || undefined,
      categoryId: category,
      quantity: 1,
      baseAmountMinor: Math.round(amount * 100),
      extraAmountMinor: 0,
      amountMinor: Math.round(amount * 100),
      status,
      paymentStatus,
      donatedAt: date,
    });
    return row.legacyId;
  },

  /**
   * A donation in MONGODB ONLY. The AK3 fixture.
   *
   * ADR-056: a read-through bridge does not make a route migration additive, so
   * this must be INVISIBLE to every endpoint in the migrated file - and the ETL
   * is the only thing that changes that. Asserted, never assumed.
   */
  async createMongoOnlyDonation(tag) {
    const doc = await MongoDonation.create({
      donorName: 'ZZZ Legacy Donor ' + tag,
      donorEmail: `${TAG}-${tag}@invalid.test`,
      category: new mongoose.Types.ObjectId(),
      quantity: 1,
      amount: 4242,
      status: 'Pending',
      paymentStatus: 'Pending',
      date: new Date(),
      transactionId: uniq('legacy-txn'),
    });
    return doc._id.toString();
  },

  async hasMysqlRow(legacyId) {
    return Boolean(await donations.findByLegacyId(String(legacyId)));
  },

  /** Normalised view; no storage types leak past here. */
  async readDonation(externalId) {
    const row = await donations.findByLegacyId(String(externalId));
    if (!row) return null;
    return {
      id: row.legacyId || row.id,
      donorEmail: row.donorEmail,
      amount: row.amountMinor / 100,
      status: row.status,
      paymentStatus: row.paymentStatus,
      userId: row.donor.user ? row.donor.user.legacyId || row.donor.user.id : null,
      category: row.category ? row.category.legacyId || row.category.id : null,
    };
  },

  async createUser(role, tag) {
    const email = `${TAG}-${tag}@invalid.test`;
    const created = await users.create({
      name: 'ZZZ Don Test ' + role,
      email,
      password: 'FixturePass123!',
      role,
      isVerified: true,
    });
    const fresh = await users.findById(created.id);
    return fresh.legacyId || fresh.id;
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

/**
 * AC1: a refusal must be a decision, not a crash.
 *
 * THREE KEY NAMES, which is itself a finding (BUG-11 below): route handlers
 * answer `{error}`, `adminAuth` answers `{message}`, and `authMiddleware`
 * answers `{msg}`. A client cannot read "the reason a request was refused"
 * without trying all three, so in practice it reads none of them and shows a
 * generic failure. All three are accepted here because pinning CURRENT
 * behaviour is the job; the inconsistency is recorded, not smoothed over.
 */
// BUG-11 was fixed in package 3.2, so this can now default to `error` ALONE.
// While three key names were in play it had to accept all of them, which is
// verifying almost nothing - AG2's point, and the reason the fix came first.
function assertRefused(res, expectedStatus, keys = ['error']) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a decision, got ${res.status}: ${res.raw.slice(0, 200)}`
  );
  assert.equal(res.status, expectedStatus, res.raw.slice(0, 200));
  assert.ok(res.body, 'a refusal must carry a JSON body');
  assert.ok(
    keys.some((k) => typeof res.body[k] === 'string'),
    `refusal must name a reason in one of ${keys.join('/')}: ${res.raw.slice(0, 120)}`
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
  assert.ok(process.env.DATABASE_URL, 'Categories are MySQL since 3.1; DATABASE_URL is required');
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

  await store.resetAll();
  const adminId = await store.createUser('admin', 'admin');
  ownerId = await store.createUser('user', 'owner');
  const strangerId = await store.createUser('user', 'stranger');
  adminToken = jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  ownerToken = jwt.sign({ userId: ownerId, role: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  strangerToken = jwt.sign({ userId: strangerId, role: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  categoryId = await store.createCategory(`${CAT_PREFIX} main`);
});

after(async () => {
  try {
    await store.resetAll();
  } finally {
    if (server) server.close();
    await mongoose.connection.close();
    await prismaModule.disconnect();
  }
});

// =============================================================================
// Authorisation
// =============================================================================

test('the admin endpoints refuse anonymous and non-admin callers', async () => {
  const guarded = [
    ['GET', '/api/donations'],
    ['GET', '/api/donations/filter-options'],
    ['GET', '/api/donations/stats/charts'],
  ];
  for (const [method, path] of guarded) {
    assertRefused(await call(method, path), 401);
    assertRefused(await call(method, path, { token: ownerToken }), 403);
  }
});

test('GET /:id is owner-or-admin; a stranger is refused', async () => {
  const id = await store.createDonation({ tag: 'owned', userId: ownerId });

  assertRefused(await get(`/api/donations/${id}`), 401);
  assertRefused(await get(`/api/donations/${id}`, strangerToken), 403);

  assert.equal((await get(`/api/donations/${id}`, ownerToken)).status, 200);
  assert.equal((await get(`/api/donations/${id}`, adminToken)).status, 200);
});

test('QUIRK: a GUEST donation is admin-only, because there is no owner to match', async () => {
  // Not a defect, but worth pinning: `userId` is null, so `isOwner` can never
  // be true and the donor who made it cannot retrieve it by id.
  const id = await store.createDonation({ tag: 'guest', userId: null });
  assertRefused(await get(`/api/donations/${id}`, ownerToken), 403);
  assert.equal((await get(`/api/donations/${id}`, adminToken)).status, 200);
});

test('GET /user/:userId refuses another user, and admins may read anyone', async () => {
  assertRefused(await get(`/api/donations/user/${ownerId}`, strangerToken), 403);
  assert.equal((await get(`/api/donations/user/${ownerId}`, ownerToken)).status, 200);
  assert.equal((await get(`/api/donations/user/${ownerId}`, adminToken)).status, 200);
});

// =============================================================================
// POST / - BUG-01 and BUG-06
// =============================================================================

test('BUG-01 CLOSED: POST /api/donations is GONE (CHANGED IN 3.3)', async () => {
  // WAS: a 400 for every request the endpoint had ever received, because the
  // handler built a document without the required donorEmail and amount. It
  // never succeeded once in its life.
  //
  // The map asked for a decision - supply the fields, or delete it - and this
  // is the decision. Deleted, for two reasons:
  //
  //   1. NOTHING CAN DEPEND ON IT. An endpoint that has always refused has no
  //      client relying on success, and the frontend's DONATIONS.CREATE
  //      constant is declared and never referenced.
  //   2. COMPLETING IT WOULD BE THE WORSE CHANGE. It sat behind optionalAuth,
  //      so making it work would create an UNAUTHENTICATED path that writes
  //      donation records bypassing payment initiation entirely: arbitrary
  //      amounts, no gateway, any status the caller liked.
  //
  // Express has no POST handler on this path now, so the router falls through.
  const res = await post(
    '/api/donations',
    { item: 'Reef', category: categoryId, quantity: 1 },
    ownerToken
  );
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 160)}`);
  assert.equal(res.status, 404, 'the endpoint is gone, not broken');
});

test('BUG-01 CLOSED: it is gone for a guest too (CHANGED IN 3.3)', async () => {
  const res = await post('/api/donations', { item: 'Reef', category: categoryId, quantity: 1 });
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 160)}`);
  assert.equal(res.status, 404);
});

test('BUG-06 CLOSED BY DELETION: optionalAuth is gone (CHANGED IN 3.3)', async () => {
  // WAS: a guest holding a stale token got 401 from optionalAuth instead of
  // falling through to guest.
  //
  // NOT FIXED - REMOVED. POST / was optionalAuth's only caller, so fixing the
  // helper would have left a corrected fragment that nothing reaches: code that
  // looks tested and is not exercised. If an endpoint later needs optional
  // authentication it needs the fall-through, and THAT is recorded in the map
  // rather than preserved here as dead code.
  const expired = jwt.sign({ userId: ownerId, role: 'user', tokenVersion: 0 }, process.env.JWT_SECRET, {
    expiresIn: '-1h',
  });
  const res = await post('/api/donations', { item: 'Reef', category: categoryId }, expired);
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 160)}`);
  assert.equal(res.status, 404, 'no optionalAuth path remains to 401 anyone');
});

test('BUG-11 is FIXED: every layer names its reason under `error` (CHANGED IN 3.2)', async () => {
  // WAS: `error`, `message` or `msg` depending on which layer refused - 12, 9
  // and 4 occurrences. The frontend reads `data.error || data.message`, so
  // every `msg` refusal reached the user as "Request failed".
  //
  // THIS TEST BREAKING IS THE POINT. It was written to pin the broken shape,
  // and fixing BUG-11 in package 3.2 made it fail - so the change had to be
  // made here, deliberately and visibly, rather than passing unnoticed. That is
  // the characterisation discipline doing exactly what it is for.
  //
  // NOW: `error` is canonical everywhere and `message` mirrors it for the
  // frontend's existing fallback. `msg` is gone; nothing read it, which is
  // precisely why those refusals were invisible.
  const id = await store.createDonation({ tag: 'keys', userId: ownerId });

  const noToken = await get(`/api/donations/${id}`);          // authMiddleware
  const nonAdmin = await get('/api/donations', ownerToken);    // adminAuth
  // CHANGED IN 3.3: this used `{status:'Approved'}`, which was a 400 only
  // because of BUG-02 - the endpoint refused the canonical casing. Closing
  // BUG-02 made it a 200 and this test started failing on a REFUSAL it could no
  // longer provoke. The trigger, not the rule, was stale: `banana` is outside
  // the enum in any casing, so it exercises the same refusal path permanently.
  const badStatus = await patch(                               // route handler
    `/api/donations/${id}/status`,
    { status: 'banana' },
    adminToken
  );
  const malformed = await put('/api/donations/not-an-objectid', { status: 'x' }, adminToken);

  for (const [label, res] of [
    ['authMiddleware', noToken],
    ['adminAuth', nonAdmin],
    ['route handler', badStatus],
    ['route handler (malformed id)', malformed],
  ]) {
    assert.equal(typeof res.body.error, 'string', `${label}: reason under "error"`);
    assert.equal('msg' in res.body, false, `${label}: "msg" is gone`);
  }

  // The frontend alias, kept until Phase 5 owns the frontend.
  assert.equal(noToken.body.message, noToken.body.error);
});

// =============================================================================
// GET / - the admin list
// =============================================================================

test('GET / returns {donations, pagination} and sorts newest first', async () => {
  await store.resetDonations();
  const older = await store.createDonation({ tag: 'old', amount: 100 });
  await new Promise((r) => setTimeout(r, 10));
  const newer = await store.createDonation({ tag: 'new', amount: 200 });

  const res = await get('/api/donations?page=1&limit=10', adminToken);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.donations));
  assert.deepEqual(Object.keys(res.body.pagination).sort(), ['limit', 'page', 'pages', 'total']);

  const ids = res.body.donations.map((d) => d._id);
  assert.ok(ids.indexOf(newer) < ids.indexOf(older), 'sorted by createdAt descending');
});

test('AE4: what a listed donation ACTUALLY carries', async () => {
  // Enumerated from the response rather than inferred from the query. `userId`
  // is populated to name+email only; `category` is the whole record via the
  // 3.1 bridge.
  await store.resetDonations();
  await store.createDonation({ tag: 'shape', userId: ownerId });

  const res = await get('/api/donations?page=1&limit=10', adminToken);
  const d = res.body.donations.find((x) => x.donorEmail.startsWith(TAG));
  assert.ok(d, 'the fixture is present');

  assert.deepEqual(
    Object.keys(d.userId).sort(),
    ['_id', 'email', 'name'],
    'userId is populated with name and email ONLY'
  );
  assert.equal(d.userId.email.startsWith(TAG), true);
  assert.equal('password' in d.userId, false, 'and never the hash');

  assert.ok(d.category, 'category is resolved, not left as an id');
  assert.equal(typeof d.category.name, 'string');
  assert.equal(typeof d.category.donationAmount, 'number');
});

test('GET / filters by paymentStatus, userType and search', async () => {
  await store.resetDonations();
  await store.createDonation({ tag: 'paid', paymentStatus: 'Paid', userId: ownerId });
  await store.createDonation({ tag: 'pending', paymentStatus: 'Pending', userId: null });

  const paid = await get('/api/donations?page=1&limit=10&paymentStatus=Paid', adminToken);
  const mine = paid.body.donations.filter((d) => d.donorEmail.startsWith(TAG));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].paymentStatus, 'Paid');

  const guests = await get('/api/donations?page=1&limit=10&userType=guest', adminToken);
  for (const d of guests.body.donations.filter((x) => x.donorEmail.startsWith(TAG))) {
    assert.equal(d.userId, null);
  }

  const searched = await get('/api/donations?page=1&limit=10&searchQuery=paid', adminToken);
  assert.ok(searched.body.donations.some((d) => d.donorEmail.includes('paid')));
});

test('GET / search escapes regex metacharacters rather than executing them', async () => {
  // BE-HIGH-08 was fixed and must stay fixed: an unescaped `.*` would match
  // every donor.
  await store.resetDonations();
  await store.createDonation({ tag: 'regex', userId: ownerId });

  const res = await get('/api/donations?page=1&limit=10&searchQuery=.*', adminToken);
  assert.equal(res.status, 200);
  assert.equal(
    res.body.donations.filter((d) => d.donorEmail.startsWith(TAG)).length,
    0,
    '`.*` is a literal, not a wildcard'
  );
});

test('BE-HIGH-08 SURVIVES THE STORE SWAP: `%` is a literal, not a wildcard', async () => {
  // THE FINDING WAS NOT RETIRED BY MOVING TO SQL - IT WAS RENAMED.
  //
  // BE-HIGH-08 was about `$regex` executing the caller's metacharacters, and
  // the fix escaped them. `LIKE` has its own metacharacters, `%` and `_`, and a
  // parameterised query does NOT neutralise them: binding stops SQL injection,
  // it does not stop `%` from meaning "anything". So `searchQuery=%` would
  // return every donor - the same over-match, through a different door.
  //
  // This also pins the dependency the escaping rests on: MySQL's LIKE treats
  // backslash as the default escape character, which is only true while
  // NO_BACKSLASH_ESCAPES is absent from sql_mode. Asserted by behaviour here
  // rather than trusted from a comment.
  await store.resetDonations();
  await store.createDonation({ tag: 'likepct', userId: ownerId });

  for (const term of ['%', '%%', '_', 'zzz%test']) {
    const res = await get(
      `/api/donations?page=1&limit=100&searchQuery=${encodeURIComponent(term)}`,
      adminToken
    );
    assert.equal(res.status, 200, `${term}: ${res.raw.slice(0, 160)}`);
    assert.equal(
      res.body.donations.filter((d) => d.donorEmail.startsWith(TAG)).length,
      0,
      `'${term}' must be matched literally, not as a pattern`
    );
  }

  // The control: a term that IS a literal substring still finds the row, so the
  // assertions above are about escaping and not about search being broken.
  const hit = await get('/api/donations?page=1&limit=100&searchQuery=likepct', adminToken);
  assert.equal(
    hit.body.donations.filter((d) => d.donorEmail.startsWith(TAG)).length,
    1,
    'CONTROL FAILED: literal search matches nothing either, so nothing above is proven'
  );
});

test('BUG-08 CLOSED: limit is CAPPED and NaN is REFUSED (CHANGED IN 3.3)', async () => {
  // WAS: `limit=100000` was used verbatim and loaded a hundred thousand rows;
  // `limit=abc` produced NaN, which flowed into the query and came back as
  // `"limit": null` inside a 200. A caller could not tell an empty page from a
  // request the server had failed to parse.
  await store.resetDonations();
  await store.createDonation({ tag: 'page' });

  const big = await get('/api/donations?page=1&limit=100000', adminToken);
  assert.equal(big.status, 200);
  assert.equal(big.body.pagination.limit, 100, 'clamped to MAX_PAGE_SIZE');
  assert.ok(big.body.donations.length <= 100, 'and the page obeys the clamp');

  const nan = await get('/api/donations?page=abc&limit=abc', adminToken);
  assertRefused(nan, 400);

  // The clamp applies to the per-user listing too - the old code had the same
  // defect twice, at donations.js:112 and :218, and one fix had to cover both.
  const perUser = await get(`/api/donations/user/${ownerId}?page=1&limit=100000`, ownerToken);
  assert.equal(perUser.status, 200);
  assert.equal(perUser.body.pagination.limit, 100);
  assertRefused(await get(`/api/donations/user/${ownerId}?page=abc&limit=abc`, ownerToken), 400);
});

// =============================================================================
// GET /filter-options - the only distinct() in the project
// =============================================================================

test('filter-options reports statuses PRESENT IN THE DATA, not the enum members', async () => {
  // ADR-041. The obvious MySQL implementation returns the ENUM's member list,
  // which silently changes this from "what exists" to "what is possible" - and
  // the admin filter stops being able to show that nothing has been Cancelled.
  await store.resetDonations();
  await store.createDonation({ tag: 'fo1', paymentStatus: 'Paid', userId: ownerId });
  await store.createDonation({ tag: 'fo2', paymentStatus: 'Pending', userId: null });

  const res = await get('/api/donations/filter-options', adminToken);
  assert.equal(res.status, 200);

  assert.deepEqual(Object.keys(res.body).sort(), [
    'counts',
    'dateRange',
    'paymentStatuses',
    'userTypes',
  ]);
  assert.ok(res.body.paymentStatuses.includes('Paid'));
  assert.ok(res.body.paymentStatuses.includes('Pending'));

  // CHANGED IN 3.3, AND THE REASON IS WORTH RECORDING.
  //
  // This used to assert that `Cancelled` is absent, which held only because the
  // suite had the store to itself. Against MySQL it shares one database with
  // whatever else is loaded locally - the ETL's own fixtures include a
  // Cancelled donation - so the assertion started failing on data it does not
  // own. The rule it was reaching for was never about `Cancelled`.
  //
  // THE RULE IS: the statuses reported are EXACTLY the statuses that have rows.
  // That is what separates data semantics from enum semantics, it is what
  // ADR-041 actually says, and it is true no matter what else is in the table.
  assert.deepEqual(
    res.body.paymentStatuses.slice().sort(),
    Object.keys(res.body.counts.byStatus).sort(),
    'reported statuses must be exactly those with rows, never the enum members'
  );

  // And where an enum member genuinely has no rows, it must be absent. This
  // half can only run when such a member exists; when every member is in use,
  // reporting all four IS correct and the assertion above carries the test.
  const unused = ['Pending', 'Paid', 'Failed', 'Cancelled'].filter(
    (m) => !(m in res.body.counts.byStatus)
  );
  for (const m of unused) {
    assert.equal(
      res.body.paymentStatuses.includes(m),
      false,
      `${m} has no rows and must NOT be offered as a filter`
    );
  }

  assert.deepEqual(Object.keys(res.body.counts).sort(), ['byStatus', 'guest', 'registered', 'total']);
  assert.deepEqual(Object.keys(res.body.dateRange).sort(), ['max', 'min']);
  assert.match(res.body.dateRange.min, /^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD, not ISO');
});

test('filter-options omits a userType with no rows', async () => {
  await store.resetDonations();
  await store.createDonation({ tag: 'onlyguest', userId: null });

  const res = await get('/api/donations/filter-options', adminToken);
  // Registered donations may exist from other fixtures; assert the rule rather
  // than an absolute list.
  assert.ok(Array.isArray(res.body.userTypes));
  if (res.body.counts.registered === 0) {
    assert.equal(res.body.userTypes.includes('registered'), false);
  }
  assert.ok(res.body.userTypes.includes('guest'));
});

// =============================================================================
// PUT /:id and PATCH /:id/status
// =============================================================================

test('SEC-16 CLOSED: PUT /:id refuses a status outside the enum (CHANGED IN 3.3)', async () => {
  // WAS: `findByIdAndUpdate` does not run validators, so `{status:"banana"}`
  // landed in the column and every status filter missed the row afterwards.
  // That is also the mechanism behind BUG-02.
  const id = await store.createDonation({ tag: 'sec16' });

  const res = await put(`/api/donations/${id}`, { status: 'banana' }, adminToken);
  assertRefused(res, 400);
  assert.equal(
    (await store.readDonation(id)).status,
    'Pending',
    'and the stored value is UNCHANGED - a refused write must write nothing'
  );

  // The enum members themselves still work, in either casing (BUG-02).
  assert.equal((await put(`/api/donations/${id}`, { status: 'approved' }, adminToken)).status, 200);
  assert.equal((await store.readDonation(id)).status, 'Approved', 'stored canonically');
});

test('BUG-12 CLOSED: PUT /:id 404s a missing donation (CHANGED IN 3.3)', async () => {
  // WAS: no not-found branch at all. The caller was told `200 {message:
  // "Donation updated", donation: null}` for a donation that does not exist -
  // the status said success and the message said updated - while PATCH
  // /:id/status, doing the same job on the same resource, returned 404.
  const missing = mintObjectId();
  const res = await put(`/api/donations/${missing}`, { status: 'Approved' }, adminToken);
  assertRefused(res, 404);

  // The point of the finding was the DISAGREEMENT, so assert they now agree.
  const patched = await patch(`/api/donations/${missing}/status`, { status: 'approved' }, adminToken);
  assertRefused(patched, 404);
  assert.equal(res.status, patched.status, 'two endpoints, one meaning of "not found"');
});

test('SEC-19 CLOSED: a malformed id leaks nothing, and is a 404 (CHANGED IN 3.3)', async () => {
  // WAS: `500` with `Cast to ObjectId failed for value "not-an-objectid" ...`
  // returned verbatim - which told a caller the store, the driver and the
  // column. AD1b: the id SHAPE is checked before dispatch, so a syntactically
  // impossible id names nothing, which is what "not found" means.
  const res = await put('/api/donations/not-an-objectid', { status: 'Approved' }, adminToken);
  assertRefused(res, 404);
  assert.doesNotMatch(res.raw, /Cast to ObjectId|prisma|Invalid `|mongo/i, 'no internals');
});

test('BUG-02 CLOSED: both casings are accepted, ONE is stored (CHANGED IN 3.3)', async () => {
  // WAS: this endpoint accepted ONLY `approved`/`rejected` and wrote them
  // unvalidated, while the payment callbacks wrote `Approved` - so the
  // collection held both casings, every status filter missed half its rows, and
  // admin.js's dashboard tile counting `status:"approved"` read zero forever
  // (BUG-03). Casing is now decided in the repository, once, so the two writers
  // cannot disagree again.
  const id = await store.createDonation({ tag: 'bug02' });

  const capitalised = await patch(`/api/donations/${id}/status`, { status: 'Approved' }, adminToken);
  assert.equal(capitalised.status, 200, 'the canonical casing is no longer refused');
  assert.equal((await store.readDonation(id)).status, 'Approved');

  const lower = await patch(`/api/donations/${id}/status`, { status: 'rejected' }, adminToken);
  assert.equal(lower.status, 200);
  assert.equal(
    (await store.readDonation(id)).status,
    'Rejected',
    'lowercase in, canonical stored - the whole point of the finding'
  );

  // And a status outside the pair is still refused, mechanism asserted (AC1).
  assertRefused(await patch(`/api/donations/${id}/status`, { status: 'banana' }, adminToken), 400);
  assertRefused(await patch(`/api/donations/${id}/status`, { status: 'Pending' }, adminToken), 400);
  assert.equal((await store.readDonation(id)).status, 'Rejected', 'and nothing was written');
});

test('PATCH /:id/status 404s a missing donation - AND SO DOES PUT NOW', async () => {
  // Pinned side by side with the PUT case above. When this was written the two
  // endpoints disagreed about what "not found" means; BUG-12 closed that, and
  // this test is kept because it is the one that was RIGHT.
  const missing = mintObjectId();
  const res = await patch(`/api/donations/${missing}/status`, { status: 'approved' }, adminToken);
  assertRefused(res, 404);
});

// =============================================================================
// GET /:id - the detail shape
// =============================================================================

test('AE4: what GET /:id ACTUALLY returns', async () => {
  // The pre-3.1 code asked for populate("category", "name description price").
  // `description` and `price` are not Category fields, so it returned only
  // `name`. Since 3.1 the bridge returns the whole category. Enumerated here
  // from the response so 3.2 preserves what the CLIENT sees.
  const id = await store.createDonation({ tag: 'detail', userId: ownerId });

  const res = await get(`/api/donations/${id}`, ownerToken);
  assert.equal(res.status, 200);

  assert.equal(res.body._id, id);
  assert.deepEqual(Object.keys(res.body.userId).sort(), ['_id', 'email', 'name']);
  assert.equal(typeof res.body.category.name, 'string');
  assert.equal(typeof res.body.category.donationAmount, 'number');
  assert.equal(typeof res.body.amount, 'number');
  assert.equal(typeof res.body.paymentStatus, 'string');
});

test('GET /:id on a malformed id is a 404 now, not a 500 (CHANGED IN 3.3)', async () => {
  // WAS: 500 with a generic body - this handler did not leak the detail, but it
  // still reported a caller's malformed input as a server fault. AD1b checks
  // the id shape before dispatch.
  const res = await get('/api/donations/not-an-objectid', adminToken);
  assertRefused(res, 404);
});

// =============================================================================
// GET /stats/charts
// =============================================================================

test('stats/charts returns the documented shape and groups by category NAME', async () => {
  await store.resetDonations();
  const now = new Date();
  await store.createDonation({ tag: 'st1', amount: 1000, paymentStatus: 'Paid', date: now, userId: ownerId });
  await store.createDonation({ tag: 'st2', amount: 500, paymentStatus: 'Pending', date: now });

  const res = await get('/api/donations/stats/charts?period=monthly', adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['dateRange', 'period', 'stats']);

  const s = res.body.stats;
  assert.deepEqual(
    Object.keys(s).sort(),
    [
      'byCategory',
      'byStatus',
      'guestUsers',
      'paidAmount',
      'pendingAmount',
      'registeredUsers',
      'timeline',
      'totalAmount',
      'totalDonations',
    ]
  );

  assert.equal(s.totalDonations, 2);
  assert.equal(s.totalAmount, 1500);
  assert.equal(s.paidAmount, 1000);
  assert.equal(s.pendingAmount, 500);
  assert.equal(s.registeredUsers, 1);
  assert.equal(s.guestUsers, 1);

  // byCategory is keyed by the category NAME, which is why the bridge has to
  // resolve it - an unresolved category collapses every donation into
  // "Uncategorized".
  const catName = `${CAT_PREFIX} main`;
  assert.ok(s.byCategory[catName], 'grouped under the real category name');
  assert.equal(s.byCategory[catName].count, 2);
  assert.equal(s.byCategory[catName].amount, 1500);
  assert.equal(s.byCategory.Uncategorized, undefined);

  assert.ok(Array.isArray(s.timeline));
  assert.deepEqual(Object.keys(s.timeline[0]).sort(), ['amount', 'count', 'paidAmount', 'period']);
});

test('stats/charts defaults to the current month when period is absent or unknown', async () => {
  const res = await get('/api/donations/stats/charts?period=nonsense', adminToken);
  assert.equal(res.status, 200);
  const from = new Date(res.body.dateRange.from);
  assert.equal(from.getDate(), 1, 'defaults to the first of the current month');
  assert.deepEqual(res.body.stats.timeline, [], 'and an unknown period produces no timeline');
});

// =============================================================================
// AK3 / AM1 - a donation that exists in MONGODB and was never migrated
// =============================================================================

test('AK3: an UN-MIGRATED donation is ABSENT, and the ETL is what closes the gap', async () => {
  // ADR-056, which is the constraint this whole package sequence exists to
  // respect: A READ-THROUGH BRIDGE DOES NOT MAKE A ROUTE MIGRATION ADDITIVE.
  // The category bridge covers single-record reads; it never covered lists or
  // writes, which is how package 3.1 would have returned `[]` for every
  // production category. Donations are worse, because the admin console IS a
  // list.
  //
  // AM1: created HERE, after any ETL run, and asserted to have no MySQL row
  // BEFORE the endpoints are exercised. If it ever has one, the setup migrated
  // it and every assertion below is vacuous.
  await store.resetDonations();
  const legacyId = await store.createMongoOnlyDonation('unmigrated');

  assert.equal(
    await store.hasMysqlRow(legacyId),
    false,
    'SETUP ERROR: the AK3 fixture has a MySQL row, so it was migrated after all. ' +
      'Everything below would pass for the wrong reason.'
  );

  // The admin list does not contain it.
  const list = await get('/api/donations?page=1&limit=100', adminToken);
  assert.equal(list.status, 200);
  assert.equal(
    list.body.donations.some((d) => d._id === legacyId),
    false,
    'an un-migrated donation is INVISIBLE to the migrated list - not an error, absent'
  );

  // Nor can it be fetched by id. A clean 404, not a crash: the id is a
  // well-formed ObjectId, so the shape check passes and the lookup simply finds
  // nothing. That distinction matters - AC1 wants the MECHANISM, and "refused
  // because absent" is a different mechanism from "refused because malformed".
  const byId = await get(`/api/donations/${legacyId}`, adminToken);
  assert.notEqual(Math.floor(byId.status / 100), 5, `must not 500: ${byId.raw.slice(0, 160)}`);
  assertRefused(byId, 404);

  // And it cannot be updated, for the same reason.
  assertRefused(await put(`/api/donations/${legacyId}`, { status: 'Approved' }, adminToken), 404);
  assertRefused(
    await patch(`/api/donations/${legacyId}/status`, { status: 'approved' }, adminToken),
    404
  );

  // THE CONTROL. The identical donation, present in MySQL, IS visible - so the
  // assertions above are about MIGRATION STATE and not about some unrelated
  // filter quietly excluding the fixture.
  const migrated = await store.createDonation({ tag: 'unmigrated-control' });
  const control = await get('/api/donations?page=1&limit=100', adminToken);
  assert.equal(
    control.body.donations.some((d) => d._id === migrated),
    true,
    'CONTROL FAILED: a MySQL donation is missing too, so the test above proves nothing'
  );
});
