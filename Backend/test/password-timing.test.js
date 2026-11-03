/**
 * =============================================================================
 * BG2 - the dummy-bcrypt mitigation's DEPENDENCY, asserted rather than noted
 * =============================================================================
 *   npm run test:password-timing
 *
 * BG1 closed three measured timing oracles by making the branch with no row to
 * check spend the same bcrypt as the branch that has one. That converts an
 * information leak into a CPU cost: a request that used to be refused in 4 ms
 * now costs ~240 ms, and an unauthenticated caller can force it.
 *
 * -----------------------------------------------------------------------------
 * THE DEPENDENCY, STATED AS A DEPENDENCY
 * -----------------------------------------------------------------------------
 * > **The dummy-bcrypt mitigation is safe only while `authLimiter` is wired and
 * > effective on `/signup`, `/login` and `/signup/verify-otp`.**
 *
 * Without it, each of those endpoints is a 60x CPU amplifier for anyone who can
 * send a request. With it, an IP can force at most 5 bcrypts per minute.
 *
 * **THAT IS A CONTROL WHICH HAS ALREADY FAILED ONCE HERE.** SEC-04 was exactly
 * this: `config/rateLimiters.js` was built with a Redis store, nothing imported
 * it, and the finding was reported closed while the limiter was not wired. A
 * mitigation resting on that control cannot rest on a comment.
 *
 * So this suite fails if any equalised endpoint loses its limiter. Unwiring one
 * would otherwise convert a closed oracle into an amplifier, silently, and the
 * timing tests would still pass - they measure the separation, not the cost.
 *
 * -----------------------------------------------------------------------------
 * BEHAVIOURAL, NOT STRUCTURAL
 * -----------------------------------------------------------------------------
 * It does not inspect the middleware stack for a limiter-shaped function. It
 * sends requests from ONE address until it is refused, because "a limiter is in
 * the chain" and "the endpoint is limited" are different claims - and the
 * second is the one the mitigation depends on. A limiter present but keyed on
 * something an attacker varies would satisfy the first and not the second.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');

process.env.NODE_ENV = 'production';
// Set here like every other suite that boots the app. Without it config/jwt.js
// throws on load; it only ever passed inside the api container, whose
// environment supplies one (found on the first CI run, CM1).
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_pwtiming_test';

const users = require('../repositories/users');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');
const { BCRYPT_COST, burnEquivalentBcrypt } = require('../config/passwordTiming');

const TAG = 'zzz-bg2-pwtiming';
const PASSWORD = 'MeasurePassword1!';

/** `authLimiter` is 5 per minute; 8 from one address must reach a refusal. */
const BURST = 8;

let server;
let base;
let ipSeq = 0;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(4).toString('hex')}@invalid.test`;
/** A DISTINCT address per test, so one test's burst cannot exhaust another's. */
const freshIp = () => `198.18.${(ipSeq++ % 200) + 1}.7`;

async function post(path, body, ip) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

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
    // Same reason as signup-timing.test.js: these endpoints start SMTP
    // connections that cannot complete here and nodemailer holds the sockets.
    // Correct for a harness that drives such a path deliberately; NOT a pattern
    // for the application suites, where a process that will not exit is
    // evidence of a leak rather than a nuisance (BD4).
    setTimeout(() => process.exit(0), 250);
  }
});

// =============================================================================
// The equaliser itself
// =============================================================================

test('BG2: burnEquivalentBcrypt actually costs a bcrypt', async () => {
  // THE MITIGATION IS A COST. If somebody stubs this out - or a refactor removes
  // work whose result is unused - every closed oracle reopens and nothing else
  // in the suite would notice, because the timing tests compare two branches
  // that would both have become fast.
  const started = process.hrtime.bigint();
  const result = await burnEquivalentBcrypt('anything at all');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result, false, 'it returns a constant, never a comparison result');
  assert.ok(
    elapsedMs > 50,
    `it took ${elapsedMs.toFixed(1)} ms, which is not a bcrypt at cost ${BCRYPT_COST}. ` +
      'The COST is the product here; the discarded comparison is load-bearing.'
  );
});

test('BG2: the cost factor has ONE definition, shared by the real and dummy hashes', () => {
  // A second copy of the cost would let the dummy drift away from the real
  // work, which turns a full equalisation into a partial one - reopening the
  // oracle by an amount nobody chose.
  assert.equal(
    users.BCRYPT_COST,
    BCRYPT_COST,
    'repositories/users must take BCRYPT_COST from config/passwordTiming, not redeclare it'
  );
});

// =============================================================================
// THE DEPENDENCY. One test per equalised endpoint.
// =============================================================================

async function assertLimited(path, bodyFor) {
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < BURST; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push(await post(path, bodyFor(i), ip));
  }
  assert.ok(
    statuses.includes(429),
    `${path} IS NOT RATE LIMITED. ${BURST} requests from one address returned ` +
      `${statuses.join(', ')} with no 429.\n\n` +
      'THIS IS NOT A LIMITER BUG - IT IS A BG1 REGRESSION. That endpoint now ' +
      'spends a full bcrypt (~240 ms) on requests it used to refuse in 4 ms, and ' +
      'authLimiter is the only thing bounding what an unauthenticated caller can ' +
      'force. Unlimited, it is a 60x CPU amplifier. Either restore the limiter or ' +
      'remove the equalisation and reopen the oracle deliberately, with a record.'
  );
}

test('BG2: /signup is rate limited - the bound on its equalised cost', async () => {
  await assertLimited('/api/auth/signup', (i) => ({
    name: 'ZZZ BG2',
    email: uniqEmail(`s${i}`),
    password: PASSWORD,
  }));
});

test('BG2: /login is rate limited - the bound on its equalised cost', async () => {
  await assertLimited('/api/auth/login', (i) => ({
    email: uniqEmail(`l${i}`),
    password: PASSWORD,
  }));
});

test('BG2: /signup/verify-otp is rate limited - the bound on its equalised cost', async () => {
  await assertLimited('/api/auth/signup/verify-otp', (i) => ({
    email: uniqEmail(`v${i}`),
    otp: '000000',
    password: PASSWORD,
  }));
});

test('BG2: the limiter keys on the ADDRESS, so a burst does not refuse everyone', async () => {
  // A limiter that fired globally would also satisfy the tests above while
  // being a denial of service in its own right - the AV1 shape, where the
  // control that stops an attacker locks out real users.
  //
  // So: exhaust one address, then show a DIFFERENT address is still served.
  await assertLimited('/api/auth/login', (i) => ({
    email: uniqEmail(`k${i}`),
    password: PASSWORD,
  }));

  const other = await post('/api/auth/login', { email: uniqEmail('other'), password: PASSWORD }, freshIp());
  assert.notEqual(
    other,
    429,
    'a second client must still be served after the first exhausted its allowance'
  );
});
