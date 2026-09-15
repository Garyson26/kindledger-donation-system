/**
 * =============================================================================
 * CHARACTERISATION tests for routes/categories.js  (SPEC-3 package 3.1)
 * =============================================================================
 *   docker run -d --name kl-mongo -p 27017:27017 mongo:7
 *   npm run test:categories
 *
 * WHAT A CHARACTERISATION TEST IS, AND WHAT IT IS NOT.
 *
 * These capture what this route file does TODAY, against Mongoose, before any
 * migration. They are NOT a specification of what it should do. Where the
 * current behaviour is wrong, the wrong behaviour is asserted, marked
 * `QUIRK`, and cross-referenced to the finding that will change it.
 *
 * The purpose is to make the migration provably behaviour-preserving. After
 * package 3.1 rewrites this file against the repositories, these same tests
 * must still pass - so any difference is a DECISION someone made, visible as an
 * edit to this file, rather than an accident nobody noticed.
 *
 * SEAM SWITCHED IN PACKAGE 3.1. `store` now reads and writes MySQL through the
 * repositories; the scenarios below were written against MongoDB and are
 * unchanged except where the behaviour deliberately changed. Every such edit is
 * marked `CHANGED IN 3.1` with the finding that caused it, which is the whole
 * point of writing these before the migration rather than after.
 *
 * Nine assertions changed. Eight are findings being closed; one is ADR-004's
 * soft delete, which is a behaviour change users can see. Thirteen scenarios
 * passed untouched, which is the evidence that the migration preserved
 * behaviour everywhere it was supposed to.
 *
 * AC1: EVERY REFUSAL ASSERTS THE MECHANISM, NOT ONLY THE OUTCOME.
 * Status code, response shape, and that nothing 500'd. An assertion that only
 * checks "the category was not created" cannot tell a clean 400 from a crash
 * before the decision was reached - which is exactly how SEC-14 hid behind a
 * green test.
 *
 * PORTABILITY. All storage access goes through the `store` seam, as in the two
 * existing suites. Assertions are on HTTP responses and on the normalised view
 * `store` returns. Nothing reaches into Mongoose internals, so package 3.1
 * reimplements `store` and leaves the scenarios alone.
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
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_cat_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// Donation and User are STILL MongoDB - they migrate in packages 3.2 and 3.4.
const Donation = require('../models/Donation');
const User = require('../models/User');
// Categories are MySQL from package 3.1 onwards.
const categories = require('../repositories/categories');
const prismaModule = require('../config/prisma');
// Package 3.1r: the Mongoose model and the ETL, so this suite can exercise
// categories that existed BEFORE the migration - which is the case ADR-056
// found, and which 22 green scenarios had never touched.
const MongoCategory = require('../models/Category');
const { runMigration } = require('../etl/migrate');

const NAME_PREFIX = 'ZZZ CAT TEST';
const EMAIL_PREFIX = 'zzz-cat-test';

let server;
let base;
let adminToken;
let userToken;

const uniqueName = (tag) =>
  `${NAME_PREFIX} ${tag} ${crypto.randomBytes(3).toString('hex')}`;

// -----------------------------------------------------------------------------
// Storage seam. Package 3.1 reimplements these against the repositories.
// -----------------------------------------------------------------------------
const store = {
  /**
   * Clear the DATA a scenario creates, leaving the fixture users alone.
   *
   * The split matters. An earlier version of this seam deleted the fixture
   * users too, and because several scenarios call it mid-suite, adminAuth then
   * answered `404 User not found` - failing twelve scenarios with a cause that
   * had nothing to do with the routes under test. The tests were wrong, not
   * the code.
   */
  async resetData() {
    await Donation.deleteMany({ donorEmail: new RegExp('^' + EMAIL_PREFIX) });
    await categories.deleteByNamePrefix(NAME_PREFIX);
    await MongoCategory.deleteMany({ name: new RegExp('^' + NAME_PREFIX) });
    // MySQL users too. `store.runEtl()` migrates every entity, not just
    // categories, so MySQL user rows accumulate across runs - and because
    // `createUser` mints a FRESH ObjectId each time, the next ETL sees a new
    // legacy_id for an email that already exists and collides on
    // uq_users_email. Found by the AM1 injection, which failed on that
    // collision instead of on the assertion it was meant to prove.
    await require('../repositories/users').deleteByEmailPrefix(EMAIL_PREFIX);
  },

  /** Everything, including the fixture users. Teardown only. */
  async resetAll() {
    await this.resetData();
    await User.deleteMany({ email: new RegExp('^' + EMAIL_PREFIX) });
  },

  /**
   * Normalised view, by EXTERNAL id (the 24-hex ObjectId - see ADR-051).
   *
   * `isArchived` is new to this shape and is what makes ADR-004's soft delete
   * observable: the row is still there, which is the behaviour change.
   */
  async readCategory(externalId) {
    if (!externalId) return null;
    const row = await categories.findByLegacyId(String(externalId));
    if (!row) return null;
    return {
      id: row.legacyId,
      uuid: row.id,
      name: row.name,
      sortDescription: row.shortDescription,
      donationAmount: row.donationAmountMinor / 100,
      descriptions: [...row.descriptions],
      displayOrder: row.displayOrder,
      isArchived: row.isArchived,
    };
  },

  async readCategoryByName(name) {
    const row = await categories.findByName(name);
    return row ? this.readCategory(row.legacyId) : null;
  },

  async countCategories() {
    const all = await categories.list({ includeArchived: true });
    return all.filter((c) => c.name.startsWith(NAME_PREFIX)).length;
  },

  /** Mints an ObjectId-shaped legacy id, exactly as the route does. */
  async createCategoryDirect({ name, donationAmount = 1500, displayOrder = 0, descriptions = [] }) {
    const legacyId =
      Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
      crypto.randomBytes(8).toString('hex');
    const row = await categories.create({
      name,
      legacyId,
      shortDescription: 'fixture',
      donationAmountMinor: Math.round(donationAmount * 100),
      displayOrder,
      descriptions,
    });
    return row.legacyId;
  },

  /**
   * A donation pointing at a category.
   *
   * STILL MongoDB - donations migrate in 3.2. It references the category by its
   * ObjectId-shaped legacy id, which is precisely why ADR-051 keeps that as the
   * external identifier: `Donation.category` is a required ObjectId ref, so a
   * uuid here would fail to save.
   */
  async createDonationForCategory(categoryExternalId, tag) {
    const doc = await Donation.create({
      donorName: 'ZZZ Cat Test Donor',
      donorEmail: `${EMAIL_PREFIX}-${tag}@invalid.test`,
      amount: 1500,
      category: categoryExternalId,
      quantity: 1,
    });
    return doc._id.toString();
  },

  async readDonationCategoryRef(donationId) {
    const doc = await Donation.findById(donationId);
    if (!doc) return null;
    return doc.category ? doc.category.toString() : null;
  },

  /**
   * A category in MONGODB ONLY - the state every production category is in.
   *
   * Not routed through the repositories on purpose: the whole point is a record
   * the new store has never seen.
   */
  async createMongoCategory(name, { donationAmount = 1500, descriptions = [] } = {}) {
    const doc = await MongoCategory.create({
      name,
      sortDescription: 'from mongo',
      donationAmount,
      descriptions,
      displayOrder: 0,
    });
    return doc._id.toString();
  },

  /** Run the real ETL. Not a stub - the thing 3.1r depends on. */
  async runEtl() {
    return runMigration({
      prisma: prismaModule.getPrisma(),
      models: {
        User: require('../models/User'),
        Category: MongoCategory,
        Donation: require('../models/Donation'),
        PendingSignup: require('../models/PendingSignup'),
      },
    });
  },

  /** Does this ObjectId have a MySQL row? AM1's control depends on it. */
  async hasMysqlRow(legacyId) {
    return Boolean(await categories.findByLegacyId(String(legacyId)));
  },

  async clearMongoCategories() {
    await MongoCategory.deleteMany({ name: new RegExp('^' + NAME_PREFIX) });
  },

  async createUser(role, tag) {
    const email = `${EMAIL_PREFIX}-${tag}@invalid.test`;
    await User.deleteOne({ email });
    const doc = await User.create({
      name: 'ZZZ Cat Test ' + role,
      email,
      password: await bcrypt.hash('FixturePass123!', 10),
      role,
      isVerified: true,
    });
    return doc._id.toString();
  },
};

// -----------------------------------------------------------------------------
// HTTP helpers. Every one returns the status AND the parsed body, because AC1
// requires the mechanism to be asserted and not just the effect.
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

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, raw: text };
}

const post = (p, body, token) => call('POST', p, { body, token });
const put = (p, body, token) => call('PUT', p, { body, token });
const del = (p, token) => call('DELETE', p, { token });
const get = (p, token) => call('GET', p, { token });

/**
 * AC1's assertion helper.
 *
 * A refusal must be a DECISION, not a crash. 5xx means the handler threw before
 * deciding anything, which leaves the same visible state as a correct refusal
 * and is why SEC-14 stayed hidden behind a passing test.
 */
function assertRefused(res, expectedStatus, { errorKey = 'error' } = {}) {
  assert.notEqual(
    Math.floor(res.status / 100),
    5,
    `expected a decision, got ${res.status} - the handler threw rather than refusing: ${res.raw.slice(0, 200)}`
  );
  assert.equal(res.status, expectedStatus, `status: ${res.raw.slice(0, 200)}`);
  assert.ok(res.body, 'a refusal must carry a JSON body');
  assert.equal(typeof res.body[errorKey], 'string', `refusal must name a reason in "${errorKey}"`);
}

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
}

before(async () => {
  await assertMongoReachable();
  assert.ok(
    process.env.DATABASE_URL,
    'Categories are MySQL from package 3.1. DATABASE_URL must point at a schema-applied MySQL 8.4.'
  );
  const probe = await require('../repositories').checkDatabase();
  assert.equal(probe.ok, true, `MySQL unreachable: ${probe.error}`);

  const app = require('../app.js');
  for (let i = 0; i < 100 && mongoose.connection.readyState !== 1; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(mongoose.connection.readyState, 1, 'mongoose did not reach a connected state');

  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  await store.resetAll();
  const adminId = await store.createUser('admin', 'admin');
  const userId = await store.createUser('user', 'plain');
  adminToken = jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  userToken = jwt.sign({ userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
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

test('the four mutating routes require an admin token; GET does not', async () => {
  const id = await store.createCategoryDirect({ name: uniqueName('authz') });

  const guarded = [
    ['POST', '/api/categories', {}],
    ['PUT', '/api/categories/reorder', { categories: [] }],
    ['PUT', `/api/categories/${id}`, {}],
    ['DELETE', `/api/categories/${id}`, undefined],
  ];

  for (const [method, path, body] of guarded) {
    const anon = await call(method, path, { body });
    assertRefused(anon, 401, { errorKey: 'message' });

    const nonAdmin = await call(method, path, { body, token: userToken });
    assertRefused(nonAdmin, 403, { errorKey: 'message' });
  }

  // GET is deliberately public - the category list drives the donation form.
  const open = await get('/api/categories');
  assert.equal(open.status, 200);
});

// =============================================================================
// POST /api/categories
// =============================================================================

test('POST creates a category and returns the whole document', async () => {
  const name = uniqueName('create');
  const res = await post(
    '/api/categories',
    { name, sortDescription: 'Reef restoration', donationAmount: 1500, descriptions: ['a', 'b'] },
    adminToken
  );

  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Category added successfully');

  // The response embeds the persisted document, including its storage id.
  // Recorded because the frontend reads `category._id` and package 3.1 must
  // keep an `_id` key present even though MySQL's external identifier is a uuid.
  const returned = res.body.category;
  assert.ok(returned._id, 'response carries _id');
  assert.equal(returned.name, name);
  assert.equal(returned.sortDescription, 'Reef restoration');
  assert.equal(returned.donationAmount, 1500);
  assert.deepEqual(returned.descriptions, ['a', 'b']);

  const persisted = await store.readCategoryByName(name);
  assert.equal(persisted.donationAmount, 1500);
  assert.deepEqual(persisted.descriptions, ['a', 'b'], 'description order is preserved');
});

test('POST rejects a missing field with 400 and a reason', async () => {
  const complete = {
    name: uniqueName('missing'),
    sortDescription: 's',
    donationAmount: 1500,
    descriptions: ['d'],
  };

  for (const omitted of ['name', 'sortDescription', 'donationAmount', 'descriptions']) {
    const body = { ...complete };
    delete body[omitted];
    const res = await post('/api/categories', body, adminToken);
    assertRefused(res, 400);
    assert.equal(res.body.error, 'All fields are required', `omitting ${omitted}`);
  }

  // Scoped to the name actually attempted, not a global count - other
  // scenarios legitimately leave categories behind, and an earlier version of
  // this assertion counted those and failed for it.
  assert.equal(
    await store.readCategoryByName(complete.name),
    null,
    'the refused category was not created'
  );
});

test('donationAmount 0 is refused, and now says WHY (CHANGED IN 3.1, AD3)', async () => {
  // WAS: refused with "All fields are required", because the check was
  // `!donationAmount` and 0 is falsy. The field HAD been supplied, so the
  // stated reason was untrue and a free category was impossible.
  //
  // NOW: presence is checked with `=== undefined`, and the amount is validated
  // separately. Still a 400 - `ck_categories_amount_positive` would refuse it
  // anyway, and catching it here keeps that a 400 naming the field instead of a
  // 500 from a constraint violation.
  const res = await post(
    '/api/categories',
    { name: uniqueName('zero'), sortDescription: 's', donationAmount: 0, descriptions: ['d'] },
    adminToken
  );
  assertRefused(res, 400);
  assert.match(res.body.error, /greater than zero/);
});

test('QUIRK: an empty descriptions array IS accepted, unlike every other field', async () => {
  // `[]` is truthy, so it passes the same falsiness check that rejects 0.
  // The field is "required" in the sense that the key must be present, not that
  // it must contain anything.
  const name = uniqueName('emptydesc');
  const res = await post(
    '/api/categories',
    { name, sortDescription: 's', donationAmount: 1500, descriptions: [] },
    adminToken
  );
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.deepEqual((await store.readCategoryByName(name)).descriptions, []);
});

test('POST refuses a duplicate name with 400, and does not create a second row', async () => {
  const name = uniqueName('dupe');
  const first = await post(
    '/api/categories',
    { name, sortDescription: 's', donationAmount: 1500, descriptions: ['d'] },
    adminToken
  );
  assert.equal(first.status, 200);

  const second = await post(
    '/api/categories',
    { name, sortDescription: 'different', donationAmount: 9999, descriptions: ['x'] },
    adminToken
  );
  assertRefused(second, 400);
  assert.equal(second.body.error, 'Category already exists');

  const still = await store.readCategoryByName(name);
  assert.equal(still.donationAmount, 1500, 'the original is untouched');
});

test('displayOrder is assigned as max+1, starting at 0 in an EMPTY table', async () => {
  // Note the asymmetry, which is current behaviour: the FIRST category in an
  // empty table gets 0, and every subsequent one gets (highest + 1). So a
  // collection created through this endpoint runs 0, 1, 2...
  //
  // CHANGED IN 3.3, AND THE REASON MATTERS MORE THAN THE EDIT.
  //
  // This asserted the literal values 0, 1, 2, which held only while the suite
  // had the store to itself. Against MySQL every suite shares ONE database -
  // with each other and with whatever is loaded locally - so package 3.3's ETL
  // run put two categories in the table and `max+1` stopped being 0. The suite
  // was reading data it does not own.
  //
  // The RULE is `max+1`, and the literal 0 was incidental to an empty table. It
  // is still asserted, but only when the table is actually empty, which is the
  // only condition under which it was ever a claim about the code.
  await store.resetData();
  // The TRUE table count, not `store.countCategories()` - that one filters to
  // this suite's own name prefix, which would report an empty table while two
  // rows sat in it and reintroduce exactly the assumption being removed.
  const baseline = await categories.count();
  const mk = async (tag) => {
    const name = uniqueName(tag);
    const r = await post(
      '/api/categories',
      { name, sortDescription: 's', donationAmount: 1500, descriptions: ['d'] },
      adminToken
    );
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    return store.readCategoryByName(name);
  };

  const first = (await mk('order1')).displayOrder;
  const second = (await mk('order2')).displayOrder;
  const third = (await mk('order3')).displayOrder;

  if (baseline === 0) {
    assert.equal(first, 0, 'the first category in an EMPTY table gets 0');
  }
  assert.equal(second, first + 1, 'each subsequent category is max+1');
  assert.equal(third, second + 1, 'and they stay consecutive');
});

// =============================================================================
// GET /api/categories
// =============================================================================

test('GET returns a BARE ARRAY without pagination, and an OBJECT with it', async () => {
  // The response shape depends on the query string. This is the single most
  // important thing for 3.1 to preserve: a client reading `res.data.length`
  // breaks the moment it receives the paginated object, and vice versa.
  await store.resetData();
  const ids = [];
  for (const tag of ['s1', 's2', 's3']) {
    ids.push(await store.createCategoryDirect({ name: uniqueName(tag), displayOrder: ids.length }));
  }

  const bare = await get('/api/categories');
  assert.equal(bare.status, 200);
  assert.ok(Array.isArray(bare.body), 'no pagination params -> a bare array');

  const paged = await get('/api/categories?page=1&limit=2');
  assert.equal(paged.status, 200);
  assert.equal(Array.isArray(paged.body), false, 'with pagination -> an object');
  assert.ok(Array.isArray(paged.body.categories));
  assert.deepEqual(Object.keys(paged.body.pagination).sort(), [
    'limit',
    'page',
    'pages',
    'total',
  ]);
  assert.equal(paged.body.categories.length, 2);
});

test('GET sorts by displayOrder ascending', async () => {
  await store.resetData();
  const a = uniqueName('sortA');
  const b = uniqueName('sortB');
  const c = uniqueName('sortC');
  await store.createCategoryDirect({ name: c, displayOrder: 2 });
  await store.createCategoryDirect({ name: a, displayOrder: 0 });
  await store.createCategoryDirect({ name: b, displayOrder: 1 });

  const res = await get('/api/categories');
  const mine = res.body.filter((x) => x.name.startsWith(NAME_PREFIX)).map((x) => x.name);
  assert.deepEqual(mine, [a, b, c]);
});

test('BUG-08: limit is CLAMPED, not used verbatim (CHANGED IN 3.1)', async () => {
  // WAS: `?limit=100000` was passed straight through and streamed the table.
  // NOW: clamped to MAX_PAGE_SIZE. The request still succeeds - clamping rather
  // than refusing, because a client asking for too much wants as much as it can
  // have, and a 400 here would break the admin list for no security gain.
  await store.resetData();
  for (const tag of ['p1', 'p2', 'p3']) {
    await store.createCategoryDirect({ name: uniqueName(tag) });
  }

  const res = await get('/api/categories?page=1&limit=100000');
  assert.equal(res.status, 200);
  assert.equal(res.body.pagination.limit, 100, 'clamped to the maximum page size');
  assert.ok(res.body.categories.length >= 3);
});

test('BUG-08: a non-numeric limit is a clean 400 (CHANGED IN 3.1)', async () => {
  // WAS: `parseInt('abc')` gave NaN, which flowed into skip/limit and into
  // Math.ceil(total / NaN). The client got a 200 with nulls in the pagination
  // block - a success response describing nothing.
  // NOW: refused, with the reason.
  //
  // The edit to this test is the record that the change was deliberate. That is
  // what writing it before the migration bought.
  await store.resetData();
  await store.createCategoryDirect({ name: uniqueName('nan') });

  const res = await get('/api/categories?page=abc&limit=abc');
  assertRefused(res, 400);
  assert.match(res.body.error, /positive integers/);
});

// =============================================================================
// PUT /api/categories/reorder
// =============================================================================

test('reorder updates displayOrder and returns only a message', async () => {
  await store.resetData();
  const first = await store.createCategoryDirect({ name: uniqueName('r1'), displayOrder: 0 });
  const second = await store.createCategoryDirect({ name: uniqueName('r2'), displayOrder: 1 });

  const res = await put(
    '/api/categories/reorder',
    { categories: [{ id: first, displayOrder: 5 }, { id: second, displayOrder: 4 }] },
    adminToken
  );

  assert.equal(res.status, 200, res.raw.slice(0, 200));
  // CHANGED IN 3.1. WAS: `{ message }` and nothing else, so a caller had no way
  // to know whether anything had actually been reordered. NOW: `updated` and
  // `skipped` as well, which is what makes the skip-instead-of-500 behaviour
  // above observable rather than silent. Additive, so a client reading only
  // `message` is unaffected.
  assert.deepEqual(Object.keys(res.body).sort(), ['message', 'skipped', 'updated']);
  assert.equal(res.body.updated, 2);
  assert.equal(res.body.skipped, 0);
  assert.equal((await store.readCategory(first)).displayOrder, 5);
  assert.equal((await store.readCategory(second)).displayOrder, 4);
});

test('reorder refuses a non-array payload with 400', async () => {
  for (const payload of [{}, { categories: 'nope' }, { categories: null }]) {
    const res = await put('/api/categories/reorder', payload, adminToken);
    assertRefused(res, 400);
    assert.equal(res.body.error, 'Invalid categories data');
  }
});

test('reorder is STILL NOT ATOMIC, but a bad id no longer 500s (CHANGED IN 3.1, AD3)', async () => {
  // TWO SEPARATE THINGS, AND ONLY ONE WAS FIXED.
  //
  // WAS: a malformed id raised a CastError, so the request 500'd - while the
  // valid updates in the same batch had already been written.
  //
  // NOW: the id is validated by shape before use, so an unresolvable entry is
  // SKIPPED and counted, and the endpoint answers 200 describing what it did.
  // That is AD1(b) and it closes the crash.
  //
  // STILL OPEN, DELIBERATELY (AD3): the batch is not atomic. Wrapping it in
  // withTransaction is the correct fix and belongs with the rest of the
  // transaction work, not smuggled into this package. The assertion below
  // pins the partial write so that when it IS fixed, this test fails and
  // someone has to edit it on purpose.
  await store.resetData();
  const good = await store.createCategoryDirect({ name: uniqueName('atomic'), displayOrder: 0 });

  const res = await put(
    '/api/categories/reorder',
    { categories: [{ id: good, displayOrder: 7 }, { id: 'not-an-objectid', displayOrder: 8 }] },
    adminToken
  );

  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.updated, 1);
  assert.equal(res.body.skipped, 1, 'the unresolvable entry is reported, not silently dropped');
  assert.equal(
    (await store.readCategory(good)).displayOrder,
    7,
    'the valid write is applied - the batch is still not atomic'
  );
});

// =============================================================================
// PUT /api/categories/:id
// =============================================================================

test('PUT updates the four editable fields and returns the new document', async () => {
  const id = await store.createCategoryDirect({
    name: uniqueName('upd'),
    donationAmount: 1000,
    descriptions: ['old'],
  });
  const newName = uniqueName('updated');

  const res = await put(
    `/api/categories/${id}`,
    { name: newName, sortDescription: 'new short', donationAmount: 2500, descriptions: ['x', 'y'] },
    adminToken
  );

  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Category updated successfully');
  assert.equal(res.body.category.name, newName);

  const after = await store.readCategory(id);
  assert.equal(after.donationAmount, 2500);
  assert.deepEqual(after.descriptions, ['x', 'y']);
});

test('BUG-09: a partial PUT no longer wipes descriptions (CHANGED IN 3.1, AD3)', async () => {
  // WAS: `updateData` set `descriptions: descriptions || []` unconditionally,
  // so `{ donationAmount: 3000 }` - exactly what the edit-price form sends -
  // cleared the list. Data loss, no error, and nobody would connect the two
  // events.
  // NOW: only the keys the caller supplied are assigned.
  const id = await store.createCategoryDirect({
    name: uniqueName('wipe'),
    descriptions: ['keep me', 'and me'],
  });

  const res = await put(`/api/categories/${id}`, { donationAmount: 3000 }, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));

  const after = await store.readCategory(id);
  assert.deepEqual(after.descriptions, ['keep me', 'and me'], 'the descriptions survive');
  assert.equal(after.donationAmount, 3000, 'and the supplied field was applied');

  // An explicit empty array still clears them - "omitted" and "set to empty"
  // are different requests and must stay so.
  const cleared = await put(`/api/categories/${id}`, { descriptions: [] }, adminToken);
  assert.equal(cleared.status, 200);
  assert.deepEqual((await store.readCategory(id)).descriptions, []);
});

test('PUT on an unknown but well-formed id is a clean 404', async () => {
  const missing = new mongoose.Types.ObjectId().toString();
  const res = await put(
    `/api/categories/${missing}`,
    { name: uniqueName('ghost'), sortDescription: 's', donationAmount: 1, descriptions: [] },
    adminToken
  );
  assertRefused(res, 404);
  assert.equal(res.body.error, 'Category not found');
});

test('a MALFORMED id is now a 404, like any other unknown id (CHANGED IN 3.1, AD1b)', async () => {
  // WAS: a 500. The cast threw before the not-found branch, so the two shapes
  // of "no such category" gave two different statuses - and the one an attacker
  // could trigger trivially was the crash. The SEC-14 shape.
  // NOW: the id is validated by shape and an unrecognised one is simply absent.
  const res = await put(
    '/api/categories/not-an-objectid',
    { name: uniqueName('bad'), sortDescription: 's', donationAmount: 1, descriptions: [] },
    adminToken
  );
  assertRefused(res, 404);
  assert.equal(res.body.error, 'Category not found');
});

test('SEC-19: no internal error text reaches the client (CHANGED IN 3.1)', async () => {
  // WAS: `res.status(500).json({ error: err.message })` on every handler, so
  // the client received "Cast to ObjectId failed for value ..." with the field
  // name and the offending value.
  // NOW: a generic message with the right status; the detail goes to the log.
  const probes = [
    await put(
      '/api/categories/not-an-objectid',
      { name: uniqueName('leak'), sortDescription: 's', donationAmount: 1, descriptions: [] },
      adminToken
    ),
    await del('/api/categories/not-an-objectid', adminToken),
    await post(
      '/api/categories',
      { name: uniqueName('leak2'), sortDescription: 's', donationAmount: 'abc', descriptions: [] },
      adminToken
    ),
  ];

  for (const res of probes) {
    assert.equal(typeof res.body.error, 'string');
    assert.doesNotMatch(res.body.error, /Cast to|ObjectId|Prisma|mongo/i, res.body.error);
  }
});

// =============================================================================
// DELETE /api/categories/:id
// =============================================================================

test('DELETE now ARCHIVES rather than removing (CHANGED IN 3.1, ADR-004)', async () => {
  // THE ONE BEHAVIOUR CHANGE A USER COULD NOTICE, so it is asserted from both
  // sides: gone from the list, still present in the data.
  //
  // The response message is deliberately unchanged - to the admin clicking
  // Delete, the category has gone, which is what they meant.
  const id = await store.createCategoryDirect({ name: uniqueName('del') });

  const res = await del(`/api/categories/${id}`, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Category deleted successfully');

  const after = await store.readCategory(id);
  assert.ok(after, 'WAS: the row was gone. NOW: it is retained');
  assert.equal(after.isArchived, true);

  const listed = await get('/api/categories');
  assert.equal(
    listed.body.some((c) => c._id === id),
    false,
    'and it no longer appears in the list, which is what "deleted" means to the user'
  );
});

test('DELETE on an unknown id is a clean 404', async () => {
  const missing = new mongoose.Types.ObjectId().toString();
  const res = await del(`/api/categories/${missing}`, adminToken);
  assertRefused(res, 404);
  assert.equal(res.body.error, 'Category not found');
});

test('QUIRK: deleting a category REFERENCED BY A DONATION succeeds and orphans the reference', async () => {
  // The migration risk in this file, and the reason this scenario exists.
  //
  // MongoDB has no referential integrity here, so the delete succeeds and the
  // donation is left holding a category id that resolves to nothing. Every
  // report that populates `category` then sees null for those rows.
  //
  // MySQL CANNOT reproduce this: donations.category_id is NOT NULL with
  // ON DELETE RESTRICT (db/schema.sql), so the same delete would be refused by
  // the database. ADR-004's soft delete is what makes the two compatible - the
  // category stays present and referenceable, and disappears only from the
  // active list.
  //
  // So this assertion IS expected to change in this package. It is here to
  // prove the change was deliberate and to record what the old behaviour did
  // to the data, because Phase 4's ETL will encounter donations whose category
  // was deleted this way and has to decide what to do with them.
  const catId = await store.createCategoryDirect({ name: uniqueName('orphan') });
  const donationId = await store.createDonationForCategory(catId, 'orphan');

  const res = await del(`/api/categories/${catId}`, adminToken);
  assert.equal(res.status, 200, 'the delete is still allowed');

  // WAS: readCategory(catId) was null and the donation held a dangling id, so
  // every report that populated the category saw null for those rows.
  // NOW: the category is archived and still resolvable, so the financial record
  // keeps the category that priced it. This is the substance of ADR-004 and the
  // reason MySQL can enforce ON DELETE RESTRICT without breaking the admin's
  // ability to retire a category.
  const stillThere = await store.readCategory(catId);
  assert.ok(stillThere, 'the category is retained');
  assert.equal(stillThere.isArchived, true);
  assert.equal(await store.readDonationCategoryRef(donationId), catId);

  // And the bridge still resolves it for the unmigrated readers, so an old
  // donation's receipt does not lose its category.
  const bridge = require('../services/categoryBridge');
  const resolved = await bridge.resolveCategory(catId);
  assert.ok(resolved, 'an archived category still resolves for historical records');
  assert.equal(resolved._source, 'mysql');
});

// =============================================================================
// Package 3.1r - PRE-EXISTING categories (ADR-056)
// =============================================================================
// THE SCENARIOS THIS SUITE WAS MISSING, and their absence is why 22 green tests
// did not notice that `GET /api/categories` returned `[]` for every real
// category.
//
// Every fixture above is created through the seam, which after the 3.1 switch
// writes to MySQL - so the suite migrated its own data along with the route and
// then asserted the route works on it. These exercise the other case: a record
// that existed in MongoDB first.
// =============================================================================

test('3.1r: a category that existed in MONGODB BEFORE the ETL is fully usable', async () => {
  // The exact case ADR-056 found. Not a category this suite created after the
  // switch - one that was in the old store, migrated by the real ETL, and is
  // then listed, updated and deleted through the migrated route.
  await store.resetData();

  const name = uniqueName('preexisting');
  const legacyId = await store.createMongoCategory(name, {
    donationAmount: 2500,
    descriptions: ['written', 'in', 'mongo'],
  });

  // Before the ETL it is invisible to the migrated route. Asserted rather than
  // assumed, because this is the defect being closed and it must be shown to
  // have existed.
  assert.equal(await store.hasMysqlRow(legacyId), false, 'no MySQL row yet');
  const before = await get('/api/categories');
  assert.equal(
    before.body.some((c) => c._id === legacyId),
    false,
    'BEFORE the ETL: not listed - this is ADR-056'
  );

  // The ETL is the mechanism. Run the real one.
  const stats = await store.runEtl();
  assert.ok(stats.loaded.categories >= 1, 'the ETL loaded it');
  assert.equal(await store.hasMysqlRow(legacyId), true, 'AFTER the ETL: a MySQL row exists');

  // LISTED, with the migrated data.
  const listed = await get('/api/categories');
  const found = listed.body.find((c) => c._id === legacyId);
  assert.ok(found, 'AFTER the ETL: listed by GET /api/categories');
  assert.equal(found.name, name);
  assert.equal(found.donationAmount, 2500, 'the MIGRATED amount, in major units');
  assert.deepEqual(found.descriptions, ['written', 'in', 'mongo'], 'and the migrated array');

  // UPDATABLE by its original ObjectId - the id every existing client holds.
  const updated = await put(`/api/categories/${legacyId}`, { donationAmount: 3000 }, adminToken);
  assert.equal(updated.status, 200, updated.raw.slice(0, 160));
  assert.equal((await store.readCategory(legacyId)).donationAmount, 3000);
  assert.deepEqual(
    (await store.readCategory(legacyId)).descriptions,
    ['written', 'in', 'mongo'],
    'and BUG-09 still holds for a migrated row'
  );

  // DELETABLE - archived, per ADR-004.
  const deleted = await del(`/api/categories/${legacyId}`, adminToken);
  assert.equal(deleted.status, 200, deleted.raw.slice(0, 160));
  assert.equal((await store.readCategory(legacyId)).isArchived, true);
});

test('3.1r/AK3: an UN-MIGRATED category is absent, and the ETL is what closes the gap', async () => {
  // AM1 MAKES THIS STRUCTURAL RATHER THAN PROCEDURAL.
  //
  // The fixture is created AFTER the ETL run, so no hook ordering can migrate
  // it - and the assertion below verifies that positively rather than trusting
  // the ordering. If it ever has a MySQL row, the SETUP is wrong and this suite
  // must fail loudly instead of passing quietly, which is exactly the failure
  // mode ADR-056 was.
  await store.resetData();

  // Something for the ETL to do, so the run is real.
  await store.createMongoCategory(uniqueName('migrated'));
  await store.runEtl();

  // AFTER the ETL. This is the AK3 fixture.
  const orphanName = uniqueName('never-migrated');
  const orphanId = await store.createMongoCategory(orphanName);

  // THE CONTROL. Without it the ordering is a convention, and conventions get
  // reordered.
  assert.equal(
    await store.hasMysqlRow(orphanId),
    false,
    'SETUP ERROR: the AK3 fixture has a MySQL row, so it was migrated after all. ' +
      'The ordering in this test is wrong and every assertion below is vacuous.'
  );

  // The honest behaviour: it is not visible, and that is correct rather than a
  // defect. At cutover the application writes to MySQL, so a record in this
  // state should not exist - and if one does, running the ETL is the answer.
  const listed = await get('/api/categories');
  assert.equal(listed.body.some((c) => c._id === orphanId), false, 'not listed');
  assertRefused(await put(`/api/categories/${orphanId}`, { donationAmount: 1 }, adminToken), 404);
  assertRefused(await del(`/api/categories/${orphanId}`, adminToken), 404);

  // And the gap has exactly one cause. Running the ETL again closes it, which
  // proves the absence was un-migrated data and not something else.
  await store.runEtl();
  assert.equal(await store.hasMysqlRow(orphanId), true);
  const after = await get('/api/categories');
  assert.ok(after.body.some((c) => c._id === orphanId), 'the ETL is what closes the gap');
});

test('3.1r: the ETL is idempotent from the route suite too', async () => {
  // Five route packages will run it repeatedly. A second run inside a test
  // fixture must not duplicate rows or renumber display order.
  await store.resetData();
  const legacyId = await store.createMongoCategory(uniqueName('idem'));

  const first = await store.runEtl();
  assert.equal(first.loaded.categories, 1);
  const second = await store.runEtl();
  assert.equal(second.loaded.categories, 0);
  assert.equal(second.skipped.categories, 1);

  const listed = await get('/api/categories');
  assert.equal(
    listed.body.filter((c) => c._id === legacyId).length,
    1,
    'listed exactly once'
  );
});
