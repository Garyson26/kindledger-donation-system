/**
 * =============================================================================
 * BB3 - MEASURING the 3.5a timing difference, instead of noting it
 * =============================================================================
 *   npm run test:signup-timing
 *
 * Package 3.5a closed SEC-08's last oracle: /signup now answers identically for
 * a known and an unknown address. The map recorded what that did NOT close:
 *
 *   "A TIMING difference. The new-account path hashes a password and writes a
 *    row; the existing-account path does neither."
 *
 * BA3's audit put that in the UNPINNED column - recorded, never measured, so
 * nobody knew whether it was a signal or noise. BB3: measure it. A measurable
 * difference is a finding; an unmeasurable one closes the row. Either beats an
 * unmeasured note.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT
 * -----------------------------------------------------------------------------
 * It measures the SERVER-SIDE separation between the two branches, in-process,
 * on an idle machine. That is the best case for an attacker and the worst case
 * for the system, which is the right direction for a security measurement: a
 * separation that does not exist here cannot exist over a network either.
 *
 * It does NOT model a remote attacker. Network jitter, connection reuse and
 * scheduler noise all cost an attacker samples - they do not remove the signal,
 * they raise the number of requests needed to see it. Reporting a local number
 * and calling it the attack cost would be the AU3 pattern: measuring the control
 * where nothing is at stake.
 *
 * MEDIANS, NOT MEANS. One 400ms GC pause moves a mean and not a median, and the
 * quantity an attacker uses is the typical response, not the average one.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');

process.env.NODE_ENV = 'production';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_timing_test';

const users = require('../repositories/users');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');

const TAG = 'zzz-bb3-timing';
const PASSWORD = 'MeasurePassword1!';
/**
 * Twelve, not fifty. Every request in BOTH branches starts an SMTP connection
 * that fails with EAUTH in this environment, and fifty concurrent failing
 * connections dominate the run. The cost is symmetric across the branches, so
 * it does not bias the comparison - it just makes a longer run slower without
 * making it better.
 */
const SAMPLES = 12;

let server;
let base;
let clientSeq = 0;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(4).toString('hex')}@invalid.test`;
const nextIp = () => `203.0.113.${(clientSeq++ % 250) + 1}`;

async function post(path, body) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify(body),
  });
  await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, elapsedMs };
}

async function signup(email) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ name: 'ZZZ Timing', email, password: PASSWORD }),
  });
  await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, elapsedMs };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function reset() {
  await users.deleteByEmailPrefix(TAG);
  await getPrisma().pendingSignup.deleteMany({ where: { email: { startsWith: TAG } } });
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'this suite needs MySQL');
  const app = require('../app.js');
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await reset();
});

after(async () => {
  try {
    await reset();
  } finally {
    if (server) server.close();
    await prismaModule.disconnect();
    // FORCED EXIT, and the reason is itself a small finding: both /signup
    // branches start an SMTP connection that cannot complete in this
    // environment, and nodemailer holds those sockets open. The measurement
    // finishes in seconds; the PROCESS then sits for as long as the SMTP
    // timeouts take. Without this the suite looks hung when it is done.
    setTimeout(() => process.exit(0), 250);
  }
});

// =============================================================================

test('BB3: the two /signup branches are TIMED, and the number is recorded', async () => {
  // An account that already exists - the branch that neither hashes nor writes.
  const knownEmail = uniqEmail('known');
  await users.create({
    name: 'ZZZ Timing Known',
    email: knownEmail,
    password: PASSWORD,
    isVerified: true,
  });

  // WARM-UP, discarded. The first request through a path pays for lazy requires,
  // JIT and a cold connection pool, and attributing that to the branch would
  // manufacture a difference that is not there.
  await signup(uniqEmail('warm'));
  await signup(knownEmail);

  // INTERLEAVED, not one block then the other. Measuring all of one branch and
  // then all of the other lets any drift over the run - cache warming, another
  // container waking up - land entirely on one of them and look like signal.
  const unknown = [];
  const known = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const u = await signup(uniqEmail(`u${i}`));
    // eslint-disable-next-line no-await-in-loop
    const k = await signup(knownEmail);
    assert.equal(u.status, 200);
    assert.equal(k.status, 200);
    unknown.push(u.elapsedMs);
    known.push(k.elapsedMs);
  }

  const mUnknown = median(unknown);
  const mKnown = median(known);
  const separation = mUnknown - mKnown;

  // eslint-disable-next-line no-console
  console.log(
    `\n  BB3 MEASUREMENT (${SAMPLES} samples each, interleaved, medians):\n` +
      `    UNKNOWN address (hashes + writes): ${mUnknown.toFixed(1)} ms\n` +
      `    KNOWN address   (neither)        : ${mKnown.toFixed(1)} ms\n` +
      `    SEPARATION                       : ${separation.toFixed(1)} ms\n` +
      `    ratio                            : ${(mUnknown / mKnown).toFixed(2)}x\n`
  );

  // The bodies are identical - 3.5a closed that. Only the time differs.
  assert.ok(mUnknown > 0 && mKnown > 0, 'both branches were actually exercised');

  // =========================================================================
  // THE PIN. This asserts a KNOWN DEFECT, on the BB2 model.
  // =========================================================================
  // bcrypt at cost 12 is deliberately expensive - SEC-18 - and the whole point
  // of the cost factor is that it cannot be made cheap. So the separation is
  // not an accident of implementation that a tidy-up removes; it is the direct
  // consequence of a control the system wants.
  //
  // The threshold is far below the measured value so the test is not a
  // benchmark. It answers one question: is the difference LARGER THAN NOISE?
  assert.ok(
    separation > 20,
    `PINNED DEFECT: the branches are separable by timing (${separation.toFixed(1)} ms). ` +
      'If this now FAILS, the separation has closed - constant-time signup, or a ' +
      'deferred hash - so close the residual audit row and delete this test ' +
      'rather than lowering the threshold.'
  );

  // And it is not one unlucky sample: the SLOWEST known-address response is
  // still faster than the FASTEST unknown one. That is total separation, which
  // means a single request classifies the address.
  assert.ok(
    Math.max(...known) < Math.min(...unknown),
    'TOTAL separation: the distributions do not overlap at all, so ONE request ' +
      'is enough to tell a registered address from an unregistered one. This is ' +
      'the strongest form the finding can take, and it is the one that holds.'
  );
});

// =============================================================================
// BE1 - THE SAME SHAPE ELSEWHERE. Enumerated, not checked nearby (AY2).
// =============================================================================
// /signup is where the oracle was noticed. It is not the worst instance.
//
// Wherever one branch performs real cryptographic work and its sibling returns
// early, the same oracle exists. These tests MEASURE the two other bcrypt-sized
// ones rather than reasoning about them, because the whole reason /signup's was
// underestimated is that somebody reasoned about it and wrote "a far weaker
// signal than a distinct message".
// =============================================================================

test('BE1: /login separates a KNOWN address from an UNKNOWN one by timing', async () => {
  // THE CANONICAL ENUMERATION ENDPOINT, and its structure is:
  //
  //   pending signup exists -> bcrypt.compare
  //   registered user exists -> bcrypt.compare
  //   NEITHER                -> refuse(400) immediately, NO bcrypt at all
  //
  // The body is identical in all three - SEC-08 saw to that. The clock is not.
  const known = uniqEmail('login-known');
  await users.create({ name: 'ZZZ Login', email: known, password: PASSWORD, isVerified: true });

  const WRONG = 'WrongPassword9!';
  await post('/api/auth/login', { email: known, password: WRONG });
  await post('/api/auth/login', { email: uniqEmail('login-warm'), password: WRONG });

  const unknownTimes = [];
  const knownTimes = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const k = await post('/api/auth/login', { email: known, password: WRONG });
    // eslint-disable-next-line no-await-in-loop
    const u = await post('/api/auth/login', { email: uniqEmail(`login-u${i}`), password: WRONG });
    assert.equal(k.status, 400, 'a wrong password is refused');
    assert.equal(u.status, 400, 'and so is an unknown address - IDENTICALLY');
    knownTimes.push(k.elapsedMs);
    unknownTimes.push(u.elapsedMs);
  }

  const mKnown = median(knownTimes);
  const mUnknown = median(unknownTimes);
  const separation = mKnown - mUnknown;

  // eslint-disable-next-line no-console
  console.log(
    `\n  BE1 /login MEASUREMENT (${SAMPLES} samples each, interleaved, medians):\n` +
      `    KNOWN address, wrong password (bcrypt.compare): ${mKnown.toFixed(1)} ms\n` +
      `    UNKNOWN address (refused before any bcrypt)   : ${mUnknown.toFixed(1)} ms\n` +
      `    SEPARATION                                    : ${separation.toFixed(1)} ms\n` +
      `    ratio                                         : ${(mKnown / mUnknown).toFixed(2)}x\n`
  );

  assert.ok(
    separation > 20,
    `PINNED DEFECT: /login is separable by timing (${separation.toFixed(1)} ms), so an ` +
      'unauthenticated caller can enumerate registered addresses one request at a ' +
      'time. If this FAILS the oracle has been closed - update the map and delete ' +
      'this test rather than lowering the threshold.'
  );
  assert.ok(
    Math.max(...unknownTimes) < Math.min(...knownTimes),
    'TOTAL separation on /login: the distributions do not overlap, so ONE request ' +
      'decides. This is the canonical enumeration endpoint and the oracle is the ' +
      'same size as /signup - which was measured first only because it was noticed first.'
  );
});

test('BE1: /signup/verify-otp leaks whether a signup is IN FLIGHT, contradicting its comment', async () => {
  // The comment above this endpoint says, of the password requirement AX1 added:
  //
  //   "ANSWERS 'Invalid OTP' like every other failure here, so it adds no
  //    oracle: a caller cannot learn whether the address has a signup in
  //    flight, nor whether their password guess was right."
  //
  // TRUE OF THE BODY. FALSE OF THE CLOCK. `pendingSignups.verifyPassword`
  // returns false WITHOUT reaching bcrypt when there is no pending row, so an
  // address with a signup in flight costs a bcrypt.compare and one without
  // costs nothing.
  //
  // Another confident sentence written next to code that the clock contradicts.
  const inFlight = uniqEmail('otp-inflight');
  await post('/api/auth/signup', { name: 'ZZZ InFlight', email: inFlight, password: PASSWORD });

  const body = (email) => ({ email, otp: '000000', password: 'WrongPassword9!' });
  await post('/api/auth/signup/verify-otp', body(inFlight));
  await post('/api/auth/signup/verify-otp', body(uniqEmail('otp-warm')));

  const withRow = [];
  const withoutRow = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const a = await post('/api/auth/signup/verify-otp', body(inFlight));
    // eslint-disable-next-line no-await-in-loop
    const b = await post('/api/auth/signup/verify-otp', body(uniqEmail(`otp-u${i}`)));
    assert.equal(a.status, 400);
    assert.equal(b.status, 400, 'identical bodies, identical status');
    withRow.push(a.elapsedMs);
    withoutRow.push(b.elapsedMs);
  }

  const mWith = median(withRow);
  const mWithout = median(withoutRow);

  // eslint-disable-next-line no-console
  console.log(
    `\n  BE1 /signup/verify-otp MEASUREMENT (${SAMPLES} samples each, medians):\n` +
      `    signup IN FLIGHT (bcrypt.compare): ${mWith.toFixed(1)} ms\n` +
      `    no pending row (no bcrypt)       : ${mWithout.toFixed(1)} ms\n` +
      `    SEPARATION                       : ${(mWith - mWithout).toFixed(1)} ms\n`
  );

  assert.ok(
    mWith - mWithout > 20,
    `PINNED DEFECT: the endpoint's own comment claims it adds no oracle. It adds ` +
      `a ${(mWith - mWithout).toFixed(1)} ms one. Fix the code or fix the comment; ` +
      'do not lower this threshold.'
  );
});
