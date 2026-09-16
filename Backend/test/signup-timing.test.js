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
