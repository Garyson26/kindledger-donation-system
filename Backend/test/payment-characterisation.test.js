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
 * WRITTEN AGAINST THE MONGOOSE IMPLEMENTATION AND NOW ASSERTED AGAINST THE
 * MySQL ONE. Eight assertions changed; each is marked `CHANGED IN 3.4` with the
 * finding that caused it. Seven of the eight are QUIRKs being closed - SEC-06
 * twice, SEC-07, PAY-01, PAY-02 and ADR-057 - and they were pinned as WRONG
 * behaviour on purpose, so fixing them HAD to break this file.
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
    // CHANGED IN 3.4: donations created here are addressed by uuid now, because
    // payment.js stopped minting a legacy_id when AE1-b's trigger fired.
    const byUuid = await donations.findById(String(externalId));
    if (byUuid) return { store: 'mysql', row: { ...byUuid, userId: byUuid.donor.user ? byUuid.donor.user.legacyId || byUuid.donor.user.id : null } };
    const byLegacy = await donations.findByLegacyId(String(externalId));
    if (byLegacy) return { store: 'mysql', row: { ...byLegacy, userId: byLegacy.donor.user ? byLegacy.donor.user.legacyId || byLegacy.donor.user.id : null } };
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
        amountMinor: Math.round((doc.amount || 0) * 100),
        transactionRef: doc.transactionId,
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
/**
 * A fresh client address per request (CHANGED IN 3.4).
 *
 * SEC-11 wired `paymentInitiateLimiter` to `/initiate`, and the suite
 * immediately throttled ITSELF - twenty calls a minute, and this file makes
 * more. The established pattern from `auth-reset.test.js`: give each request
 * its own X-Forwarded-For so the limiter's budget cannot mask what a test is
 * measuring. Express reads it because `trust proxy` is 1.
 *
 * The limiter is asserted DELIBERATELY in its own test below, with a fixed
 * address, rather than incidentally through every other test failing.
 */
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

async function call(method, path, { body, token, clientIp } = {}) {
  const headers = { 'X-Forwarded-For': clientIp || nextIp() };
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

test('SEC-11 CLOSED: /initiate is rate limited per client (CHANGED IN 3.4)', async () => {
  // WAS: anyone on the internet could create donation rows without limit. The
  // limiter was built in Phase 2 and nothing imported it - ADR-042's shape
  // exactly, where the limiter existing and the limiter being used are
  // different claims.
  //
  // The endpoint stays UNAUTHENTICATED, deliberately: requiring a login to
  // donate would lose every guest donation, which is most of them. A limiter is
  // the control that fits an endpoint that must stay open.
  // A FRESH ADDRESS PER RUN. The Redis limiter is shared and persistent, so a
  // fixed address inherits the previous run's counter and the suite fails on
  // its first request - which is DEPLOY-01's shape seen from inside the tests,
  // and the reason RATE_LIMIT_PREFIX exists.
  const octet = crypto.randomInt(1, 250);
  const ip = `198.51.100.${octet}`;
  const otherIp = `198.51.100.${(octet % 250) + 1}`;
  let refused = null;
  let accepted = 0;

  for (let i = 0; i < 25 && refused === null; i += 1) {
    const res = await call('POST', '/api/payment/initiate', {
      clientIp: ip,
      body: {
        firstname: 'ZZZ SYNTHETIC',
        email: `${TAG}-flood${i}@invalid.test`,
        productinfo: 'Donation',
        category: categoryId,
      },
    });
    if (res.status === 429) refused = res;
    else accepted += 1;
  }

  assert.ok(refused, 'the limiter must fire within 25 requests from one address');
  assert.ok(accepted > 0, 'and it must not refuse the first one');
  assert.equal(typeof refused.body.error, 'string', 'the refusal names a reason (AC1)');

  // THE CONTROL: a DIFFERENT address is unaffected, so the limiter is keying on
  // the client and not simply exhausted globally.
  const other = await call('POST', '/api/payment/initiate', {
    clientIp: otherIp,
    body: {
      firstname: 'ZZZ SYNTHETIC',
      email: `${TAG}-other@invalid.test`,
      productinfo: 'Donation',
      category: categoryId,
    },
  });
  assert.equal(other.status, 200, 'a different client still gets through');
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

  const located = await store.readEither(res.body.donationId);
  assert.equal(located.store, 'mysql', 'CHANGED IN 3.4');
  assert.equal(located.row.amountMinor, Math.round(categoryAmount * 100));
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

test('SEC-06 CLOSED (1/2): the transaction reference is UNGUESSABLE (CHANGED IN 3.4)', async () => {
  // WAS: `TXN${Date.now()}${rand(0,999)}`. The timestamp was recoverable from
  // the value, so the search space collapsed to a known millisecond window times
  // one thousand - and it was the ONLY thing protecting an unauthenticated
  // endpoint that returned the donor's record.
  const first = (await initiate()).body.paymentData.txnid;
  const second = (await initiate()).body.paymentData.txnid;

  assert.match(first, /^TXN[0-9a-f]{20}$/, '80 random bits, no structure');
  assert.notEqual(first, second);

  // THE ASSERTION THAT MATTERS: no timestamp is recoverable. The old scheme put
  // 13 digits of epoch milliseconds in a fixed position; if any 13-digit run
  // here decodes to a plausible time, the entropy claim is wrong.
  const digits = first.slice(3).replace(/[a-f]/g, '');
  const now = Date.now();
  for (let i = 0; i + 13 <= digits.length; i += 1) {
    const candidate = Number(digits.slice(i, i + 13));
    assert.ok(
      Math.abs(now - candidate) > 86_400_000,
      `a 13-digit run decodes to within a day of now (${candidate}) - the ` +
        'reference is carrying a timestamp again'
    );
  }

  // And it is short: the previous scheme was 16-17 characters and is proven
  // against the live gateway at that length. See the note in payment.js on the
  // one thing to confirm against the PayU sandbox before cutover.
  assert.ok(first.length <= 25, `txnid must stay short for PayU: ${first.length}`);
});

test('SEC-07 CLOSED: a forged `userId` in the body is IGNORED (CHANGED IN 3.4)', async () => {
  // WAS: `userId` destructured from req.body on an endpoint with no
  // authentication, so anyone on the internet could write rows into a
  // stranger's donation history. The identity now comes from the token or there
  // is no identity.
  const victim = await store.createUser('victim');

  const res = await initiate({ userId: victim.externalId });
  assert.equal(res.status, 200, res.raw.slice(0, 200));

  const { row } = await store.readEither(res.body.donationId);
  assert.equal(row.userId, null, 'the forged attribution is ignored - it is a guest donation');
  assert.equal(
    res.body.paymentData.udf5,
    '',
    'and nothing the caller asserted is passed on to PayU either'
  );

  // THE CONTROL: an AUTHENTICATED caller IS attributed, so the assertion above
  // is about trusting the token rather than about attribution being broken.
  const token = jwt.sign(
    { userId: victim.externalId, role: 'user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const authed = await post(
    '/api/payment/initiate',
    {
      firstname: 'ZZZ SYNTHETIC',
      email: `${TAG}-authed@invalid.test`,
      productinfo: 'Donation',
      category: categoryId,
    },
    token
  );
  assert.equal(authed.status, 200, authed.raw.slice(0, 200));
  const attributed = await store.readEither(authed.body.donationId);
  assert.equal(attributed.row.userId, victim.externalId, 'CONTROL: a real token IS attributed');
});

test('BUG-06 fixed properly here: a LAPSED token is a guest, not a refusal (CHANGED IN 3.4)', async () => {
  // routes/donations.js had an `optionalAuth` that delegated to authMiddleware
  // whenever any Authorization header was present, so a donor whose session had
  // expired was refused with a 401 instead of falling through to a guest
  // donation. That endpoint was deleted in 3.3; this one is written the way that
  // one should have been - on the donation path, turning a lapsed session into a
  // refusal loses the donation.
  const user = await store.createUser('lapsed');
  const expired = jwt.sign(
    { userId: user.externalId, role: 'user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '-1h' }
  );

  const res = await post(
    '/api/payment/initiate',
    {
      firstname: 'ZZZ SYNTHETIC',
      email: `${TAG}-lapsed@invalid.test`,
      productinfo: 'Donation',
      category: categoryId,
    },
    expired
  );
  assert.equal(res.status, 200, `a lapsed session must still be able to donate: ${res.raw.slice(0, 200)}`);
  const { row } = await store.readEither(res.body.donationId);
  assert.equal(row.userId, null, 'as a guest');
});

test('PAY-01 CLOSED: BOTH quantity and extraAmount are bounded (CHANGED IN 3.4)', async () => {
  // Two adjacent lines, one with a ceiling and one without. The asymmetry is the
  // tell: a reviewer reading the pair concludes that amounts are bounded.
  const clamped = await initiate({ extraAmount: 999_999_999 });
  assert.equal(
    Number(clamped.body.paymentData.amount),
    categoryAmount + 1_000_000,
    'extraAmount IS clamped, to 1,000,000'
  );

  // WAS: no ceiling at all. `quantity=99999999999999999999` priced a donation
  // at 1.5e23 on an unauthenticated endpoint, and against MySQL it would have
  // been an unauthenticated 500 when the value failed to convert to paise.
  const bounded = await initiate({ quantity: 1_000_000 });
  assert.equal(
    Number(bounded.body.paymentData.amount),
    categoryAmount * 10_000,
    'clamped to MAX_QUANTITY'
  );

  // The value that used to produce 1.5e23.
  const absurd = await initiate({ quantity: '99999999999999999999' });
  assert.equal(absurd.status, 200, absurd.raw.slice(0, 160));
  assert.equal(Number(absurd.body.paymentData.amount), categoryAmount * 10_000);

  // And the floor is enforced, so the fix is genuinely a missing ceiling and
  // not a missing bound.
  const zero = await initiate({ quantity: 0 });
  assert.equal(Number(zero.body.paymentData.amount), categoryAmount, 'quantity floors at 1');
  const negative = await initiate({ quantity: -5 });
  assert.equal(Number(negative.body.paymentData.amount), categoryAmount);
});

test('ADR-057 CLOSED: a donation created here lands in MySQL, where readers look (CHANGED IN 3.4)', async () => {
  // WAS: MongoDB. routes/donations.js has read MySQL since package 3.3, so
  // every donation taken through the live money path was invisible to the admin
  // list, the receipt and the charts. It is why 3.3 and 3.4 are one merge, and
  // this assertion flipping is that merge unit being discharged.
  const res = await initiate({ email: `${TAG}-split@invalid.test` });
  const located = await store.readEither(res.body.donationId);
  assert.equal(located.store, 'mysql', 'the live writer writes MySQL');

  // And it is visible to the READER, which is the thing that actually mattered.
  const seen = await donations.findById(res.body.donationId);
  assert.ok(seen, 'the donation routes/donations.js reads can see it');
  assert.equal(seen.donorEmail, `${TAG}-split@invalid.test`);
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
  assert.equal(row.transactionRef, res.body.paymentData.txnid, 'CHANGED IN 3.4: column renamed');
});

// =============================================================================
// GET /status/:txnid - SEC-06
// =============================================================================

test('PAY-02 CLOSED, and SEC-06 with it: /status returns a RECEIPT (CHANGED IN 3.4)', async () => {
  // PAY-02 WAS: 500 on every request. `.populate('userId')` needed the Mongoose
  // User model registered, and AS7 removed the last import registering it. There
  // is no populate here at all now.
  //
  // SEC-06 WAS: the whole populated donation - donor name, EMAIL, PHONE, the
  // linked user - to a caller with no credential. It was MASKED by PAY-02, and
  // the map has seen that shape before: SEC-03 was "unreachable only because
  // MongoDB rejects the application's credentials - an availability failure
  // standing in for an access control". Not a defence then, not one now.
  const res = await initiate({
    firstname: 'ZZZ Private Donor',
    email: `${TAG}-pii@invalid.test`,
    phone: '9123456780',
  });
  const txnid = res.body.paymentData.txnid;

  const status = await get(`/api/payment/status/${txnid}`);
  assert.equal(status.status, 200, status.raw.slice(0, 200));

  const d = status.body.donation;
  assert.equal(d.donorName, 'ZZZ Private Donor', 'the name stays - it is what makes a receipt recognisable');
  assert.equal(typeof d.amount, 'number');
  assert.equal(d.paymentStatus, 'Pending');

  // THE ASSERTIONS THAT MATTER: what is NO LONGER returned.
  assert.equal('donorEmail' in d, false, 'the donor EMAIL is gone');
  assert.equal('donorPhone' in d, false, 'the donor PHONE is gone');
  assert.equal('userId' in d, false, 'and the linked account is gone');
  assert.equal('donor' in d, false);

  // Asserted over the whole serialised body, not field by field, so a leak in a
  // nested object cannot slip through (AP1).
  assert.doesNotMatch(status.raw, /@invalid\.test/, 'no email address anywhere in the response');
  assert.doesNotMatch(status.raw, /9123456780/, 'no phone number anywhere in the response');

  // A donation nobody has paid for has no payment details at all.
  assert.equal(d.paymentDetails, null, 'nothing invented for a Pending donation');
});

test('U-2 (design half): a SETTLED receipt carries what reconciliation needs (3.4)', async () => {
  // U-2 is the `verify_payment` reconciliation, and the outbound call is a
  // later package. What 3.4 owes is that the handler RECORDS ENOUGH TO
  // RECONCILE LATER - so this asserts the fields are present and no more.
  //
  // `mihpayid` is PayU's own reference and `bank_ref_num` is the bank's; with
  // the amount and the date they are enough to match a payment against a
  // gateway statement without any outbound call at all.
  const res = await initiate({ email: `${TAG}-settled@invalid.test` });
  const txnid = res.body.paymentData.txnid;

  const payload = {
    txnid,
    status: 'success',
    amount: Number(res.body.paymentData.amount).toFixed(2),
    productinfo: 'Donation',
    firstname: 'ZZZ SYNTHETIC',
    email: `${TAG}-settled@invalid.test`,
    udf4: res.body.donationId,
    mihpayid: 'MIH-RECONCILE-1',
    mode: 'CC',
    bank_ref_num: '123456789',
  };
  payload.hash = responseHash(payload);

  const settled = await fetch(`${base}/api/payment/success`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    redirect: 'manual',
    body: JSON.stringify(payload),
  });
  assert.ok(settled.status >= 300 && settled.status < 400, `expected a redirect: ${settled.status}`);
  assert.doesNotMatch(settled.headers.get('location') || '', /error=/, 'the payment was accepted');

  const status = await get(`/api/payment/status/${txnid}`);
  assert.equal(status.status, 200, status.raw.slice(0, 200));
  assert.equal(status.body.donation.paymentStatus, 'Paid');

  assert.deepEqual(
    Object.keys(status.body.donation.paymentDetails).sort(),
    ['bank_ref_num', 'mihpayid', 'mode', 'paymentDate', 'status'],
    'exactly the reconciliation fields, and nothing else'
  );
  assert.equal(status.body.donation.paymentDetails.mihpayid, 'MIH-RECONCILE-1');
  assert.equal(status.body.donation.paymentDetails.bank_ref_num, '123456789');
  assert.equal(
    status.body.donation.paymentDetails.status,
    'success',
    "PayU own vocabulary, stored verbatim (ADR-021)"
  );

  // And the receipt STILL leaks no PII after settlement - the projection is not
  // something that only holds before a payment lands.
  assert.doesNotMatch(status.raw, /@invalid\.test/);
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

// =============================================================================
// AK3 / AM1 - a donation that exists in MONGODB and was never migrated
// =============================================================================

test('AK3: an UN-MIGRATED donation is ABSENT from the receipt lookup', async () => {
  // ADR-056: a read-through bridge does not make a route migration additive,
  // and donations never had a bridge at all. A donation written to MongoDB and
  // not carried across is INVISIBLE to this file - not an error, absent.
  //
  // AM1: created HERE, after any ETL run, and asserted to have no MySQL row
  // BEFORE the endpoint is exercised. If it ever has one, the setup migrated it
  // and everything below passes for the wrong reason.
  const txnid = 'TXN' + crypto.randomBytes(10).toString('hex');
  const doc = await MongoDonation.create({
    donorName: 'ZZZ Legacy Donor',
    donorEmail: `${TAG}-unmigrated@invalid.test`,
    category: new mongoose.Types.ObjectId(),
    quantity: 1,
    amount: 4242,
    status: 'Pending',
    paymentStatus: 'Pending',
    date: new Date(),
    transactionId: txnid,
  });

  assert.equal(
    await donations.findByTransactionRef(txnid),
    null,
    'SETUP ERROR: the AK3 fixture has a MySQL row, so it was migrated after all'
  );

  const status = await get(`/api/payment/status/${txnid}`);
  assert.notEqual(Math.floor(status.status / 100), 5, `must not 500: ${status.raw.slice(0, 160)}`);
  assertRefused(status, 404);

  // THE CONTROL. The same lookup for a MIGRATED donation works, so the 404
  // above is about migration state and not about the endpoint being broken.
  const live = await initiate({ email: `${TAG}-ak3control@invalid.test` });
  const control = await get(`/api/payment/status/${live.body.paymentData.txnid}`);
  assert.equal(
    control.status,
    200,
    'CONTROL FAILED: a MySQL donation is not found either, so the assertion ' +
      'above proves nothing'
  );

  await MongoDonation.deleteOne({ _id: doc._id });
});
