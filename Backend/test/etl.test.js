/**
 * =============================================================================
 * ETL (Phase 4a) - round trip, every pre-flight report, idempotency
 * =============================================================================
 *   docker compose up -d          (MongoDB and MySQL both required)
 *   npm run test:etl
 *
 * EVERY PRE-FLIGHT REPORT IS DEMONSTRATED FIRING ON DELIBERATELY BAD DATA,
 * to the standard the injected-drift proof set. A report that has never been
 * seen to fire is not a control; it is a function that has never returned true.
 *
 * AK3 APPLIES HERE TOO, and with more force than anywhere else: this suite's
 * whole subject is data that exists in the OLD store and not the new one. The
 * un-migrated fixture is not an add-on here - it is the input.
 * =============================================================================
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_etl_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';

const mongoose = require('mongoose');
const User = require('../models/User');
const Category = require('../models/Category');
const Donation = require('../models/Donation');
const PendingSignup = require('../models/PendingSignup');
const { getPrisma, disconnect } = require('../config/prisma');
const preflight = require('../etl/preflight');
const { runMigration } = require('../etl/migrate');
const { assertLocalTarget } = require('../etl/cli');

const TAG = 'zzz-etl';
const CAT = 'ZZZ ETL';

let prisma;
const models = { User, Category, Donation, PendingSignup };

const oid = () => new mongoose.Types.ObjectId();

async function clearMongo() {
  await Promise.all([
    User.deleteMany({ email: new RegExp('^' + TAG) }),
    Category.deleteMany({ name: new RegExp('^' + CAT) }),
    Donation.deleteMany({ donorEmail: new RegExp('^' + TAG) }),
    PendingSignup.deleteMany({ email: new RegExp('^' + TAG) }),
  ]);
}

async function clearMysql() {
  // Child rows first - FK order in reverse.
  const cats = await prisma.category.findMany({ where: { name: { startsWith: CAT } } });
  const catIds = cats.map((c) => c.id);
  const dons = await prisma.donation.findMany({ where: { donorEmail: { startsWith: TAG } } });
  await prisma.donationPaymentDetail.deleteMany({
    where: { donationId: { in: dons.map((d) => d.id) } },
  });
  await prisma.donation.deleteMany({ where: { donorEmail: { startsWith: TAG } } });
  await prisma.categoryDescription.deleteMany({ where: { categoryId: { in: catIds } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: CAT } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
}

/** A complete, valid MongoDB dataset: the ETL's input. */
async function seedMongo() {
  const cat = await Category.create({
    _id: oid(),
    name: `${CAT} reef`,
    sortDescription: 'Reef restoration',
    donationAmount: 1500,
    descriptions: ['first', 'second', 'third'],
    displayOrder: 2,
  });
  const user = await User.create({
    _id: oid(),
    name: 'ZZZ Etl Donor',
    email: `${TAG}-donor@invalid.test`,
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456',
    role: 'user',
    phone: '123',
    isVerified: true,
    isActive: true,
    resetPasswordAttempts: 3,
    resetPasswordCode: '123456',
  });
  const donation = await Donation.create({
    _id: oid(),
    donorName: 'ZZZ Etl Donor',
    donorEmail: `${TAG}-donor@invalid.test`,
    userId: user._id,
    category: cat._id,
    quantity: 2,
    baseAmount: 3000,
    extraAmount: 49.99,
    amount: 3049.99,
    status: 'Approved',
    paymentStatus: 'Paid',
    date: new Date('2024-06-01T10:00:00Z'),
    transactionId: 'TXN123',
    paymentDetails: { mihpayid: 'MIH-1', amount: 3049.99, mode: 'CC', bank_ref_num: 'BRN1' },
  });
  const guest = await Donation.create({
    _id: oid(),
    donorName: 'ZZZ Etl Guest',
    donorEmail: `${TAG}-guest@invalid.test`,
    userId: null,
    category: cat._id,
    baseAmount: 1500,
    amount: 1500,
    date: new Date('2024-07-01T10:00:00Z'),
  });
  // Explicitly NOT migrated - the AK3 fixture in its purest form.
  await PendingSignup.create({
    email: `${TAG}-pending@invalid.test`,
    name: 'ZZZ Pending',
    password: '$2b$10$x',
    signupOTP: '999999',
    signupOTPExpires: new Date(Date.now() + 600000),
  });
  return { cat, user, donation, guest };
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
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point at a schema-applied MySQL 8.4');
  await mongoose.connect(process.env.MONGODB_URI);
  prisma = getPrisma();
});

after(async () => {
  try {
    await clearMysql();
    await clearMongo();
  } finally {
    await mongoose.connection.close();
    await disconnect();
  }
});

beforeEach(async () => {
  await clearMysql();
  await clearMongo();
});

// =============================================================================
// The local-only guard
// =============================================================================

test('the ETL refuses an Atlas target outright', () => {
  assert.throws(
    () => assertLocalTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/kindledger'),
    /Atlas|LOCAL ONLY/,
    'Phase 4a must not be able to touch production even by accident'
  );
  assert.throws(() => assertLocalTarget('mongodb://prod-db.example.com:27017/x'), /local host/);
  assert.doesNotThrow(() => assertLocalTarget('mongodb://127.0.0.1:27017/kindledger'));
  assert.doesNotThrow(() => assertLocalTarget('mongodb://mongo:27017/kindledger'));
});

// =============================================================================
// Round trip
// =============================================================================

test('round trip: every entity lands with legacy_id, remapped FKs and minor units', async () => {
  const seed = await seedMongo();
  const stats = await runMigration({ prisma, models });

  assert.equal(stats.loaded.categories, 1);
  assert.equal(stats.loaded.categoryDescriptions, 3);
  assert.equal(stats.loaded.users, 1);
  assert.equal(stats.loaded.donations, 2);
  assert.equal(stats.loaded.paymentDetails, 1);

  // legacy_id carries the ObjectId on every migrated row.
  const cat = await prisma.category.findUnique({
    where: { legacyId: String(seed.cat._id) },
    include: { descriptions: { orderBy: { position: 'asc' } } },
  });
  assert.ok(cat, 'category resolves by legacy_id');
  assert.match(cat.uuid, /^[0-9a-f]{8}-/, 'a FRESH uuid, not the ObjectId');
  assert.equal(cat.donationAmountMinor, 150000n, 'money as integer minor units');
  assert.equal(cat.shortDescription, 'Reef restoration', 'sortDescription -> short_description');
  assert.deepEqual(cat.descriptions.map((d) => d.text), ['first', 'second', 'third']);
  assert.deepEqual(cat.descriptions.map((d) => d.position), [0, 1, 2]);

  const user = await prisma.user.findUnique({ where: { legacyId: String(seed.user._id) } });
  assert.equal(user.email, `${TAG}-donor@invalid.test`);
  assert.equal(user.passwordHash, seed.user.password, 'the bcrypt hash is carried verbatim');
  assert.equal(user.tokenVersion, 0);
  assert.equal(user.resetCodeAttempts, 3, 'the ATTEMPT COUNTER is carried (ADR-034)');
  assert.equal(user.resetCodeHash, null, 'but the plaintext reset code is NOT');

  const don = await prisma.donation.findUnique({
    where: { legacyId: String(seed.donation._id) },
    include: { paymentDetails: true },
  });
  assert.equal(don.userId, user.id, 'FK remapped by legacy_id, not by position');
  assert.equal(don.categoryId, cat.id);
  assert.equal(don.baseAmountMinor, 300000n);
  assert.equal(don.extraAmountMinor, 4999n, '49.99 -> 4999 paise');
  assert.equal(don.amountMinor, 304999n);
  assert.notEqual(don.transactionRef, 'TXN123', 'a FRESH transaction_ref, not the guessable one');
  assert.match(don.transactionRef, /^[0-9a-f]{8}-/);
  assert.equal(don.donatedAt.toISOString(), '2024-06-01T10:00:00.000Z', 'donated_at from Mongo date');
  assert.equal(don.paymentDetails.mihpayid, 'MIH-1');
  assert.equal(don.paymentDetails.amountMinor, 304999n);
  assert.equal(don.paymentDetails.gatewayStatus, null, 'NULL for the pre-cutover population (ADR-025)');

  const guest = await prisma.donation.findUnique({ where: { legacyId: String(seed.guest._id) } });
  assert.equal(guest.userId, null, 'a guest donation keeps a null user, not a fabricated one');

  // AK3, in its purest form: a record that exists in the OLD store and is
  // deliberately NOT migrated. The ETL must report it rather than omit it.
  assert.equal(stats.notMigrated.pendingSignups, 1);
  assert.match(stats.notMigrated.reason, /5\.2/);
});

test('createdAt is carried explicitly, not stamped with the import time (ADR-054)', async () => {
  // The failure this prevents: an ETL that lets created_at default makes the
  // retention purge a no-op for a decade, silently.
  const old = new Date('2019-03-04T05:06:07.000Z');
  await Category.create({
    _id: oid(),
    name: `${CAT} old`,
    sortDescription: 's',
    donationAmount: 10,
    createdAt: old,
    updatedAt: old,
  });
  await runMigration({ prisma, models });

  const cat = await prisma.category.findFirst({ where: { name: `${CAT} old` } });
  assert.equal(cat.createdAt.toISOString(), old.toISOString());
});

// =============================================================================
// Idempotency - five route packages will run this repeatedly
// =============================================================================

test('a second run changes nothing, and skips by legacy_id rather than by IGNORE', async () => {
  await seedMongo();
  const first = await runMigration({ prisma, models });
  assert.equal(first.loaded.donations, 2);

  const second = await runMigration({ prisma, models });
  assert.equal(second.loaded.categories, 0);
  assert.equal(second.loaded.users, 0);
  assert.equal(second.loaded.donations, 0);
  assert.equal(second.skipped.categories, 1, 'skipped as a DECISION the ETL reports');
  assert.equal(second.skipped.users, 1);
  assert.equal(second.skipped.donations, 2);

  assert.equal(await prisma.donation.count({ where: { donorEmail: { startsWith: TAG } } }), 2);
});

test('it resumes a PARTIALLY loaded database', async () => {
  const seed = await seedMongo();
  await runMigration({ prisma, models });

  // Simulate an interrupted run: remove one donation from MySQL only.
  await prisma.donationPaymentDetail.deleteMany({
    where: { donation: { legacyId: String(seed.donation._id) } },
  });
  await prisma.donation.delete({ where: { legacyId: String(seed.donation._id) } });

  const again = await runMigration({ prisma, models });
  assert.equal(again.loaded.donations, 1, 'only the missing row is loaded');
  assert.equal(again.skipped.donations, 1);
});

// =============================================================================
// Every pre-flight report, demonstrated firing
// =============================================================================

test('PRE-FLIGHT: strict SQL mode is checked on the ETL OWN connection', async () => {
  const clean = await preflight.checkStrictMode(prisma);
  assert.deepEqual(clean, [], 'the real connection is strict');

  // A stub standing in for a permissive connection. The point is the DECISION,
  // not the plumbing: a non-strict session must be FATAL and non-overridable,
  // because every write after it is untrustworthy.
  const relaxed = await preflight.checkStrictMode({
    $queryRawUnsafe: async () => [{ mode: 'NO_ENGINE_SUBSTITUTION' }],
  });
  assert.equal(relaxed.length, 1);
  assert.equal(relaxed[0].severity, 'FATAL');
  assert.match(relaxed[0].detail, /truncated|clamped/);
});

test('PRE-FLIGHT: case-variant duplicate emails', async () => {
  await User.create({ _id: oid(), name: 'a', email: `${TAG}-Dup@invalid.test`, password: 'x' });
  await User.create({ _id: oid(), name: 'b', email: `${TAG}-dup@invalid.test`, password: 'x' });

  const f = await preflight.checkDuplicateEmails(User);
  assert.equal(f.length, 1);
  assert.equal(f[0].blocking, true);
  assert.match(f[0].detail, /2 accounts collapse/);
  assert.match(f[0].detail, /will not choose/, 'the ETL must not pick a winner');
});

test('PRE-FLIGHT: mixed-case status, with the count that is the only record of BUG-02', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} mc`, sortDescription: 's', donationAmount: 10,
  });
  // insertOne, NOT create: Mongoose DOES enforce the enum on create. BUG-02
  // exists because findByIdAndUpdate does not, so the only way to produce the
  // real-world state is to bypass validation exactly as that path does.
  for (const st of ['approved', 'approved', 'rejected']) {
    await Donation.collection.insertOne({
      donorName: 'x', donorEmail: `${TAG}-mc@invalid.test`, quantity: 1,
      category: cat._id, amount: 10, status: st, date: new Date('2024-01-01'),
    });
  }

  const f = await preflight.checkMixedCaseStatus(Donation);
  const lower = f.find((x) => /status='approved'/.test(x.detail));
  assert.ok(lower, 'the lowercase value is reported');
  assert.match(lower.detail, /^2 donation/, 'WITH ITS COUNT');
  assert.match(lower.detail, /ONLY RECORD/);
  assert.equal(lower.blocking, false, 'canonicalisable, so it loads - but it is recorded');
});

test('PRE-FLIGHT: a status in NO casing is blocking, not canonicalised', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} junk`, sortDescription: 's', donationAmount: 10,
  });
  await Donation.collection.insertOne({
    donorName: 'x', donorEmail: `${TAG}-junk@invalid.test`, category: cat._id,
    amount: 10, status: 'banana', date: new Date('2024-01-01'), quantity: 1,
  });

  const f = await preflight.checkMixedCaseStatus(Donation);
  const junk = f.find((x) => /banana/.test(x.detail));
  assert.ok(junk);
  assert.equal(junk.blocking, true);
  assert.match(junk.detail, /REJECT/);
});

test('PRE-FLIGHT: float-to-paise rounding deltas', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} round`, sortDescription: 's', donationAmount: 10,
  });
  await Donation.create({
    _id: oid(), donorName: 'x', donorEmail: `${TAG}-round@invalid.test`,
    category: cat._id, amount: 10.005, date: new Date('2024-01-01'),
  });

  const f = await preflight.checkRounding(Donation);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /do not convert exactly to paise/);
  assert.match(f[0].detail, /only record/);
});

test('PRE-FLIGHT: amount != base + extra', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} sum`, sortDescription: 's', donationAmount: 10,
  });
  await Donation.create({
    _id: oid(), donorName: 'x', donorEmail: `${TAG}-sum@invalid.test`,
    category: cat._id, baseAmount: 100, extraAmount: 10, amount: 999,
    date: new Date('2024-01-01'),
  });

  const f = await preflight.checkAmountConsistency(Donation);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /amount != base \+ extra/);
  assert.equal(f[0].blocking, false, 'migrated verbatim - the schema has no CHECK on purpose');
});

test('PRE-FLIGHT: orphaned category references are BLOCKING', async () => {
  const ghost = oid();
  await Donation.collection.insertOne({
    donorName: 'x', donorEmail: `${TAG}-orphan@invalid.test`, category: ghost,
    amount: 10, date: new Date('2024-01-01'), quantity: 1,
  });

  const f = await preflight.checkOrphanedCategories(Donation, Category);
  assert.equal(f.length, 1);
  assert.equal(f[0].blocking, true);
  assert.match(f[0].detail, /ON DELETE RESTRICT/);
  assert.match(f[0].detail, /will not invent one/);
});

test('PRE-FLIGHT: implausible dates are BLOCKING and never corrected', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} date`, sortDescription: 's', donationAmount: 10,
  });
  await Donation.collection.insertOne({
    donorName: 'x', donorEmail: `${TAG}-date@invalid.test`, category: cat._id,
    amount: 10, date: new Date('1970-01-01T00:00:00Z'), quantity: 1,
  });

  const f = await preflight.checkDates(Donation);
  assert.equal(f.length, 1);
  assert.equal(f[0].blocking, true);
  assert.match(f[0].detail, /never corrected/);
  assert.match(f[0].detail, /BUG-10/, 'it names the consequence, not just the condition');
});

// =============================================================================
// The load refuses to invent what the pre-flight refused to correct
// =============================================================================

test('an orphaned category FAILS THE LOAD rather than being invented', async () => {
  // The pre-flight blocks it. If an operator overrides, the load must still
  // refuse - "report, never silently correct" has to hold at both layers, or
  // the override becomes a licence to fabricate.
  await Donation.collection.insertOne({
    donorName: 'x', donorEmail: `${TAG}-orphan2@invalid.test`, category: oid(),
    amount: 10, date: new Date('2024-01-01'), quantity: 1,
  });

  await assert.rejects(
    () => runMigration({ prisma, models }),
    /does not resolve|not invented/,
    'the load must fail loudly, not skip the row'
  );
});

test('an implausible date FAILS THE LOAD even if the pre-flight was overridden', async () => {
  const cat = await Category.create({
    _id: oid(), name: `${CAT} d2`, sortDescription: 's', donationAmount: 10,
  });
  await Donation.collection.insertOne({
    donorName: 'x', donorEmail: `${TAG}-date2@invalid.test`, category: cat._id,
    amount: 10, date: new Date('1970-01-01T00:00:00Z'), quantity: 1,
  });

  await assert.rejects(() => runMigration({ prisma, models }), /implausible date/);
});

test('the full pre-flight reports clean on the seeded dataset', async () => {
  await seedMongo();
  const result = await preflight.runPreflight({ prisma, models });
  assert.deepEqual(
    result.blocking.map((f) => f.check),
    [],
    `unexpected blocking findings: ${JSON.stringify(result.blocking, null, 2)}`
  );
  assert.equal(result.fatal.length, 0);
});
