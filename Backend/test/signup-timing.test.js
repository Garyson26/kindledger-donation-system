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
  const text = await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // BH1: every channel a caller can observe, captured together. Body and status
  // were closed by 3.5a; TIMING was open at 60x while SEC-08 was marked closed,
  // and RESPONSE SIZE had never been looked at by anyone.
  return { status: res.status, elapsedMs, body: text, bytes: Buffer.byteLength(text) };
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
  // FLIPPED BY BG1. This asserted a DEFECT; it now asserts the CLOSURE.
  // =========================================================================
  // BEFORE: 242.4 ms separation, 51.9x, distributions not overlapping - one
  //         request classified the address.
  // AFTER:  the existing-address branch spends the same bcrypt (cost 12)
  //         against a throwaway hash, so both paths pay for the hash.
  //
  // The test is kept and inverted rather than deleted, because the property to
  // defend now is "these stay equal" - and the thing most likely to break it is
  // somebody removing work whose result is discarded.
  assert.ok(
    separation < 60,
    `REGRESSION: the /signup branches are separable again by ${separation.toFixed(1)} ms. ` +
      'config/passwordTiming.burnEquivalentBcrypt exists to stop this. Check that ' +
      'the existing-address branch still awaits it, and that BCRYPT_COST has not ' +
      'drifted between the real hash and the dummy one.'
  );

  // THE RESIDUAL, ASSERTED RATHER THAN NOTED (BA3).
  //
  // The unknown-address branch also WRITES the pending row; the known branch
  // does not. That is a few milliseconds and it is not equalised, deliberately:
  // equalising it means performing a dummy database write on behalf of an
  // address that does not exist, which hands an unauthenticated caller unbounded
  // writes - a worse problem than the one it closes.
  //
  // So a small separation REMAINS here, and this asserts it stays small rather
  // than pretending it is zero.
  assert.ok(
    separation < 60,
    'the residual is the pending-row WRITE, not the hash - see the comment above'
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

  // FLIPPED BY BG1. Was 236.0 ms and 60.0x with no overlap; the route now passes
  // a null id to `users.verifyPassword`, which spends the same bcrypt when there
  // is no row. This is the canonical enumeration endpoint, so the threshold is
  // the tightest of the three.
  assert.ok(
    Math.abs(separation) < 40,
    `REGRESSION: /login is separable by ${separation.toFixed(1)} ms again, so an ` +
      'unauthenticated caller can enumerate registered addresses one request at a ' +
      'time. The fix is `users.verifyPassword(user ? user.id : null, password)` - ' +
      'check nobody reintroduced an `if (!user) return` ahead of it.'
  );

  // NO TOTAL SEPARATION. The strongest form the oracle can take is that the
  // distributions do not overlap; asserting they DO overlap is the direct
  // negation of what was measured before the fix.
  assert.ok(
    Math.min(...knownTimes) <= Math.max(...unknownTimes),
    'the distributions must OVERLAP now - if they separate cleanly again, one ' +
      'request decides and the oracle is back whatever the medians say'
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

  // FLIPPED BY BG1 - AND THIS ONE TOOK TWO ATTEMPTS.
  //
  // The first fix equalised `pendingSignups.verifyPassword`, which was the line
  // the comment pointed at. The separation did not move, because the ROUTE
  // returns at `if (!pending)` before that function is ever called. Inspection
  // said fixed; the measurement said 234.1 ms.
  //
  // That is the argument for measurement as the acceptance criterion, made by
  // the work rather than asserted about it.
  assert.ok(
    Math.abs(mWith - mWithout) < 40,
    `REGRESSION: whether a signup is IN FLIGHT is observable again ` +
      `(${(mWith - mWithout).toFixed(1)} ms). Both the early return at ` +
      '`if (!pending)` and the repository must spend the bcrypt.'
  );
});

// =============================================================================
// BG3 - THE sha256-SCALE ENDPOINTS: measured, then decided
// =============================================================================
// Three endpoints have the same SHAPE at a different SCALE: one branch does a
// sha256 hash and a single UPDATE, the sibling does nothing.
//
//   /signup/resend-otp        pendingSignups.setOtp   (sha256 + UPDATE)
//   /login/resend-otp         users.setLoginOtp       (sha256 + UPDATE)
//   /forgot-password/request  users.setResetCode      (sha256 + UPDATE)
//
// MY ENUMERATION HAD /signup/resend-otp IN THE WRONG CLASS. I recorded it as
// "structurally identical to /signup/verify-otp, bcrypt-sized", from a grep hit
// on `pendingSignups.verifyPassword` that is actually inside `/login`. It does
// not call verifyPassword at all. Measuring is what corrected it - the same
// reason BG1 said to measure rather than assume.
//
// "Real but small" with no number is exactly the state BB3 was commissioned to
// end, so each of these gets a number and a verdict.
//
// MORE SAMPLES THAN THE BCRYPT CASES. A 240 ms separation is visible in twelve
// samples. A separation of a few milliseconds is the same size as the noise, so
// deciding it needs enough samples for the medians to be stable.
// =============================================================================

const SHA_SAMPLES = 40;

/**
 * The question is NOT "do the medians differ" - they will, by some amount, in
 * any two sets of measurements. It is whether the difference is usable as an
 * oracle: can a caller decide which branch ran, from timings they can obtain?
 *
 * The strongest usable form is TOTAL separation, as all three bcrypt cases
 * have. Short of that, the honest comparison is the gap between the medians
 * against the SPREAD of each sample - if the distributions interleave, a single
 * request decides nothing and an attacker needs many, per address, through a
 * rate limiter.
 */
function decide(label, hot, cold) {
  const mHot = median(hot);
  const mCold = median(cold);
  const separation = mHot - mCold;
  const overlap = Math.min(...hot) <= Math.max(...cold);
  const spread = Math.max(...cold) - Math.min(...cold);

  // eslint-disable-next-line no-console
  console.log(
    `\n  BG3 ${label} (${SHA_SAMPLES} samples each, medians):\n` +
      `    branch that WORKS (sha256 + UPDATE): ${mHot.toFixed(2)} ms\n` +
      `    branch that does NOTHING           : ${mCold.toFixed(2)} ms\n` +
      `    SEPARATION                         : ${separation.toFixed(2)} ms\n` +
      `    distributions overlap              : ${overlap ? 'YES' : 'NO'}\n` +
      `    spread of the idle branch          : ${spread.toFixed(2)} ms\n` +
      `    VERDICT: ${
        !overlap
          ? 'TOTALLY SEPARATED - one request decides. A FINDING.'
          : separation > spread
            ? 'overlapping but separation exceeds the idle spread - usable with samples.'
            : 'BELOW THE NOISE FLOOR here - separation is smaller than the idle branch spread.'
      }\n`
  );
  return { mHot, mCold, separation, overlap, spread };
}

test('BG3: /signup/resend-otp - sha256 scale, measured and decided', async () => {
  const pendingEmail = uniqEmail('rs-pending');
  await post('/api/auth/signup', { name: 'ZZZ Resend', email: pendingEmail, password: PASSWORD });

  await post('/api/auth/signup/resend-otp', { email: pendingEmail });
  await post('/api/auth/signup/resend-otp', { email: uniqEmail('rs-warm') });

  const hot = [];
  const cold = [];
  for (let i = 0; i < SHA_SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const a = await post('/api/auth/signup/resend-otp', { email: pendingEmail });
    // eslint-disable-next-line no-await-in-loop
    const b = await post('/api/auth/signup/resend-otp', { email: uniqEmail(`rs-u${i}`) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, 'identical status either way - SEC-08');
    hot.push(a.elapsedMs);
    cold.push(b.elapsedMs);
  }

  const r = decide('/signup/resend-otp', hot, cold);

  // NOT bcrypt scale. Asserted, because my enumeration put it in the wrong
  // class and the assertion is what stops that being restated later.
  assert.ok(
    r.separation < 50,
    `this endpoint is sha256 scale, not bcrypt scale - if the separation is now ` +
      `${r.separation.toFixed(1)} ms something has started hashing a password here`
  );
});

test('BG3: /login/resend-otp - sha256 scale, measured and decided', async () => {
  const known = uniqEmail('lr-known');
  await users.create({ name: 'ZZZ LR', email: known, password: PASSWORD, isVerified: true });

  await post('/api/auth/login/resend-otp', { email: known });
  await post('/api/auth/login/resend-otp', { email: uniqEmail('lr-warm') });

  const hot = [];
  const cold = [];
  for (let i = 0; i < SHA_SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const a = await post('/api/auth/login/resend-otp', { email: known });
    // eslint-disable-next-line no-await-in-loop
    const b = await post('/api/auth/login/resend-otp', { email: uniqEmail(`lr-u${i}`) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    hot.push(a.elapsedMs);
    cold.push(b.elapsedMs);
  }

  const r = decide('/login/resend-otp', hot, cold);
  assert.ok(r.separation < 50, 'sha256 scale, not bcrypt scale');
});

test('BG3: /forgot-password/request - sha256 scale, measured and decided', async () => {
  const known = uniqEmail('fp-known');
  await users.create({ name: 'ZZZ FP', email: known, password: PASSWORD, isVerified: true });

  await post('/api/auth/forgot-password/request', { email: known });
  await post('/api/auth/forgot-password/request', { email: uniqEmail('fp-warm') });

  const hot = [];
  const cold = [];
  for (let i = 0; i < SHA_SAMPLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const a = await post('/api/auth/forgot-password/request', { email: known });
    // eslint-disable-next-line no-await-in-loop
    const b = await post('/api/auth/forgot-password/request', { email: uniqEmail(`fp-u${i}`) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    hot.push(a.elapsedMs);
    cold.push(b.elapsedMs);
  }

  const r = decide('/forgot-password/request', hot, cold);
  assert.ok(r.separation < 50, 'sha256 scale, not bcrypt scale');
});

// =============================================================================
// BH1 - THE RETROACTIVE CHANNELS CHECK
// =============================================================================
// BG4 added a clause to the citation rule: a claim that something "adds no
// oracle" must name which CHANNELS were checked, because body, status, timing
// and response size are separate channels and a claim covering one is not a
// claim covering the others.
//
// SEC-08 was marked CLOSED on the body and the status. /login was measurable at
// 60x at the time. So the retroactive question is: what else was never looked
// at? RESPONSE SIZE is the channel nobody in this project has checked once.
//
// It is cheap and it is not theoretical: a body that differs by a single
// character - a name echoed back, a pluralisation, a trailing field present on
// one branch - is visible through TLS, where the content is not.
// =============================================================================

/** Every SEC-08 endpoint, with a known-address case and an unknown-address one. */
async function channelPair(label, path, knownBody, unknownBody) {
  const known = await post(path, knownBody);
  const unknown = await post(path, unknownBody);

  // eslint-disable-next-line no-console
  console.log(
    `\n  BH1 ${label}\n` +
      `    known   : status ${known.status}  ${String(known.bytes).padStart(4)} bytes\n` +
      `    unknown : status ${unknown.status}  ${String(unknown.bytes).padStart(4)} bytes`
  );

  return { known, unknown };
}

test('BH1: RESPONSE SIZE - the channel nobody had checked', async () => {
  const known = uniqEmail('bh1-known');
  await users.create({ name: 'ZZZ BH1', email: known, password: PASSWORD, isVerified: true });

  const pending = uniqEmail('bh1-pending');
  await post('/api/auth/signup', { name: 'ZZZ BH1 Pending', email: pending, password: PASSWORD });

  const WRONG = 'WrongPassword9!';
  const cases = [
    await channelPair(
      'POST /signup',
      '/api/auth/signup',
      { name: 'ZZZ BH1', email: known, password: PASSWORD },
      { name: 'ZZZ BH1', email: uniqEmail('bh1-u1'), password: PASSWORD }
    ),
    await channelPair(
      'POST /login',
      '/api/auth/login',
      { email: known, password: WRONG },
      { email: uniqEmail('bh1-u2'), password: WRONG }
    ),
    await channelPair(
      'POST /signup/verify-otp',
      '/api/auth/signup/verify-otp',
      { email: pending, otp: '000000', password: WRONG },
      { email: uniqEmail('bh1-u3'), otp: '000000', password: WRONG }
    ),
    await channelPair(
      'POST /signup/resend-otp',
      '/api/auth/signup/resend-otp',
      { email: pending },
      { email: uniqEmail('bh1-u4') }
    ),
    await channelPair(
      'POST /login/resend-otp',
      '/api/auth/login/resend-otp',
      { email: known },
      { email: uniqEmail('bh1-u5') }
    ),
    await channelPair(
      'POST /forgot-password/request',
      '/api/auth/forgot-password/request',
      { email: known },
      { email: uniqEmail('bh1-u6') }
    ),
  ];

  for (const { known: k, unknown: u } of cases) {
    // STATUS - closed by 3.5a, re-asserted here because a channels audit that
    // only checks the new channel is the same partial claim one step along.
    assert.equal(k.status, u.status, 'STATUS channel: the two branches must agree');

    // RESPONSE SIZE. The bodies are generic strings, so any difference is a
    // difference in CONTENT, and content that varies with account existence is
    // an oracle whatever the status says.
    //
    // /signup echoes the submitted address, so its two bodies differ by the
    // length of an address the CALLER CHOSE - which tells the caller nothing
    // they did not already know. That is why this compares the body with the
    // echoed address removed rather than raw bytes.
    const strip = (b) => b.replace(/"email":"[^"]*"/, '"email":"<echoed>"');
    assert.equal(
      strip(k.body),
      strip(u.body),
      'RESPONSE SIZE / BODY channel: the two branches returned different content'
    );
  }
});

test('BH1: ERROR-PATH ORDERING does not leak through a malformed request', async () => {
  // The fifth channel. If a missing field is rejected BEFORE the account lookup
  // on one branch and after it on another, the order of checks is itself an
  // oracle - the caller learns which check ran by which error came back.
  const known = uniqEmail('bh1-order-known');
  await users.create({ name: 'ZZZ BH1', email: known, password: PASSWORD, isVerified: true });

  // No password at all, against a KNOWN and an UNKNOWN address.
  const k = await post('/api/auth/login', { email: known });
  const u = await post('/api/auth/login', { email: uniqEmail('bh1-order-u') });

  assert.equal(k.status, u.status, 'a malformed request is refused identically either way');
  assert.equal(k.body, u.body, 'and with the same body - the validation runs before the lookup');

  // eslint-disable-next-line no-console
  console.log(
    `\n  BH1 ERROR-PATH ORDERING: missing password -> ${k.status} ` +
      `identical for known and unknown addresses\n`
  );
});
