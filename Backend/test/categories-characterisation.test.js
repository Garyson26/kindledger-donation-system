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
 * Two of the assertions below are therefore expected to be edited in this same
 * package, deliberately and visibly: the soft-delete change (ADR-004) and the
 * pagination clamp (BUG-08). Those edits are the proof that the change happened
 * on purpose. Every other assertion must survive untouched.
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
const Category = require('../models/Category');
const Donation = require('../models/Donation');
const User = require('../models/User');

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
    await Category.deleteMany({ name: new RegExp('^' + NAME_PREFIX) });
    await Donation.deleteMany({ donorEmail: new RegExp('^' + EMAIL_PREFIX) });
  },

  /** Everything, including the fixture users. Teardown only. */
  async resetAll() {
    await this.resetData();
    await User.deleteMany({ email: new RegExp('^' + EMAIL_PREFIX) });
  },

  /** Normalised view. No storage types leak past here. */
  async readCategory(id) {
    if (!id) return null;
    let doc = null;
    try {
      doc = await Category.findById(id);
    } catch {
      return null; // A malformed id is "not found" as far as a caller cares.
    }
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      name: doc.name,
      sortDescription: doc.sortDescription,
      donationAmount: doc.donationAmount,
      descriptions: [...(doc.descriptions || [])],
      displayOrder: doc.displayOrder,
    };
  },

  async readCategoryByName(name) {
    const doc = await Category.findOne({ name });
    return doc ? this.readCategory(doc._id) : null;
  },

  async countCategories() {
    return Category.countDocuments({ name: new RegExp('^' + NAME_PREFIX) });
  },

  async createCategoryDirect({ name, donationAmount = 1500, displayOrder = 0, descriptions = [] }) {
    const doc = await Category.create({
      name,
      sortDescription: 'fixture',
      donationAmount,
      descriptions,
      displayOrder,
    });
    return doc._id.toString();
  },

  /** A donation pointing at a category, to probe referential behaviour. */
  async createDonationForCategory(categoryId, tag) {
    const doc = await Donation.create({
      donorName: 'ZZZ Cat Test Donor',
      donorEmail: `${EMAIL_PREFIX}-${tag}@invalid.test`,
      amount: 1500,
      category: categoryId,
      quantity: 1,
    });
    return doc._id.toString();
  },

  async readDonationCategoryRef(donationId) {
    const doc = await Donation.findById(donationId);
    if (!doc) return null;
    return doc.category ? doc.category.toString() : null;
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

test('QUIRK: donationAmount 0 is refused, because the check is falsiness not presence', async () => {
  // `if (!name || !descriptions || !sortDescription || !donationAmount)` treats
  // 0 as absent. A free category cannot be created, and the reason given is
  // "All fields are required", which is not what happened - the field was
  // supplied.
  //
  // Not in the finding list. Recorded here so the migration preserves it rather
  // than accidentally fixing it: `donation_amount_minor > 0` is a CHECK
  // constraint in db/schema.sql (ck_categories_amount_positive), so MySQL will
  // also refuse 0 - but with a 500 from a constraint violation instead of a
  // 400, unless 3.1 keeps an explicit check.
  const res = await post(
    '/api/categories',
    { name: uniqueName('zero'), sortDescription: 's', donationAmount: 0, descriptions: ['d'] },
    adminToken
  );
  assertRefused(res, 400);
  assert.equal(res.body.error, 'All fields are required');
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

test('displayOrder is assigned as max+1, starting at 0 for the first category', async () => {
  // Note the asymmetry, which is current behaviour: the FIRST category gets 0,
  // and every subsequent one gets (highest + 1). So a collection created
  // through this endpoint runs 0, 1, 2...
  await store.resetData();
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

  assert.equal((await mk('order1')).displayOrder, 0);
  assert.equal((await mk('order2')).displayOrder, 1);
  assert.equal((await mk('order3')).displayOrder, 2);
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

test('QUIRK (BUG-08): limit is uncapped, so one request can stream everything', async () => {
  await store.resetData();
  for (const tag of ['p1', 'p2', 'p3']) {
    await store.createCategoryDirect({ name: uniqueName(tag) });
  }

  const res = await get('/api/categories?page=1&limit=100000');
  assert.equal(res.status, 200);
  assert.equal(res.body.pagination.limit, 100000, 'the client-supplied limit is used verbatim');
  assert.ok(res.body.categories.length >= 3);
});

test('QUIRK (BUG-08): a non-numeric limit yields NaN in the pagination block', async () => {
  // `parseInt('abc')` is NaN. It flows into skip/limit and into
  // Math.ceil(total / NaN). JSON.stringify renders NaN as null, so the client
  // receives `{"page":null,"pages":null,"limit":null}` with a 200.
  //
  // Asserting the CURRENT behaviour, including that it does not 500 - which
  // matters, because after the BUG-08 fix this should become a 400 and that
  // will be a visible edit to this test rather than a silent change.
  await store.resetData();
  await store.createCategoryDirect({ name: uniqueName('nan') });

  const res = await get('/api/categories?page=abc&limit=abc');
  assert.notEqual(Math.floor(res.status / 100), 5, `must not 500: ${res.raw.slice(0, 200)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.pagination.limit, null, 'NaN serialises as null');
  assert.equal(res.body.pagination.pages, null);
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
  assert.deepEqual(Object.keys(res.body), ['message'], 'returns no data, only a message');
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

test('QUIRK: reorder is NOT atomic - a bad id mid-list leaves earlier writes applied', async () => {
  // Promise.all over independent findByIdAndUpdate calls. A malformed id
  // raises a CastError, so the request 500s - but the valid updates in the
  // same batch have already been written and are NOT rolled back.
  //
  // This is the case SPEC-2 section 4.4's transaction support exists for, and
  // 3.1 is expected to change it. Asserting the current partial-write
  // behaviour means that change has to be a visible edit here.
  await store.resetData();
  const good = await store.createCategoryDirect({ name: uniqueName('atomic'), displayOrder: 0 });

  const res = await put(
    '/api/categories/reorder',
    { categories: [{ id: good, displayOrder: 7 }, { id: 'not-an-objectid', displayOrder: 8 }] },
    adminToken
  );

  assert.equal(res.status, 500, 'today this is an unhandled cast error');
  assert.equal(
    (await store.readCategory(good)).displayOrder,
    7,
    'and the earlier write survives - the batch is not atomic'
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

test('QUIRK: omitting descriptions on PUT WIPES them, because of `descriptions || []`', async () => {
  // Silent data loss on what looks like a partial update. `updateData` always
  // sets `descriptions`, defaulting to `[]` when the key is absent, so a client
  // sending only `{ donationAmount }` clears the list.
  //
  // Not in the finding list - found while writing this test. Added to the
  // remediation map as BUG-09 and fixed in this package, which is why the
  // assertion below is one of the few expected to be edited.
  const id = await store.createCategoryDirect({
    name: uniqueName('wipe'),
    descriptions: ['keep me', 'and me'],
  });

  const res = await put(`/api/categories/${id}`, { donationAmount: 3000 }, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));

  const after = await store.readCategory(id);
  assert.deepEqual(after.descriptions, [], 'CURRENT behaviour: the descriptions are gone');
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

test('QUIRK: PUT on a MALFORMED id is a 500, not a 404', async () => {
  // The id never reaches the not-found branch: casting it to an ObjectId
  // throws first. Two shapes of "no such category" produce two different
  // statuses, and the one an attacker can trigger trivially is the 500.
  const res = await put(
    '/api/categories/not-an-objectid',
    { name: uniqueName('bad'), sortDescription: 's', donationAmount: 1, descriptions: [] },
    adminToken
  );
  assert.equal(res.status, 500);
});

test('QUIRK (SEC-19): the 500 body leaks the internal error message', async () => {
  // Recorded as its own scenario because SEC-19 is assigned to this package.
  // After the fix the body must carry a generic message; this assertion is
  // expected to be edited.
  const res = await put(
    '/api/categories/not-an-objectid',
    { name: uniqueName('leak'), sortDescription: 's', donationAmount: 1, descriptions: [] },
    adminToken
  );
  assert.equal(res.status, 500);
  assert.equal(typeof res.body.error, 'string');
  assert.match(
    res.body.error,
    /Cast to ObjectId failed/,
    'CURRENT behaviour: the Mongoose error text reaches the client'
  );
});

// =============================================================================
// DELETE /api/categories/:id
// =============================================================================

test('DELETE removes the category outright - a HARD delete (ADR-004 changes this)', async () => {
  const id = await store.createCategoryDirect({ name: uniqueName('del') });

  const res = await del(`/api/categories/${id}`, adminToken);
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(res.body.message, 'Category deleted successfully');

  assert.equal(await store.readCategory(id), null, 'CURRENT behaviour: the row is gone');
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
  assert.equal(res.status, 200, 'CURRENT behaviour: the delete is allowed');

  assert.equal(await store.readCategory(catId), null);
  assert.equal(
    await store.readDonationCategoryRef(donationId),
    catId,
    'and the donation still points at the id that no longer exists'
  );
});
