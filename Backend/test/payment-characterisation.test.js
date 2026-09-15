/**
 * =============================================================================
 * CHARACTERISATION tests for routes/payment.js  (SPEC-3 package 3.4)
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:payment-char
 *
 * SEPARATE FROM `payment-callbacks.test.js` ON PURPOSE. That suite is SEC-01's
 * REGRESSION suite and SPEC-3 section 4.1 requires it to pass UNCHANGED through
 * the migration - it is the evidence the replay defence still holds. Adding
 * characterisation assertions to it would mean editing it, and an edited
 * regression suite proves nothing about the thing it was written to prove.
 *
 * So this file covers what that one does not: `POST /initiate` and
 * `GET /status/:txnid`. Between them they are the two ends of the money path -
 * the only live creator of donations, and the only unauthenticated read of one.
 *
 * WHAT IS PINNED HERE IS MOSTLY WRONG BEHAVIOUR, and deliberately so:
 * SEC-06, SEC-07, SEC-11, SEC-19 and PAY-01 all live in these two handlers.
 *
 * THE SEAM SPANS BOTH STORES. `donation` is the last `split` entity - this file
 * writes MongoDB while `routes/donations.js` reads MySQL - so a seam that hid
 * which store answered would hide ADR-057, which is the constraint this package
 * closes.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');

const KEY = 'TESTMERCHANTKEY';
const SALT = 'TESTMERCHANTSALT0000000000000000';

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_paychar_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = KEY;
process.env.PAYU_MERCHANT_SALT = SALT;
process.env.PAYU_BASE_URL = 'https://test.payu.in';
process.env.FRONTEND_SUCCESS_URL = 'http://frontend.test/payment-success';
process.env.FRONTEND_FAILURE_URL = 'http://frontend.test/payment-failure';
process.env.SUCCESS_URL = 'http://localhost/api/payment/success';
process.env.FAILURE_URL = 'http://localhost/api/payment/failure';
process.env.CANCEL_URL = 'http://localhost/api/payment/cancel';
process.env.NOTIFY_URL = 'http://localhost/api/payment/webhook';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const MongoDonation = require('../models/Donation');
const categories = require('../repositories/categories');
const donations = require('../repositories/donations');
const users = require('../repositories/users');
const prismaModule = require('../config/prisma');

const TAG = 'zzz-paychar';
const CAT_PREFIX = 'ZZZ PAYCHAR';

let server;
let base;
let categoryId;      // external ObjectId (ADR-051)
let categoryAmount;  // major units

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
// The seam. TWO STORES, because `donation` is split until this package closes it.
// -----------------------------------------------------------------------------
const store = {
  async reset() {
    await MongoDonation.deleteMany({ donorEmail: new RegExp('^' + TAG) });
    await donations.deleteByDonorEmailPrefix(TAG);
    await users.deleteByEmailPrefix(TAG);
    await categories.deleteByNamePrefix(CAT_PREFIX);
  },

  /** Where does a donation created through /initiate actually land? */
  async readEither(externalId) {
    const mysql = await donations.findByLegacyId(String(externalId));
    if (mysql) return { store: 'mysql', row: mysql };
    let doc = null;
    try {
      doc = await MongoDonation.findById(externalId);
    } catch {
      doc = null;
    }
    if (!doc) return { store: null, row: null };
    return {
      store: 'mongodb',
      row: {
        id: doc._id.toString(),
        donorName: doc.donorName,
        donorEmail: doc.donorEmail,
        donorPhone: doc.donorPhone,
        quantity: doc.quantity,
        amountMajor: doc.amount,
        baseAmountMajor: doc.baseAmount,
        extraAmountMajor: doc.extraAmount,
        status: doc.status,
        paymentStatus: doc.paymentStatus,
        transactionId: doc.transactionId,
        userId: doc.userId ? doc.userId.toString() : null,
        category: doc.category ? doc.category.toString() : null,
      },
    };
  },

  async createUser(tag) {
    const created = await users.create({
      name: 'ZZZ PayChar',
      email: `${TAG}-${tag}@invalid.test`,
      password: 'FixturePass123!',
      role: 'user',
      isVerified: true,
    });
    const fresh = await users.findById(created.id);
    return { externalId: fresh.legacyId || fresh.id, uuid: fresh.id, email: fresh.email };
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

/** AC1: a refusal is a decision, not a crash. */
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

/**
 * The PayU RESPONSE hash, recomputed independently of the implementation.
 *
 *   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
function responseHash(d) {
  const s =
    `${SALT}|${d.status}||||||${d.udf5 || ''}|${d.udf4 || ''}|${d.udf3 || ''}|` +
    `${d.udf2 || ''}|${d.udf1 || ''}|${d.email}|${d.firstname}|${d.productinfo}|` +
    `${d.amount}|${d.txnid}|${KEY}`;
  return crypto.createHash('sha512').update(s).digest('hex');
}

/** The PayU request hash, recomputed independently of the implementation. */
function expectedRequestHash(d) {
  const s =
    `${KEY}|${d.txnid}|${d.amount}|${d.productinfo}|${d.firstname}|${d.email}|` +
    `${d.udf1 || ''}|${d.udf2 || ''}|${d.udf3 || ''}|${d.udf4 || ''}|${d.udf5 || ''}||||||${SALT}`;
  return crypto.createHash('sha512').update(s).digest('hex');
}

const initiate = (overrides = {}) =>
  post('/api/payment/initiate', {
    firstname: 'ZZZ SYNTHETIC',
    email: `${TAG}-donor@invalid.test`,
    phone: '9999999999',
    productinfo: 'Donation',
    category: categoryId,
    ...overrides,
  });

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
  const cat = await categories.create({
    name: `${CAT_PREFIX} fixture`,
    legacyId: mintObjectId(),
    shortDescription: 'fixture',
    donationAmountMinor: 150000,
    descriptions: [],
  });
  categoryId = cat.legacyId;
  categoryAmount = cat.donationAmountMinor / 100;
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
// POST /initiate - the only live creator of donations
// =============================================================================

test('QUIRK (SEC-11): /initiate is UNAUTHENTICATED and unthrottled', async () => {
  // Anyone on the internet can create donation rows, without limit. The
  // `paymentInitiateLimiter` was built in Phase 2 and never wired (ADR-042's
  // shape: the store existing and the store being used are different claims).
  const created = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await initiate({ email: `${TAG}-flood${i}@invalid.test` });
    assert.equal(res.status, 200, `request ${i}: ${res.raw.slice(0, 160)}`);
    created.push(res.body.donationId);
  }
  assert.equal(new Set(created).size, 5, 'CURRENT: five unauthenticated writes, no throttle');
});

test('/initiate requires firstname, email and a resolvable category', async () => {
  assertRefused(await initiate({ firstname: undefined }), 400);
  assertRefused(await initiate({ email: undefined }), 400);
  assertRefused(await initiate({ category: undefined }), 400);

  // A well-formed but unknown id, and a malformed one. Both must be DECISIONS -
  // the bridge is what stopped the malformed case being a 500 (ADR-050).
  assertRefused(await initiate({ category: mintObjectId() }), 400);
  assertRefused(await initiate({ category: 'not-an-objectid' }), 400);
});

test('BE-CRIT-01: the amount is computed SERVER-SIDE and a client amount is ignored', async () => {
  const res = await initiate({ amount: 1, baseAmount: 1, extraAmount: 0 });
  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.equal(
    Number(res.body.paymentData.amount),
    categoryAmount,
    'the category price, not the client value'
  );

  const { row } = await store.readEither(res.body.donationId);
  assert.equal(row.amountMajor, categoryAmount);
});

test('AE4: what /initiate ACTUALLY returns', async () => {
  const res = await initiate();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'donationId',
    'message',
    'paymentData',
    'payuUrl',
    'success',
  ]);

  const d = res.body.paymentData;
  assert.deepEqual(
    Object.keys(d).sort(),
    [
      'amount', 'curl', 'email', 'firstname', 'furl', 'hash', 'key', 'notify_url',
      'phone', 'productinfo', 'surl', 'txnid', 'udf1', 'udf2', 'udf3', 'udf4', 'udf5',
    ]
  );
  assert.equal(d.key, KEY);
  assert.equal(d.hash, expectedRequestHash(d), 'the request hash covers the documented fields');
  assert.equal(res.body.payuUrl, 'https://test.payu.in/_payment');

  // udf4 is the donation id - the callbacks resolve the donation through it.
  assert.equal(d.udf4, res.body.donationId);
});

test('QUIRK (SEC-06): the transaction id is GUESSABLE - TXN<epoch-ms><0..999>', async () => {
  // It is the only thing protecting GET /status/:txnid, which is
  // unauthenticated. Pinned as a SHAPE rather than a value.
  const res = await initiate();
  const txnid = res.body.paymentData.txnid;
  assert.match(txnid, /^TXN\d{16,17}$/, 'CURRENT: TXN + Date.now() + a 0-999 suffix');

  const epoch = Number(txnid.slice(3, 16));
  assert.ok(
    Math.abs(Date.now() - epoch) < 60_000,
    'CURRENT: the timestamp is recoverable from the id, so the search space is ' +
      'a known millisecond window times one thousand'
  );
});

test('QUIRK (SEC-07): `userId` is taken from the BODY on an unauthenticated endpoint', async () => {
  // Anyone can attribute a donation to any account they can name. The victim
  // cannot read it back - GET /donations/:id matches ownership and the donation
  // is theirs, not the attacker's - so this is integrity and nuisance rather
  // than disclosure. The severity is right; what the label hides is that NO
  // CREDENTIAL IS REQUIRED.
  const victim = await store.createUser('victim');

  const res = await initiate({ userId: victim.externalId });
  assert.equal(res.status, 200, res.raw.slice(0, 200));

  const { row } = await store.readEither(res.body.donationId);
  assert.equal(
    row.userId,
    victim.externalId,
    "CURRENT: the donation is attributed to a user the caller never authenticated as"
  );
});

test('QUIRK (PAY-01): `quantity` is UNBOUNDED while `extraAmount` is clamped', async () => {
  // Two adjacent lines, one with a ceiling and one without. The asymmetry is the
  // tell: a reviewer reading the pair concludes that amounts are bounded.
  const clamped = await initiate({ extraAmount: 999_999_999 });
  assert.equal(
    Number(clamped.body.paymentData.amount),
    categoryAmount + 1_000_000,
    'extraAmount IS clamped, to 1,000,000'
  );

  const unbounded = await initiate({ quantity: 1_000_000 });
  assert.equal(
    Number(unbounded.body.paymentData.amount),
    categoryAmount * 1_000_000,
    'CURRENT: quantity has no ceiling at all'
  );

  // And the floor is enforced, so the fix is genuinely a missing ceiling and
  // not a missing bound.
  const zero = await initiate({ quantity: 0 });
  assert.equal(Number(zero.body.paymentData.amount), categoryAmount, 'quantity floors at 1');
  const negative = await initiate({ quantity: -5 });
  assert.equal(Number(negative.body.paymentData.amount), categoryAmount);
});

test('QUIRK (ADR-057): a donation created here lands in MONGODB', async () => {
  // The last split entity, stated as a test. routes/donations.js reads MySQL as
  // of package 3.3, so a donation taken through the live money path is
  // INVISIBLE to the admin list, the receipt and the charts until this package
  // lands. It is why 3.3 and 3.4 are one merge.
  const res = await initiate({ email: `${TAG}-split@invalid.test` });
  const located = await store.readEither(res.body.donationId);
  assert.equal(located.store, 'mongodb', 'CURRENT: the live writer writes MongoDB');
  assert.equal(
    await donations.findByLegacyId(res.body.donationId),
    null,
    'CURRENT: and MySQL - which every reader now uses - has never heard of it'
  );
});

test('a donation is created Pending, with the donor details it was given', async () => {
  const res = await initiate({
    firstname: 'ZZZ Named Donor',
    email: `${TAG}-details@invalid.test`,
    phone: '9876543210',
    item: 'Reef patch',
  });
  const { row } = await store.readEither(res.body.donationId);
  assert.equal(row.donorName, 'ZZZ Named Donor');
  assert.equal(row.donorEmail, `${TAG}-details@invalid.test`);
  assert.equal(row.donorPhone, '9876543210');
  assert.equal(row.status, 'Pending');
  assert.equal(row.paymentStatus, 'Pending');
  assert.equal(row.transactionId, res.body.paymentData.txnid);
});

// =============================================================================
// GET /status/:txnid - SEC-06
// =============================================================================

test('QUIRK (PAY-02): /status is BROKEN - it 500s on every request', async () => {
  // NOT WHAT THIS TEST WAS WRITTEN TO ASSERT, and finding that out is why AU1
  // said to extend the baseline before touching anything.
  //
  // The handler does `.populate('userId', 'name email')`, which needs the
  // Mongoose `User` model REGISTERED in the process. Package AS7 removed
  // `const User = require("../models/User")` from routes/admin.js as a DEAD
  // IMPORT - the binding genuinely was unused - and that require() was the only
  // thing registering the model at app boot.
  //
  //   models registered at boot: Donation
  //   User registered? false
  //
  // AN UNUSED BINDING IS NOT AN UNUSED IMPORT. In a module system with side
  // effects, `require()` does work, and a "dead" import can be load-bearing
  // through a global registry that no reference-level analysis can see. The AT4
  // gate correctly said admin.js must not import a migrated model; the REMEDY
  // I applied had a consequence the gate does not model.
  //
  // This is repaired by THIS package - payment.js stops using Mongoose
  // entirely - and it never ships broken, because 3.3 and 3.4 are one merge
  // unit. It is pinned rather than hot-fixed so the repair is visible.
  const res = await initiate({
    firstname: 'ZZZ Private Donor',
    email: `${TAG}-pii@invalid.test`,
    phone: '9123456780',
  });
  const txnid = res.body.paymentData.txnid;

  const status = await get(`/api/payment/status/${txnid}`);
  assert.equal(status.status, 500, 'CURRENT: every call fails');
  assert.match(
    status.body.details || '',
    /Schema hasn't been registered for model "User"/,
    'CURRENT: and SEC-19 hands the reason to the client'
  );
});

test('SEC-06 IS CURRENTLY MASKED BY PAY-02, which is not the same as fixed', async () => {
  // The endpoint returns the WHOLE donation - name, email, phone, amount - to a
  // caller with no credential. Right now it cannot, because it 500s first.
  //
  // THE MAP HAS SEEN THIS EXACT SHAPE BEFORE. SEC-03, the authentication
  // bypass, was recorded as "currently unreachable ONLY because MongoDB rejects
  // the application's credentials - an availability failure standing in for an
  // access control". The same sentence applies here, and it was not a defence
  // then either: restore the dependency and the finding is live again.
  //
  // So this asserts the MECHANISM is still present, without depending on the
  // broken path - by reading what the handler selects. When PAY-02 is repaired
  // in this package, the test above changes and this one gains teeth.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'payment.js'),
    'utf8'
  );
  const handler = src.slice(src.indexOf("router.get('/status/:txnid'"));
  assert.ok(
    !/authMiddleware|adminAuth/.test(handler.slice(0, 400)),
    'CURRENT: no authentication on the status route'
  );
  assert.ok(
    /res\.json\(\{\s*success: true,\s*donation,/.test(handler),
    'CURRENT: the whole donation object is returned, not a projection'
  );
});

test('SEC-06: the txnid travels in the URL, which is where the leak comes from', async () => {
  // Blind enumeration is NOT the exposure and claiming it would overstate the
  // finding: TXN + 13 epoch digits + 0-999 is ~10^11 candidates per day. The
  // exposure is that the application PUBLISHES the credential - every callback
  // redirects to FRONTEND_SUCCESS_URL?txnid=..., so it lands in browser history,
  // in the Referer sent to every third party on the success page, and in any
  // analytics or error reporter there.
  //
  // Asserted here so the claim is behavioural rather than a reading of the code.
  const res = await initiate({ email: `${TAG}-url@invalid.test` });
  const txnid = res.body.paymentData.txnid;

  // `redirect: 'manual'` so the Location header can be READ rather than
  // followed - following it would fetch frontend.test, which does not resolve,
  // and the test would fail for a reason unrelated to its subject.
  // A GENUINELY SIGNED decline, so the handler takes its normal path rather
  // than the invalid-hash path - which redirects without a txnid and would have
  // made this test pass for the wrong reason. (It did, on the first run: the
  // Location was `?error=invalid_hash`.)
  const payload = {
    txnid,
    status: 'failure',
    amount: categoryAmount.toFixed(2),
    productinfo: 'Donation',
    firstname: 'ZZZ SYNTHETIC',
    email: `${TAG}-url@invalid.test`,
  };
  payload.hash = responseHash(payload);

  const success = await fetch(`${base}/api/payment/failure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'manual',
    body: JSON.stringify(payload),
  });

  assert.ok(success.status >= 300 && success.status < 400, `expected a redirect, got ${success.status}`);
  const location = success.headers.get('location') || '';
  assert.doesNotMatch(location, /invalid_hash/, 'the payload must be accepted, not rejected');
  assert.match(
    location,
    new RegExp(`txnid=${txnid}`),
    'CURRENT: the application publishes the txnid into the browser address bar - ' +
      'which puts it in history, in the Referer sent to every third party on the ' +
      'destination page, and in any analytics there'
  );
});

test('/status 404s an unknown transaction, and does not 500 on a strange one', async () => {
  const unknown = await get('/api/payment/status/TXN0000000000000');
  assertRefused(unknown, 404);

  const weird = await get('/api/payment/status/' + encodeURIComponent("' OR 1=1 --"));
  assert.notEqual(Math.floor(weird.status / 100), 5, `must not 500: ${weird.raw.slice(0, 160)}`);
  assert.equal(weird.status, 404);
});

test('QUIRK (SEC-19): the webhook and cancel handlers return err.message', async () => {
  // `details: error.message` at payment.js:443,475. Pinned by reading the
  // shape the handlers produce rather than by forcing an internal error, which
  // would assert the error and not the disclosure.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'payment.js'),
    'utf8'
  );
  assert.ok(
    /details:\s*error\.message/.test(src),
    'CURRENT: at least one handler returns the internal error text to the client'
  );
});
