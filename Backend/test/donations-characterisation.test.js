/**
 * =============================================================================
 * CHARACTERISATION tests for routes/donations.js  (SPEC-3 package 3.2)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:donations
 *
 * These capture what this route file does TODAY, before the migration. Where
 * the current behaviour is wrong, the WRONG behaviour is asserted and marked
 * `QUIRK`, cross-referenced to the finding that will change it. Editing one of
 * these later is the record that a change was deliberate.
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
const bcrypt = require('bcryptjs');
const Donation = require('../models/Donation');
const User = require('../models/User');
const categories = require('../repositories/categories');
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

// -----------------------------------------------------------------------------
// Storage seam. Package 3.2 reimplements the Donation half against MySQL.
// -----------------------------------------------------------------------------
const store = {
  async resetDonations() {
    await Donation.deleteMany({ donorEmail: new RegExp('^' + TAG) });
  },

  async resetAll() {
    await this.resetDonations();
    await User.deleteMany({ email: new RegExp('^' + TAG) });
    await categories.deleteByNamePrefix(CAT_PREFIX);
  },

  async createCategory(name) {
    const legacyId =
      Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
      crypto.randomBytes(8).toString('hex');
    const row = await categories.create({
      name,
      legacyId,
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
    const doc = await Donation.create({
      donorName: 'ZZZ Donor ' + tag,
      donorEmail: `${TAG}-${tag}@invalid.test`,
      userId,
      category,
      quantity: 1,
      amount,
      status,
      paymentStatus,
      date,
      transactionId: uniq('txn'),
    });
    return doc._id.toString();
  },

  /** Normalised view; no storage types leak past here. */
  async readDonation(id) {
    let doc = null;
    try {
      doc = await Donation.findById(id);
    } catch {
      return null;
    }
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      donorEmail: doc.donorEmail,
      amount: doc.amount,
      status: doc.status,
      paymentStatus: doc.paymentStatus,
      userId: doc.userId ? doc.userId.toString() : null,
      category: doc.category ? doc.category.toString() : null,
    };
  },

  async createUser(role, tag) {
    const email = `${TAG}-${tag}@invalid.test`;
    await User.deleteOne({ email });
    const doc = await User.create({
      name: 'ZZZ Don Test ' + role,
      email,
      password: await bcrypt.hash('FixturePass123!', 10),
      role,
      isVerified: true,
    });
    return doc._id.toString();
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

test('QUIRK (BUG-01): POST /api/donations can NEVER succeed', async () => {
  // The handler builds a document with donorName, item, category and quantity.
  // The schema marks donorEmail and amount required, so every call fails
  // validation. The endpoint is dead; all real donations go through
  // /api/payment/initiate.
  //
  // It is a clean 400, not a 500: the catch block special-cases
  // `err.name === 'ValidationError'` and reports the field list. So the
  // endpoint refuses correctly and informatively - it just refuses
  // ALWAYS, for every possible request, which no status code can express.
  //
  // (An earlier draft of this test asserted a 5xx. PROJECT.md's BUG-01 entry
  // said 400 and was right; the assumption was mine.)
  const res = await post(
    '/api/donations',
    { item: 'Reef', category: categoryId, quantity: 1 },
    ownerToken
  );
  assertRefused(res, 400);
  assert.match(res.body.error, /Donation validation failed/);
  assert.match(res.body.error, /donorEmail/);
  assert.match(res.body.error, /amount/);
});

test('QUIRK (BUG-01): it fails the same way for a guest', async () => {
  const res = await post('/api/donations', { item: 'Reef', category: categoryId, quantity: 1 });
  assertRefused(res, 400);
  assert.match(res.body.error, /Donation validation failed/);
});

test('QUIRK (BUG-06): optionalAuth 401s a guest who holds an EXPIRED token', async () => {
  // "No header" is treated as guest, but any header present is delegated to
  // authMiddleware, which 401s an expired token instead of falling back to
  // guest. A donor whose session lapsed cannot submit as a guest either.
  const expired = jwt.sign({ userId: ownerId, role: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '-1h',
  });
  const res = await post(
    '/api/donations',
    { item: 'Reef', category: categoryId, quantity: 1 },
    expired
  );
  assertRefused(res, 401);
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
  const badStatus = await patch(                               // route handler
    `/api/donations/${id}/status`,
    { status: 'Approved' },
    adminToken
  );
  const malformed = await put('/api/donations/not-an-objectid', { status: 'x' }, adminToken);

  for (const [label, res] of [
    ['authMiddleware', noToken],
    ['adminAuth', nonAdmin],
    ['route handler', badStatus],
    ['route handler (500)', malformed],
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

test('QUIRK (BUG-08): GET / limit is uncapped and NaN passes through', async () => {
  await store.resetDonations();
  await store.createDonation({ tag: 'page' });

  const big = await get('/api/donations?page=1&limit=100000', adminToken);
  assert.equal(big.status, 200);
  assert.equal(big.body.pagination.limit, 100000, 'used verbatim');

  const nan = await get('/api/donations?page=abc&limit=abc', adminToken);
  assert.notEqual(Math.floor(nan.status / 100), 5, `must not 500: ${nan.raw.slice(0, 160)}`);
  assert.equal(nan.status, 200);
  assert.equal(nan.body.pagination.limit, null, 'NaN serialises as null');
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
  assert.equal(
    res.body.paymentStatuses.includes('Cancelled'),
    false,
    'a status nobody has used must NOT appear'
  );

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

test('QUIRK (SEC-16): PUT /:id writes ANY status string, bypassing the enum', async () => {
  // findByIdAndUpdate does not run validators by default, so the schema enum is
  // not enforced and any string lands in the field. This is the mechanism
  // behind BUG-02.
  const id = await store.createDonation({ tag: 'sec16' });

  const res = await put(`/api/donations/${id}`, { status: 'banana' }, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 160));
  assert.equal((await store.readDonation(id)).status, 'banana', 'CURRENT: anything is accepted');
});

test('QUIRK: PUT /:id on a MISSING donation returns 200 with donation:null', async () => {
  // There is no not-found branch at all. The caller is told "Donation updated"
  // for a donation that does not exist.
  const missing = new mongoose.Types.ObjectId().toString();
  const res = await put(`/api/donations/${missing}`, { status: 'Approved' }, adminToken);

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Donation updated');
  assert.equal(res.body.donation, null, 'CURRENT: a null donation with a success message');
});

test('QUIRK (SEC-19): PUT /:id leaks the internal error on a malformed id', async () => {
  const res = await put('/api/donations/not-an-objectid', { status: 'Approved' }, adminToken);
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Cast to ObjectId failed/);
});

test('QUIRK (BUG-02): PATCH /:id/status accepts ONLY lowercase, and writes it', async () => {
  // The schema enum is Pending|Approved|Rejected and the payment callbacks
  // write those. This endpoint accepts only "approved"/"rejected" and writes
  // them through findByIdAndUpdate, which does not validate - so the collection
  // ends up holding both casings and every status filter misses half the rows.
  const id = await store.createDonation({ tag: 'bug02' });

  const capitalised = await patch(`/api/donations/${id}/status`, { status: 'Approved' }, adminToken);
  assertRefused(capitalised, 400);
  assert.equal(capitalised.body.message, 'Invalid status');

  const lower = await patch(`/api/donations/${id}/status`, { status: 'approved' }, adminToken);
  assert.equal(lower.status, 200);
  assert.equal(
    (await store.readDonation(id)).status,
    'approved',
    'CURRENT: lowercase is written, corrupting the enum casing'
  );
});

test('PATCH /:id/status 404s a missing donation - unlike PUT', async () => {
  // Worth pinning side by side with the PUT case above: two endpoints doing the
  // same job disagree about what "not found" means.
  const missing = new mongoose.Types.ObjectId().toString();
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

test('GET /:id on a malformed id is a 500, not a 404', async () => {
  const res = await get('/api/donations/not-an-objectid', adminToken);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Failed to fetch donation', 'this one does NOT leak the detail');
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
