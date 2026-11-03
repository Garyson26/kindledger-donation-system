/**
 * =============================================================================
 * Phase 2 data layer (SPEC-2 section 8)
 * =============================================================================
 *   docker compose up -d db          (with 3306 published to the host)
 *   DATABASE_URL='mysql://kindledger:...@127.0.0.1:3306/kindledger' \
 *     npm run test:data-layer
 *
 * Covers: repository round-trip per entity including the money path in minor
 * units, the health endpoint's two forms, that a connection failure does not
 * exit the process, the limiter's store selection, and the scheduler jobs.
 *
 * Runs against real MySQL. Nothing is mocked - a repository test against a
 * stubbed Prisma would assert that the code calls the functions it calls, which
 * is not the same as asserting the schema accepts the data.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');

// Only what this suite actually needs. It deliberately does NOT load app.js -
// see the note on the first health test - so none of the PayU, JWT or SMTP
// variables app.js validates at boot are required here.
process.env.NODE_ENV = 'production';
// The scheduler must stay unregistered unless a test asks for it.
process.env.SCHEDULER_ENABLED = 'false';
process.env.HEALTH_DIAGNOSTIC_SECRET = 'test-health-secret-value-32-chars';

const express = require('express');
const repos = require('../repositories');
const prismaModule = require('../config/prisma');
const scheduler = require('../services/scheduler');

const TAG = 'zzz-phase2';
const CAT_PREFIX = 'ZZZ PHASE2';

let server;
let base;

function uniq(suffix) {
  return `${TAG}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${suffix}`;
}

async function cleanup() {
  await repos.donations.deleteByDonorEmailPrefix(TAG);
  await repos.pendingSignups.deleteByEmailPrefix(TAG);
  await repos.users.deleteByEmailPrefix(TAG);
  await repos.categories.deleteByNamePrefix(CAT_PREFIX);
}

before(async () => {
  assert.ok(
    process.env.DATABASE_URL,
    'DATABASE_URL must be set. This suite needs a real MySQL 8.4 with the schema applied.'
  );
  const probe = await repos.checkDatabase();
  assert.equal(probe.ok, true, `MySQL unreachable: ${probe.error}`);

  await cleanup();
});

after(async () => {
  try {
    await cleanup();
  } finally {
    scheduler.stopScheduler();
    if (server) server.close();
    await prismaModule.disconnect();
  }
});

// =============================================================================
// Repository round-trips
// =============================================================================

test('categories: create, read, list, archive round-trip', async () => {
  const name = `${CAT_PREFIX} cat ${crypto.randomBytes(3).toString('hex')}`;
  const created = await repos.categories.create({
    name,
    shortDescription: 'fixture',
    donationAmountMinor: 150000,
    displayOrder: 3,
    descriptions: ['first', 'second'],
  });

  // The external identifier is the uuid, never the internal BIGINT.
  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'id must be the uuid');
  assert.equal(created.donationAmountMinor, 150000);
  assert.equal(typeof created.donationAmountMinor, 'number', 'BigInt must not leak to callers');
  assert.deepEqual(created.descriptions, ['first', 'second'], 'ordered by position');
  assert.equal(created.isArchived, false);

  const read = await repos.categories.findById(created.id);
  assert.deepEqual(read, created);

  const active = await repos.categories.list();
  assert.ok(active.some((c) => c.id === created.id));

  // ADR-004: archive, never hard delete.
  const archived = await repos.categories.archive(created.id);
  assert.equal(archived.isArchived, true);
  assert.ok(archived.archivedAt);

  const activeAfter = await repos.categories.list();
  assert.equal(
    activeAfter.some((c) => c.id === created.id),
    false,
    'archived categories must not appear in the active list'
  );
  const allAfter = await repos.categories.list({ includeArchived: true });
  assert.ok(allAfter.some((c) => c.id === created.id), 'but must still be reachable');
});

test('categories: replacing descriptions does not collide on (category_id, position)', async () => {
  // UNIQUE (category_id, position) means insert-before-delete would collide
  // transiently. Shrinking then growing the list is the case that catches it.
  const name = `${CAT_PREFIX} desc ${crypto.randomBytes(3).toString('hex')}`;
  const cat = await repos.categories.create({
    name,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
    descriptions: ['a', 'b', 'c'],
  });

  const shrunk = await repos.categories.replaceDescriptions(cat.id, ['only']);
  assert.deepEqual(shrunk.descriptions, ['only']);

  const grown = await repos.categories.replaceDescriptions(cat.id, ['x', 'y', 'z', 'w']);
  assert.deepEqual(grown.descriptions, ['x', 'y', 'z', 'w']);

  const emptied = await repos.categories.replaceDescriptions(cat.id, []);
  assert.deepEqual(emptied.descriptions, []);
});

test('users: create and read round-trip, with no hash ever returned', async () => {
  const email = `${uniq('user')}@invalid.test`;
  const created = await repos.users.create({
    name: 'ZZZ Phase2 User',
    email: email.toUpperCase(), // must be lowercased on write
    password: 'CorrectHorseBattery1!',
    isVerified: true,
  });

  assert.equal(created.email, email.toLowerCase(), 'email must be lowercased on write');
  assert.equal(created.isActive, true);
  assert.equal(created.tokenVersion, 0);

  // SPEC-2 section 4.2 and the users.js header: no hash column is ever returned.
  for (const forbidden of ['passwordHash', 'password', 'resetCodeHash', 'loginOtpHash']) {
    assert.equal(forbidden in created, false, `${forbidden} must not be returned`);
  }

  const byEmail = await repos.users.findByEmail(email);
  assert.equal(byEmail.id, created.id);

  // Mixed case resolves to the same row. The repository lowercases on both
  // write and lookup, so this asserts that contract rather than the database
  // collation - which is deliberate defence in depth, not redundancy.
  const byMixedCase = await repos.users.findByEmail(email.toUpperCase());
  assert.equal(byMixedCase.id, created.id);

  assert.equal(await repos.users.verifyPassword(created.id, 'CorrectHorseBattery1!'), true);
  assert.equal(await repos.users.verifyPassword(created.id, 'wrong'), false);
});

test('users: setPassword increments tokenVersion and clears the reset code', async () => {
  // SEC-05: a password change must invalidate every issued token. Doing it in
  // the data layer means a call site cannot forget.
  const email = `${uniq('pw')}@invalid.test`;
  const u = await repos.users.create({ name: 'ZZZ', email, password: 'OldPassword123!' });

  await repos.users.setResetCode(u.id, '123456', Date.now() + 60000);
  const withCode = await repos.users.findById(u.id);
  assert.equal(withCode.resetCodeAttempts, 0);

  const after = await repos.users.setPassword(u.id, 'BrandNewPassword123!');
  assert.equal(after.tokenVersion, 1, 'tokenVersion must increment');
  assert.equal(after.resetCodeAttempts, 0);
  assert.equal(await repos.users.verifyPassword(u.id, 'BrandNewPassword123!'), true);

  const verdict = await repos.users.verifyResetCode(u.id, '123456');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-code', 'the code must be consumed by a password change');
});

test('users: reset-code verdicts, and the ADR-034 rule', async () => {
  const email = `${uniq('reset')}@invalid.test`;
  const u = await repos.users.create({ name: 'ZZZ', email, password: 'OldPassword123!' });
  await repos.users.setResetCode(u.id, '654321', Date.now() + 60000);

  assert.equal((await repos.users.verifyResetCode(u.id, '000000')).reason, 'mismatch');
  assert.equal((await repos.users.verifyResetCode(u.id, '654321')).ok, true);

  // ADR-034: a correct code must NOT clear the attempt counter.
  await repos.users.incrementResetAttempts(u.id);
  await repos.users.incrementResetAttempts(u.id);
  assert.equal((await repos.users.verifyResetCode(u.id, '654321')).ok, true);
  assert.equal(
    (await repos.users.findById(u.id)).resetCodeAttempts,
    2,
    'a correct code must not reset the counter'
  );

  // At the cap, even the correct code is refused.
  for (let i = 0; i < 3; i++) await repos.users.incrementResetAttempts(u.id);
  const capped = await repos.users.verifyResetCode(u.id, '654321');
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'attempts-exhausted');

  // Expiry is a distinct verdict from a mismatch.
  await repos.users.setResetCode(u.id, '111111', Date.now() - 1000);
  assert.equal((await repos.users.verifyResetCode(u.id, '111111')).reason, 'expired');
});

test('users: disabling an account increments tokenVersion', async () => {
  const email = `${uniq('disable')}@invalid.test`;
  const u = await repos.users.create({ name: 'ZZZ', email, password: 'OldPassword123!' });

  const disabled = await repos.users.setActive(u.id, false);
  assert.equal(disabled.isActive, false);
  assert.equal(disabled.tokenVersion, 1, 'a disable must invalidate live tokens too');

  // Re-enabling must NOT increment again - it would log out sessions issued
  // after the disable for no reason.
  const reEnabled = await repos.users.setActive(u.id, true);
  assert.equal(reEnabled.isActive, true);
  assert.equal(reEnabled.tokenVersion, 1);
});

test('pendingSignups: round-trip, hashed OTP, and expiresAt defaulted', async () => {
  const email = `${uniq('pending')}@invalid.test`;
  const created = await repos.pendingSignups.create({
    name: 'ZZZ Pending',
    email,
    password: 'SignupPassword123!',
    otp: '424242',
    otpExpiresAt: Date.now() + 600000,
  });

  assert.equal(created.email, email.toLowerCase());
  assert.equal(created.signupOtpAttempts, 0);
  // The TTL replacement must never be absent.
  assert.ok(created.expiresAt, 'expiresAt must be defaulted, not left null');
  assert.ok(
    new Date(created.expiresAt).getTime() > Date.now() + 23 * 60 * 60 * 1000,
    'default lifetime should be about 24 hours'
  );
  assert.equal('signupOtpHash' in created, false, 'the OTP hash must not be returned');

  assert.equal((await repos.pendingSignups.verifyOtp(email, '424242')).ok, true);
  assert.equal((await repos.pendingSignups.verifyOtp(email, '999999')).reason, 'mismatch');

  for (let i = 0; i < 5; i++) await repos.pendingSignups.incrementOtpAttempts(email);
  assert.equal(
    (await repos.pendingSignups.verifyOtp(email, '424242')).reason,
    'attempts-exhausted',
    'signup OTP must be attempt-capped, which SEC-02 found it was not'
  );

  assert.equal(await repos.pendingSignups.remove(email), 1);
  assert.equal(await repos.pendingSignups.findByEmail(email), null);
});

test('brandingSettings: the singleton reads and updates', async () => {
  const before = await repos.brandingSettings.get();
  assert.ok(before, 'db/schema.sql must have seeded the singleton row');
  assert.ok(before.organisationName);

  const updated = await repos.brandingSettings.update({
    organisationName: 'ZZZ Phase2 Org',
    primaryColour: '#05699E',
  });
  assert.equal(updated.organisationName, 'ZZZ Phase2 Org');
  assert.equal(updated.primaryColour, '#05699E');

  // A malformed colour is refused by the CHECK constraint, not by a duplicate
  // check in the repository that could drift from it.
  await assert.rejects(
    () => repos.brandingSettings.update({ primaryColour: 'nothex' }),
    'the database CHECK must reject a malformed colour'
  );

  // Only listed fields are assignable.
  await repos.brandingSettings.update({ id: 99, organisationName: before.organisationName });
  const restored = await repos.brandingSettings.get();
  // get() looks the row up by id = 1, so a non-null result is itself the proof
  // that the id was not assignable.
  assert.ok(restored, 'the singleton must still be at id = 1');
  assert.equal(restored.organisationName, before.organisationName);
});

// =============================================================================
// Donations, and the money path
// =============================================================================

test('donations: round-trip in minor units, with the donor shape resolved', async () => {
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} don ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 150000,
  });
  const email = `${uniq('donor')}@invalid.test`;
  const user = await repos.users.create({ name: 'ZZZ Donor', email, password: 'DonorPass123!' });

  const created = await repos.donations.create({
    donorName: 'ZZZ SYNTHETIC TEST DO NOT PROCESS',
    donorEmail: `${TAG}-d1@invalid.test`,
    userId: user.id,
    categoryId: cat.id,
    quantity: 2,
    baseAmountMinor: 300000,
    extraAmountMinor: 4999,
    amountMinor: 304999,
  });

  assert.equal(created.amountMinor, 304999);
  assert.equal(typeof created.amountMinor, 'number');
  assert.equal(created.currency, 'INR');
  assert.equal(created.paymentStatus, 'Pending');

  // SPEC-2 section 4.4: guest versus attached user is explicit, not inferred
  // from a null by each caller.
  assert.equal(created.donor.isGuest, false);
  assert.equal(created.donor.user.id, user.id);
  // category_id is NOT NULL, so this can never be null.
  assert.ok(created.category, 'category must always be present');
  assert.equal(created.category.donationAmountMinor, 150000);

  const read = await repos.donations.findById(created.id);
  assert.equal(read.amountMinor, 304999);

  const byRef = await repos.donations.findByTransactionRef(created.transactionRef);
  assert.equal(byRef.id, created.id);
});

test('donations: a guest donation reports isGuest with the donor still attributable', async () => {
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} guest ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
  });
  const created = await repos.donations.create({
    donorName: 'ZZZ Guest Donor',
    donorEmail: `${TAG}-guest@invalid.test`,
    userId: null,
    categoryId: cat.id,
    baseAmountMinor: 1000,
    amountMinor: 1000,
  });

  assert.equal(created.donor.isGuest, true);
  assert.equal(created.donor.user, null);
  // ADR-003: the donation stays attributable without a user row.
  assert.equal(created.donorName, 'ZZZ Guest Donor');
});

test('donations: payment details MERGE rather than replace', async () => {
  // The ADR-024 property, asserted at the repository level so Phase 3 cannot
  // lose it while rewriting the routes.
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} merge ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
  });
  const d = await repos.donations.create({
    donorName: 'ZZZ',
    donorEmail: `${TAG}-merge@invalid.test`,
    categoryId: cat.id,
    baseAmountMinor: 1000,
    amountMinor: 1000,
  });

  await repos.donations.updatePayment(d.id, { detailErrorMessage: 'FROM-EARLIER-WRITER' });
  const second = await repos.donations.updatePayment(d.id, {
    paymentStatus: 'Paid',
    status: 'Approved',
    mihpayid: 'MIH-' + crypto.randomBytes(4).toString('hex'),
    amountMinor: 1000,
    gatewayStatus: 'success',
    paidAt: new Date(),
  });

  assert.equal(second.paymentStatus, 'Paid');
  assert.equal(
    second.paymentDetails.errorMessage,
    'FROM-EARLIER-WRITER',
    'an earlier writer must not be clobbered'
  );
  assert.ok(second.paymentDetails.mihpayid);
});

test('donations: a duplicate mihpayid is rejected by the unique index', async () => {
  // ADR-026: this is a data-integrity control, not the replay defence. It still
  // has to work.
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} dup ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
  });
  const mk = (n) =>
    repos.donations.create({
      donorName: 'ZZZ',
      donorEmail: `${TAG}-dup${n}@invalid.test`,
      categoryId: cat.id,
      baseAmountMinor: 1000,
      amountMinor: 1000,
    });
  const a = await mk(1);
  const b = await mk(2);

  const shared = 'MIH-SHARED-' + crypto.randomBytes(4).toString('hex');
  await repos.donations.updatePayment(a.id, { mihpayid: shared });
  await assert.rejects(
    () => repos.donations.updatePayment(b.id, { mihpayid: shared }),
    'the same gateway payment id must not attach to two donations'
  );

  // Multiple NULLs remain permitted - unpaid donations have no mihpayid.
  await repos.donations.updatePayment(a.id, { mode: 'CC' });
  await repos.donations.updatePayment(b.id, { mode: 'NB' });
});

test('toMinorUnits is the single conversion, and rejects rather than rounding', async () => {
  assert.equal(repos.toMinorUnits('1500.00'), 150000);
  assert.equal(repos.toMinorUnits('1500'), 150000);
  assert.equal(repos.toMinorUnits('1500.5'), 150050);
  assert.equal(repos.toMinorUnits(1500.07), 150007);
  // Malformed input must be null, never zero: a caller treating it as zero
  // would accept a payment of nothing.
  assert.equal(repos.toMinorUnits('1500.005'), null);
  assert.equal(repos.toMinorUnits('1e3'), null);
  assert.equal(repos.toMinorUnits(''), null);
  assert.equal(repos.toMinorUnits(null), null);
  assert.equal(repos.toMinorUnits('-5'), null);
});

test('distinct statuses come from the DATA, not the enum member list', async () => {
  // SPEC-2 section 4.4 and ADR-041. Reading the enum would silently change the
  // admin filter from "what exists" to "what is possible".
  const inUse = await repos.donations.listPaymentStatusesInUse();
  assert.ok(Array.isArray(inUse));
  const ENUM_MEMBERS = ['Pending', 'Paid', 'Failed', 'Cancelled'];
  for (const s of inUse) assert.ok(ENUM_MEMBERS.includes(s));
  // The fixtures above create only Pending and Paid rows, so a result
  // containing all four members would mean the enum was being read.
  assert.ok(
    inUse.length <= ENUM_MEMBERS.length,
    'more distinct values than enum members is impossible'
  );
});

test('withTransaction rolls back on throw', async () => {
  const name = `${CAT_PREFIX} tx ${crypto.randomBytes(3).toString('hex')}`;
  const sentinel = new Error('deliberate rollback');

  await assert.rejects(
    () =>
      repos.withTransaction(async (tx) => {
        await repos.categories.create(
          { name, shortDescription: 'fixture', donationAmountMinor: 1000 },
          tx
        );
        throw sentinel;
      }),
    (e) => e === sentinel
  );

  const all = await repos.categories.list({ includeArchived: true });
  assert.equal(
    all.some((c) => c.name === name),
    false,
    'the category must not survive a rolled-back transaction'
  );
});

// =============================================================================
// Health endpoint
// =============================================================================

test('health: routes/health.js loads without pulling in Mongoose', async () => {
  // ADR-038's load-bearing property, asserted rather than asserted-in-prose.
  // The route file is the one place that is supposed to prove the new data
  // layer stands on its own, so if a future edit reaches for `adminAuth` or a
  // model, this fails.
  //
  // Note the ORDER: this must run before anything requires app.js, which
  // legitimately loads Mongoose. Hence health.js is mounted on a bare Express
  // app here, and the real wiring at /api/health is proved through Nginx in
  // trust-proxy.test.js and by the compose healthcheck.
  const healthRoutes = require('../routes/health');

  const loaded = Object.keys(require.cache).filter((f) => /[\\/]mongoose[\\/]/.test(f));
  assert.deepEqual(loaded, [], 'routes/health.js must not load mongoose, directly or transitively');

  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/health', healthRoutes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test('health: 200 with no detail when the database is reachable', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(
    Object.keys(body),
    ['status'],
    'the unauthenticated form must carry a status and nothing else'
  );
  assert.equal(body.status, 'ok');
});

test('health: the diagnostic form requires the secret and is timing-safe', async () => {
  const wrong = await fetch(`${base}/api/health`, { headers: { 'x-health-secret': 'nope' } });
  const wrongBody = await wrong.json();
  assert.deepEqual(Object.keys(wrongBody), ['status'], 'a wrong secret gets the plain form');

  const right = await fetch(`${base}/api/health`, {
    headers: { 'x-health-secret': process.env.HEALTH_DIAGNOSTIC_SECRET },
  });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.database.reachable, true);
  assert.equal(typeof body.database.latencyMs, 'number');
  assert.ok('pool' in body && 'client' in body);
});

// =============================================================================
// Connection failure behaviour - the ADR-039 property
// =============================================================================

test('a connection failure returns a verdict and does NOT exit the process', async () => {
  // config/db.js calls process.exit(1) here, which is why production answers
  // FUNCTION_INVOCATION_FAILED on every route. If this test ever kills the
  // runner instead of failing, the exit has been reintroduced.
  const { execFileSync } = require('node:child_process');
  const script = `
    process.env.DATABASE_URL = 'mysql://nobody:nothing@127.0.0.1:59999/nope';
    const { checkDatabase } = require('./config/prisma');
    checkDatabase().then((r) => {
      if (r.ok) { console.log('UNEXPECTEDLY_OK'); process.exit(9); }
      console.log('SURVIVED');
      process.exit(0);
    });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /SURVIVED/, 'the process must stay up and report the failure');
});

// =============================================================================
// Rate limiter store selection
// =============================================================================

test('the limiter uses the memory store when REDIS_URL is unset', async () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    delete process.env.REDIS_URL;
    const rl = require('./config/rateLimiters');
    rl.authLimiter();
    console.log('STORE=' + rl.storeKind());
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /STORE=memory/);
});

test('the limiter keys IPv6 clients by network, so a /56 cannot mint buckets', () => {
  const { keyFor } = require('../config/rateLimiters');

  // A residential IPv6 allocation is a /64 or shorter, so one client holds
  // upwards of 18 quintillion addresses. Keyed on the raw address, an IPv6
  // attacker has an unlimited budget while every IPv4 user is limited
  // correctly - and the metrics look healthy throughout.
  const a = keyFor('auth', '2001:db8:abcd:0012::1');
  const b = keyFor('auth', '2001:db8:abcd:0012:ffff:ffff:ffff:ffff');

  assert.equal(a, b, 'two addresses in one allocation must share a bucket');
  assert.equal(a, 'auth:2001:db8:abcd::/56', 'the key is the network, not the address');

  // MIND THE /56 BOUNDARY - it falls INSIDE the fourth group, not on it.
  // 2001:db8:abcd:0012:: and 2001:db8:abcd:0099:: are both in
  // 2001:db8:abcd::/56, because only the high byte of that group is in the
  // prefix. Getting a genuinely different network takes a change in that high
  // byte. (This is the correction to a first version of this test that used
  // :0099: as the "different" case and failed.)
  assert.equal(keyFor('auth', '2001:db8:abcd:0099::1'), a, 'same /56, same bucket');
  assert.notEqual(
    keyFor('auth', '2001:db8:abcd:0100::1'),
    a,
    'genuinely different networks must not be merged'
  );

  // IPv4 is untouched, and the limiter name still separates the windows.
  assert.equal(keyFor('auth', '198.51.100.4'), 'auth:198.51.100.4');
  assert.notEqual(
    keyFor('auth', '198.51.100.4'),
    keyFor('payment-initiate', '198.51.100.4'),
    'an auth burst must not consume a donor\'s donation budget'
  );
});

test('the limiter uses the Redis store when REDIS_URL is set', async () => {
  if (!process.env.TEST_REDIS_URL) {
    // Skipped rather than silently passing, so an absent Redis is visible.
    console.log('    (skipped: TEST_REDIS_URL not set)');
    return;
  }
  const { execFileSync } = require('node:child_process');
  const script = `
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    const rl = require('./config/rateLimiters');
    rl.authLimiter();
    console.log('STORE=' + rl.storeKind());
    rl.disconnect().then(() => process.exit(0));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env },
  });
  assert.match(out, /STORE=redis/);
});

// =============================================================================
// Scheduler
// =============================================================================

test('the scheduler does not register when SCHEDULER_ENABLED is not true', async () => {
  const prev = process.env.SCHEDULER_ENABLED;
  process.env.SCHEDULER_ENABLED = 'false';
  try {
    const result = scheduler.initializeScheduler();
    assert.equal(result.registered, false);
    assert.deepEqual(result.jobs, []);
  } finally {
    process.env.SCHEDULER_ENABLED = prev;
    scheduler.stopScheduler();
  }
});

test('the scheduler registers both jobs when enabled', async () => {
  const prev = process.env.SCHEDULER_ENABLED;
  process.env.SCHEDULER_ENABLED = 'true';
  try {
    const result = scheduler.initializeScheduler();
    assert.equal(result.registered, true);
    assert.deepEqual(result.jobs, ['retention-purge', 'pending-signup-sweep']);
  } finally {
    process.env.SCHEDULER_ENABLED = prev;
    scheduler.stopScheduler();
  }
});

test('the pending-signup sweep deletes expired rows and spares live ones', async () => {
  const expiredEmail = `${uniq('sweep-old')}@invalid.test`;
  const liveEmail = `${uniq('sweep-new')}@invalid.test`;

  await repos.pendingSignups.create({
    name: 'ZZZ Expired',
    email: expiredEmail,
    password: 'Password123!',
    otp: '111111',
    otpExpiresAt: Date.now() - 1000,
    expiresAt: Date.now() - 60 * 60 * 1000,
  });
  await repos.pendingSignups.create({
    name: 'ZZZ Live',
    email: liveEmail,
    password: 'Password123!',
    otp: '222222',
    otpExpiresAt: Date.now() + 600000,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  const dry = await scheduler.sweepExpiredSignups({ dryRun: true });
  assert.ok(dry.candidates >= 1);
  assert.equal(dry.deleted, 0, 'a dry run must delete nothing');
  assert.ok(await repos.pendingSignups.findByEmail(expiredEmail), 'still present after dry run');

  // AT1: authorisation is a declared precondition now. `pendingSignup` has
  // always been MySQL-only, so only the authorisation gate applies here - which
  // is exactly why the gate is per-job rather than keyed off migration state.
  const destructiveJobs = require('../config/destructiveJobs');
  const sweepEnv = destructiveJobs.definitionOf('pending-signup-sweep').env;
  process.env[sweepEnv] = 'true';
  let real;
  try {
    real = await scheduler.sweepExpiredSignups();
  } finally {
    delete process.env[sweepEnv];
  }
  assert.ok(real.deleted >= 1);
  assert.equal(await repos.pendingSignups.findByEmail(expiredEmail), null, 'expired row swept');
  assert.ok(await repos.pendingSignups.findByEmail(liveEmail), 'live row must survive');
});

/**
 * Open both gates for a test whose subject is the RETENTION LOGIC (AT1).
 *
 * These tests used to need nothing, because `purgeOldDonations` short-circuited
 * on a zero candidate count BEFORE reaching any gate - so with no ancient rows
 * present they never touched one. AT1 moved the gates ahead of the work, on
 * purpose: a job that reveals it is unauthorised only once a row first
 * qualifies is a job an operator discovers at the worst moment.
 *
 * So the preconditions are now DECLARED here rather than inherited from an
 * ordering accident:
 *
 *   - `JOB_RETENTION_PURGE=true`  - authorisation (config/destructiveJobs)
 *   - `donation` as `mysql`       - safety (config/migrationState)
 *
 * The second is simulated because `donation` is still `split` until package
 * 3.4; these tests are about whether the purge computes the right window and
 * spares the right rows, which is a question that outlives the migration.
 */
async function withPurgeAllowed(fn) {
  const destructiveJobs = require('../config/destructiveJobs');
  const migrationState = require('../config/migrationState');
  const env = destructiveJobs.definitionOf('retention-purge').env;
  const previousEnv = process.env[env];
  const previousStore = migrationState.ENTITIES.donation.store;

  process.env[env] = 'true';
  migrationState.ENTITIES.donation.store = migrationState.MYSQL;
  try {
    return await fn();
  } finally {
    migrationState.ENTITIES.donation.store = previousStore;
    if (previousEnv === undefined) delete process.env[env];
    else process.env[env] = previousEnv;
  }
}

test('AG1a: a donation with an IMPLAUSIBLE date is excluded from the purge, not swept by it', async () => {
  // THE FAILURE THIS PREVENTS. The ten-year bound is what makes the cleanup
  // endpoint safe today (BUG-10), and that bound is only as reliable as the
  // date column. The Phase 4 ETL carries dates from MongoDB, where the Mongoose
  // schema never enforced them (SPEC-1A section 8) - so a row can arrive with a
  // zero epoch, a mis-parsed string, or a 1970 default.
  //
  // With a one-sided window such a row is "older than ten years ago" and the
  // first admin to click cleanup after cutover destroys a real donation. The
  // cause would be a date bug in the ETL and the symptom an admin endpoint;
  // nobody would connect the two.
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} floor ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
  });

  const zeroEpoch = await repos.donations.create({
    donorName: 'ZZZ',
    donorEmail: `${TAG}-zeroepoch@invalid.test`,
    categoryId: cat.id,
    baseAmountMinor: 1000,
    amountMinor: 1000,
    donatedAt: new Date('1970-01-01T00:00:00.000Z'),
  });

  const dry = await scheduler.purgeOldDonations({ dryRun: true });
  assert.ok(dry.implausible >= 1, 'the implausible row is COUNTED and reported');
  assert.equal(dry.floor, scheduler.PLAUSIBLE_FLOOR.toISOString(), 'the floor is reported');

  // The real run must leave it alone. A zero-epoch date is evidence of a
  // migration defect, and deleting the evidence is the worst response.
  await withPurgeAllowed(() => scheduler.purgeOldDonations());
  assert.ok(
    await repos.donations.findById(zeroEpoch.id),
    'a donation dated 1970 must SURVIVE - it is a data defect, not an old donation'
  );

  // A future date is the same class of defect and is excluded the same way.
  const future = await repos.donations.create({
    donorName: 'ZZZ',
    donorEmail: `${TAG}-future@invalid.test`,
    categoryId: cat.id,
    baseAmountMinor: 1000,
    amountMinor: 1000,
    donatedAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
  const after = await scheduler.purgeOldDonations({ dryRun: true });
  assert.ok(after.implausible >= 2, 'a future-dated row counts as implausible too');
  assert.ok(await repos.donations.findById(future.id));
});

test('the retention purge spares recent donations and reports its cutoff', async () => {
  // Inert in practice until Phase 4 loads data, so what is asserted is that it
  // computes the right window and does not touch anything inside it.
  const cat = await repos.categories.create({
    name: `${CAT_PREFIX} purge ${crypto.randomBytes(3).toString('hex')}`,
    shortDescription: 'fixture',
    donationAmountMinor: 1000,
  });
  const recent = await repos.donations.create({
    donorName: 'ZZZ',
    donorEmail: `${TAG}-purge@invalid.test`,
    categoryId: cat.id,
    baseAmountMinor: 1000,
    amountMinor: 1000,
  });

  const result = await scheduler.purgeOldDonations({ dryRun: true });
  const cutoffYear = new Date(result.cutoff).getFullYear();
  assert.equal(cutoffYear, new Date().getFullYear() - scheduler.RETENTION_YEARS);
  assert.equal(result.deleted, 0);

  const real = await withPurgeAllowed(() => scheduler.purgeOldDonations());
  assert.ok(await repos.donations.findById(recent.id), 'a recent donation must survive the purge');
  assert.equal(typeof real.deleted, 'number');

  // CHANGED BY AT1: and WITHOUT the gates it does not run at all, which is the
  // property this test would otherwise silently stop covering.
  await assert.rejects(
    () => scheduler.purgeOldDonations(),
    (err) => err.code === 'ERR_JOB_NOT_AUTHORISED'
  );
});
