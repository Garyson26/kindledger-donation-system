/**
 * =============================================================================
 * PayU callback behaviour - SEC-01 and the observability change
 * =============================================================================
 *   docker run -d --name kl-mongo -p 27017:27017 mongo:7
 *   npm run test:payment
 *
 * WHY THIS SUITE EXISTS
 * The SEC-01 hotfix and the paymentDetails observability change both shipped
 * to production with no committed tests. The behaviour they establish was
 * verified once, by hand, and nothing protected it afterwards. Phase 3
 * rewrites these four handlers against MySQL; without this suite that rewrite
 * has no regression net over the single most security-sensitive path in the
 * application.
 *
 * THIS SUITE MUST KEEP PASSING ACROSS THE MYSQL MIGRATION.
 * That constraint shapes how it is written:
 *
 *   - Every assertion is on OBSERVABLE behaviour: the HTTP status, the
 *     redirect Location, and the persisted state of the donation. Nothing
 *     asserts on Mongoose documents, lean objects, ObjectId types or any
 *     other storage detail.
 *   - All storage access goes through the `store` seam below. Phase 3 replaces
 *     the body of those five functions with Prisma equivalents and the
 *     scenarios are untouched. If a scenario needs changing to pass on MySQL,
 *     that is a signal the behaviour changed - which is exactly what we want
 *     to be told.
 *   - `readDonation` returns a plain normalised object, so field naming is
 *     translated in one place rather than in thirty assertions.
 *
 * NO REAL CREDENTIALS. The merchant key and salt below are local fixtures.
 * Payloads are signed with them using PayU's documented response formula, so
 * the suite exercises the real verification path without contacting PayU and
 * without the production salt existing anywhere in this process. See ADR-021
 * for why the documented formula is the authority here.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');

// -----------------------------------------------------------------------------
// Environment. Must be set before app.js is required.
// -----------------------------------------------------------------------------
const KEY = 'TESTMERCHANTKEY';
const SALT = 'TESTMERCHANTSALT0000000000000000';

const FRONTEND_SUCCESS = 'http://frontend.test/payment-success';
const FRONTEND_FAILURE = 'http://frontend.test/payment-failure';

// NODE_ENV=production together with VERCEL=1 stops app.js binding its own
// listener, so this suite owns the server and can close it. It does not change
// any behaviour under test.
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_payment_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = KEY;
process.env.PAYU_MERCHANT_SALT = SALT;
process.env.PAYU_BASE_URL = 'https://test.payu.in';
process.env.FRONTEND_SUCCESS_URL = FRONTEND_SUCCESS;
process.env.FRONTEND_FAILURE_URL = FRONTEND_FAILURE;
process.env.SUCCESS_URL = 'http://localhost/api/payment/success';
process.env.FAILURE_URL = 'http://localhost/api/payment/failure';
process.env.CANCEL_URL = 'http://localhost/api/payment/cancel';
process.env.NOTIFY_URL = 'http://localhost/api/payment/webhook';

const mongoose = require('mongoose');
const Donation = require('../models/Donation');
const Category = require('../models/Category');

let server;
let base;

// -----------------------------------------------------------------------------
// Storage seam. Phase 3 reimplements these five against Prisma/MySQL.
// -----------------------------------------------------------------------------
const CATEGORY_NAME = 'ZZZ PAYMENT TEST CATEGORY';
const DONOR_EMAIL_PREFIX = 'zzz-payment-test';

const store = {
  async reset() {
    await Donation.deleteMany({ donorEmail: new RegExp('^' + DONOR_EMAIL_PREFIX) });
    await Category.deleteMany({ name: new RegExp('^ZZZ PAYMENT TEST') });
  },

  async createCategory(amountMajor, suffix = '') {
    const doc = await Category.create({
      name: CATEGORY_NAME + suffix,
      sortDescription: 'fixture',
      donationAmount: amountMajor,
      descriptions: [],
      displayOrder: 0,
    });
    return { id: doc._id.toString(), amountMajor: doc.donationAmount };
  },

  async createDonation({ categoryId, amountMajor, tag }) {
    const doc = await Donation.create({
      donorName: 'ZZZ SYNTHETIC TEST DO NOT PROCESS',
      donorEmail: `${DONOR_EMAIL_PREFIX}-${tag}@invalid.test`,
      category: categoryId,
      quantity: 1,
      amount: amountMajor,
      baseAmount: amountMajor,
      extraAmount: 0,
      status: 'Pending',
      paymentStatus: 'Pending',
      transactionId: 'TXN' + crypto.randomBytes(6).toString('hex'),
    });
    return { id: doc._id.toString(), txnid: doc.transactionId, amountMajor };
  },

  /** Plain normalised view. No storage types leak past this function. */
  async readDonation(id) {
    const d = await Donation.findById(id);
    if (!d) return null;
    const pd = d.paymentDetails || {};
    return {
      id: d._id.toString(),
      status: d.status,
      paymentStatus: d.paymentStatus,
      amountMajor: d.amount,
      failureReason: d.failureReason ?? null,
      errorMessage: d.errorMessage ?? null,
      gatewayStatus: pd.status ?? null,
      mihpayid: pd.mihpayid ?? null,
      mode: pd.mode ?? null,
      bankRefNum: pd.bank_ref_num ?? null,
      detailErrorMessage: pd.error_Message ?? null,
      paidAt: pd.paymentDate ? new Date(pd.paymentDate).toISOString() : null,
    };
  },

  /** Seeds one paymentDetails field, simulating an earlier writer. */
  async seedPaymentDetail(id, field, value) {
    await Donation.findByIdAndUpdate(id, { $set: { [`paymentDetails.${field}`]: value } });
  },
};

// -----------------------------------------------------------------------------
// PayU payload signing - the documented response formula (ADR-021)
// -----------------------------------------------------------------------------
function signResponse(d) {
  const s =
    `${SALT}|${d.status}||||||${d.udf5 || ''}|${d.udf4 || ''}|${d.udf3 || ''}` +
    `|${d.udf2 || ''}|${d.udf1 || ''}|${d.email}|${d.firstname}|${d.productinfo}` +
    `|${d.amount}|${d.txnid}|${KEY}`;
  return crypto.createHash('sha512').update(s).digest('hex');
}

function payload({ status, amount, txnid, donationId, extra = {} }) {
  const d = {
    status,
    amount,
    txnid,
    email: 'donor@invalid.test',
    firstname: 'ZZZ SYNTHETIC TEST DO NOT PROCESS',
    productinfo: 'Donation',
    udf1: '',
    udf2: '',
    udf3: '1',
    udf4: donationId,
    udf5: '',
    mihpayid: 'MIH' + crypto.randomBytes(6).toString('hex'),
    mode: 'CC',
    bank_ref_num: String(crypto.randomInt(100000000, 999999999)),
  };
  d.hash = signResponse(d);
  // Unsigned fields are added AFTER signing, exactly as PayU sends them -
  // they are not covered by the hash (ADR-026).
  return { ...d, ...extra };
}

async function postForm(endpoint, body) {
  const res = await fetch(`${base}/api/payment/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------
function mongoHostPort(uri) {
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(uri);
  return { host: m ? m[1] : '127.0.0.1', port: m && m[2] ? Number(m[2]) : 27017 };
}

/**
 * Fail with an actionable message rather than letting connectDB() call
 * process.exit(1), which would kill the runner with no explanation.
 */
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

let fixtureCategory;

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

  await store.reset();
  fixtureCategory = await store.createCategory(1500);
});

after(async () => {
  try {
    await store.reset();
  } finally {
    if (server) server.close();
    await mongoose.connection.close();
  }
});

/** Fresh Pending donation of 1500, tagged for cleanup. */
let seq = 0;
async function freshDonation(amountMajor = 1500) {
  seq += 1;
  return store.createDonation({
    categoryId: fixtureCategory.id,
    amountMajor,
    tag: `${Date.now()}-${seq}`,
  });
}

// =============================================================================
// SEC-01 - the scenarios that must survive the MySQL rewrite
// =============================================================================

test('SEC-01 a signed FAILURE payload replayed at /success is refused', async () => {
  // The original exploit. PayU signs failure responses with the same formula
  // as a success and delivers them through the donor's browser, so the donor
  // can replay their own failed payload. Before the fix this set Paid.
  const { id, txnid } = await freshDonation();
  const res = await postForm(
    'success',
    payload({ status: 'failure', amount: '1500.00', txnid, donationId: id })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Pending', 'donation must not be marked Paid');
  assert.equal(d.status, 'Pending');
  assert.match(res.location, /error=payment_not_successful/);
});

test('SEC-01 a legitimate signed SUCCESS is accepted', async () => {
  const { id, txnid } = await freshDonation();
  const res = await postForm(
    'success',
    payload({ status: 'success', amount: '1500.00', txnid, donationId: id })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Paid');
  assert.equal(d.status, 'Approved');
  assert.ok(res.location.startsWith(FRONTEND_SUCCESS), `redirected to ${res.location}`);
});

test('SEC-01 a signed SUCCESS for the wrong amount is refused', async () => {
  // Signed consistently, but for 1.00 against a donation priced at 1500.00.
  const { id, txnid } = await freshDonation();
  const res = await postForm(
    'success',
    payload({ status: 'success', amount: '1.00', txnid, donationId: id })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Pending');
  assert.match(res.location, /error=amount_mismatch/);
});

test('SEC-01 replaying a genuine SUCCESS is an idempotent no-op', async () => {
  const { id, txnid } = await freshDonation();
  const p = payload({ status: 'success', amount: '1500.00', txnid, donationId: id });

  await postForm('success', p);
  const first = await store.readDonation(id);

  await new Promise((r) => setTimeout(r, 30));
  const res2 = await postForm('success', p);
  const second = await store.readDonation(id);

  assert.equal(second.paymentStatus, 'Paid');
  assert.equal(second.paidAt, first.paidAt, 'the second call must not rewrite paidAt');
  assert.ok(res2.location.startsWith(FRONTEND_SUCCESS));
});

test('SEC-01 a signed SUCCESS sent to /failure is refused', async () => {
  // The status must match the endpoint in BOTH directions, or a genuine
  // success replayed at /failure would walk a paid donation back to Rejected.
  const { id, txnid } = await freshDonation();
  const res = await postForm(
    'failure',
    payload({ status: 'success', amount: '1500.00', txnid, donationId: id })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Pending');
  assert.equal(d.status, 'Pending');
  assert.match(res.location, /error=status_mismatch/);
});

test('SEC-01 a signed SUCCESS sent to /cancel is refused', async () => {
  const { id, txnid } = await freshDonation();
  const res = await postForm(
    'cancel',
    payload({ status: 'success', amount: '1500.00', txnid, donationId: id })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Pending');
  assert.match(res.location, /error=status_mismatch/);
});

test('SEC-01 a malformed hash is refused and leaves the donation untouched', async () => {
  // 128 characters, none of them hex. Exercises the SEC-14 path: it fails
  // closed, which is what matters here.
  const { id, txnid } = await freshDonation();
  const p = payload({ status: 'success', amount: '1500.00', txnid, donationId: id });
  p.hash = 'z'.repeat(128);

  await postForm('success', p);
  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Pending');
});

// =============================================================================
// The gate reads `status`, never `unmappedstatus` (ADR-021, ADR-026)
// =============================================================================

test("a realistic cancellation (status=failure, unmappedstatus=usercancelled) is accepted at /cancel", async () => {
  // PayU's documented `status` vocabulary is success|failure only. A user
  // cancellation arrives as status=failure with unmappedstatus=usercancelled;
  // there is no "cancel" value. A gate requiring one would refuse every
  // legitimate cancellation.
  const { id, txnid } = await freshDonation();
  await postForm(
    'cancel',
    payload({
      status: 'failure',
      amount: '1500.00',
      txnid,
      donationId: id,
      extra: { unmappedstatus: 'usercancelled', error_Message: 'Transaction cancelled by user' },
    })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Cancelled');
});

test('the same realistic cancellation arriving at /failure is accepted', async () => {
  // Whether PayU posts cancellations to curl or furl is unestablished
  // (ADR-024), so both paths must accept them.
  const { id, txnid } = await freshDonation();
  await postForm(
    'failure',
    payload({
      status: 'failure',
      amount: '1500.00',
      txnid,
      donationId: id,
      extra: { unmappedstatus: 'usercancelled' },
    })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Failed');
  assert.equal(d.status, 'Rejected');
});

test('an ordinary decline is accepted at /failure', async () => {
  const { id, txnid } = await freshDonation();
  await postForm(
    'failure',
    payload({
      status: 'failure',
      amount: '1500.00',
      txnid,
      donationId: id,
      extra: { unmappedstatus: 'failed', error_Message: 'Insufficient funds' },
    })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Failed');
  assert.equal(d.errorMessage, 'Insufficient funds');
});

test('a success whose unmappedstatus is `captured` is accepted', async () => {
  // PayU classifies captured and auth as Success. Had the gate read
  // unmappedstatus instead of status, this legitimate payment would be
  // refused - and unmappedstatus is not covered by the hash, so gating on it
  // would also move the decision onto an unsigned field.
  const { id, txnid } = await freshDonation();
  await postForm(
    'success',
    payload({
      status: 'success',
      amount: '1500.00',
      txnid,
      donationId: id,
      extra: { unmappedstatus: 'captured' },
    })
  );

  const d = await store.readDonation(id);
  assert.equal(d.paymentStatus, 'Paid');
});

// =============================================================================
// Amount comparison in integer minor units (ADR-010)
// =============================================================================

test('every rendering of the same amount is accepted', async () => {
  // PayU's amount rendering varies. A false rejection here costs a real
  // donation, so "1500", "1500.0" and "1500.00" must all compare equal.
  for (const amount of ['1500', '1500.0', '1500.00']) {
    const { id, txnid } = await freshDonation();
    await postForm('success', payload({ status: 'success', amount, txnid, donationId: id }));
    const d = await store.readDonation(id);
    assert.equal(d.paymentStatus, 'Paid', `rendering ${JSON.stringify(amount)} was refused`);
  }
});

test('non-round amounts priced through /initiate are accepted', async () => {
  // Priced by the real endpoint so the value passes through the same float
  // arithmetic and toFixed(2) as production, then echoed back in the exact
  // string /initiate handed PayU.
  const cases = [
    { catAmount: 1500, quantity: 2, extraAmount: 49.99 },
    { catAmount: 411.52, quantity: 3, extraAmount: 0 },
    { catAmount: 333.33, quantity: 3, extraAmount: 0.01 },
    { catAmount: 999.99, quantity: 1, extraAmount: 0.5 },
  ];

  for (const [i, c] of cases.entries()) {
    const cat = await store.createCategory(c.catAmount, ` AMT ${i}`);

    const init = await fetch(`${base}/api/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstname: 'ZZZ SYNTHETIC TEST DO NOT PROCESS',
        email: `${DONOR_EMAIL_PREFIX}-init-${i}@invalid.test`,
        phone: '9999999999',
        productinfo: 'Donation',
        category: cat.id,
        quantity: c.quantity,
        extraAmount: c.extraAmount,
      }),
    }).then((r) => r.json());

    const pd = init.paymentData;
    const echoed = {
      status: 'success',
      amount: pd.amount,
      txnid: pd.txnid,
      email: pd.email,
      firstname: pd.firstname,
      productinfo: pd.productinfo,
      udf1: pd.udf1,
      udf2: pd.udf2,
      udf3: pd.udf3,
      udf4: pd.udf4,
      udf5: pd.udf5,
      mihpayid: 'MIH' + crypto.randomBytes(6).toString('hex'),
      mode: 'CC',
      bank_ref_num: '1',
    };
    echoed.hash = signResponse(echoed);
    await postForm('success', echoed);

    const d = await store.readDonation(String(init.donationId));
    assert.equal(
      d.paymentStatus,
      'Paid',
      `db=${d.amountMajor} payu="${pd.amount}" was refused`
    );
  }
});

// =============================================================================
// Observability change (merged as b201818, previously untested)
// =============================================================================

test('/success records the PayU status verbatim', async () => {
  const { id, txnid } = await freshDonation();
  await postForm('success', payload({ status: 'success', amount: '1500.00', txnid, donationId: id }));

  const d = await store.readDonation(id);
  assert.equal(d.gatewayStatus, 'success', 'gateway status was not persisted');
});

test('/success merges payment details instead of replacing them', async () => {
  // Seeds a field /success itself never writes, then calls /success. Under
  // whole-subdocument assignment the seeded field is destroyed; under
  // field-level update it survives. Isolates the merge behaviour from any
  // question about what PayU would realistically send.
  const { id, txnid } = await freshDonation();
  await store.seedPaymentDetail(id, 'error_Message', 'SENTINEL-FROM-EARLIER-WRITER');

  await postForm('success', payload({ status: 'success', amount: '1500.00', txnid, donationId: id }));

  const d = await store.readDonation(id);
  assert.equal(d.detailErrorMessage, 'SENTINEL-FROM-EARLIER-WRITER', 'earlier writer was clobbered');
  assert.ok(d.mihpayid, '/success must still write its own fields');
});

test('a webhook followed by /success preserves the webhook data', async () => {
  // The ordering ADR-024 named. Note the hotfix's idempotency guard already
  // covers this particular order - a webhook carrying status=success marks
  // the donation Paid, so the later /success returns early. Asserted so a
  // Phase 3 change to either guard cannot silently reintroduce the loss.
  const { id, txnid } = await freshDonation();
  const p = payload({
    status: 'success',
    amount: '1500.00',
    txnid,
    donationId: id,
    extra: { error_Message: 'SENTINEL-FROM-WEBHOOK' },
  });

  await fetch(`${base}/api/payment/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(p).toString(),
  });
  const afterWebhook = await store.readDonation(id);
  assert.equal(afterWebhook.paymentStatus, 'Paid');

  await postForm('success', p);
  const d = await store.readDonation(id);
  assert.equal(d.detailErrorMessage, 'SENTINEL-FROM-WEBHOOK');
});

test('/cancel invents no error text and stores the PayU status verbatim', async () => {
  // The hardcoded 'Payment cancelled by user' fallback wrote OUR string into
  // a field meant to hold PayU's, making the two indistinguishable. No
  // error_Message is sent here, so nothing may be invented in its place.
  const { id, txnid } = await freshDonation();
  await postForm(
    'cancel',
    payload({
      status: 'failure',
      amount: '1500.00',
      txnid,
      donationId: id,
      extra: { unmappedstatus: 'usercancelled' },
    })
  );

  const d = await store.readDonation(id);
  assert.equal(d.errorMessage, null, 'error text must not be invented');
  assert.equal(d.gatewayStatus, 'failure', 'PayU status must be stored verbatim');
});
