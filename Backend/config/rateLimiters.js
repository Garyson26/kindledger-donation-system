/**
 * =============================================================================
 * Redis-backed rate limiter factory (SPEC-2 section 7.1)
 * =============================================================================
 * BUILT BUT NOT WIRED. The live limiters are defined in routes/auth.js:19-25,
 * which SPEC-2 section 1 fences off. Phase 3 swaps the import.
 *
 * SO SEC-04 IS NOT CLOSED BY THIS PHASE. The store existing and the store
 * being used are different claims, and only the second one closes the finding.
 * SEC-04 closes when Phase 3 wires these in.
 *
 * WHY REDIS AT ALL. express-rate-limit's default MemoryStore is per-process.
 * On Vercel each concurrent function instance had its own memory and instances
 * were recycled constantly, so the counter neither aggregated nor survived a
 * cold start - an attacker with concurrency got 5 requests per minute PER
 * INSTANCE, with a fresh budget whenever one spun up. A single long-lived
 * container already fixes most of that; Redis is what makes it hold when the
 * api service is scaled to more than one replica, which is the configuration
 * someone will reach for first under load.
 *
 * THE MEMORY FALLBACK IS DELIBERATE, NOT A SHORTCUT. A self-hosting NGO running
 * one container should not be forced to operate Redis. When REDIS_URL is unset
 * the limiters use the memory store and say so at boot, which is correct for a
 * single replica and wrong the moment there are two - hence the warning rather
 * than silence.
 * =============================================================================
 */

'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

let redisClient = null;
let storeKind = 'memory';
let announced = false;

/**
 * Build the shared store, or null to fall back to memory.
 *
 * Connection is started but NOT awaited: a limiter factory must not make module
 * loading depend on Redis being up. node-redis queues commands while
 * connecting, and if the connection never succeeds the limiter fails open on
 * that request rather than taking the process down - the same reasoning as
 * ADR-039. A limiter that cannot count is worse than no limiter only if you
 * believed it was counting, which is why the boot log states the store.
 */
function buildStore() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const { createClient } = require('redis');
  const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');

  redisClient = createClient({ url });

  // Without a handler, a connection error is an unhandled 'error' event, which
  // crashes the process - reintroducing the exit-on-infrastructure-failure
  // behaviour this phase exists to remove.
  redisClient.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[rateLimiters] redis error:', err && err.message ? err.message : err);
  });

  redisClient
    .connect()
    .then(() => {
      // UNREF, so this connection does not by itself keep the process alive.
      //
      // Without it, ANY process that imports app.js never exits - a test
      // runner, a migration script, a one-off maintenance task. Package 3.2
      // hit exactly that: wiring the limiter into routes/auth.js made the
      // auth suites hang AFTER passing, which reads as a broken test rather
      // than as a held socket.
      //
      // In production the HTTP server is what keeps the process alive; a rate
      // limiter has no business doing it. Same reasoning as making the store
      // lazy in the first place (ADR-042): infrastructure a module happens to
      // open should not change the lifetime of the process that imported it.
      if (typeof redisClient.unref === 'function') redisClient.unref();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[rateLimiters] redis connect failed, limiters degrade:', err && err.message);
    });

  storeKind = 'redis';
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    // THE PREFIX IS OVERRIDABLE, AND THAT IS NOT A TEST CONVENIENCE.
    //
    // Wiring the Redis store in package 3.2 made the limiter SHARED and
    // PERSISTENT, which is the entire point in production and a problem
    // everywhere else. The MemoryStore it replaced reset with the process, so a
    // suite could be re-run immediately; Redis remembers for the full window,
    // and the SEC-02 regression suite started failing with 429 on its FIRST
    // request when run twice inside a minute. The code was correct and the
    // symptom looked like a broken test.
    //
    // It matters beyond tests: two DEPLOYMENTS sharing one Redis - a blue/green
    // pair, or a staging environment pointed at the wrong instance - would
    // share rate-limit buckets and throttle each other, which is very hard to
    // diagnose from either side.
    prefix: process.env.RATE_LIMIT_PREFIX || 'kl:rl:',
  });
}

// LAZY, NOT AT MODULE LOAD. `const sharedStore = buildStore()` was the first
// version and it was wrong: requiring this file opened a TCP connection to
// Redis as a side effect, which meant any process that merely imported it
// never exited. That was found by the SPEC-2 section 8 run hanging - the test
// process stayed alive with no test running.
//
// It is not only a test problem. A module that dials out on import cannot be
// required by a migration script, a one-off maintenance task or a --check
// style smoke test without those inheriting a live socket and a shutdown
// obligation they never asked for. The store is now built on the first
// createLimiter() call, which is wiring time, which is when a connection is
// actually wanted.
let sharedStore;
let storeBuilt = false;

function getStore() {
  if (!storeBuilt) {
    storeBuilt = true;
    sharedStore = buildStore();
  }
  return sharedStore;
}

function announceOnce() {
  if (announced) return;
  announced = true;
  // eslint-disable-next-line no-console
  console.log(`[rateLimiters] store=${storeKind}${storeKind === 'memory' ? ' (single replica only)' : ''}`);
}

/**
 * The rate-limit bucket key for one limiter and one client address.
 *
 * Extracted and exported purely so the IPv6 collapse can be asserted directly.
 * A test that drove this through a live limiter would need two clients holding
 * addresses in the same /56, which is not arrangeable in CI.
 */
function keyFor(name, ip) {
  return `${name}:${ipKeyGenerator(ip)}`;
}

/**
 * Create a limiter.
 *
 * Every limiter shares one store instance. Separate windows are kept apart by
 * express-rate-limit's own key prefixing plus the `name` below, so an auth
 * burst does not consume a donor's donation-endpoint budget.
 *
 * NOTE ON KEYING. The key is the client address, which is only correct because
 * app.set('trust proxy', 1) is in place AND exactly one proxy that we control
 * overwrites X-Forwarded-For. Get that pair out of step and this counts
 * everyone into one bucket, or lets a client pick its own bucket per request.
 * SPEC-2 section 7.3 tests it end to end through Nginx.
 *
 * AND THE ADDRESS IS PASSED THROUGH ipKeyGenerator, NOT USED RAW. This is not
 * cosmetic. A residential IPv6 allocation is typically a /64 or shorter, so a
 * single client holds somewhere upwards of 18 quintillion addresses and can use
 * a fresh one per request. Keying on the raw address therefore gives every
 * IPv6 attacker an unlimited budget while correctly limiting every IPv4 user -
 * which is worse than no limiter, because the metrics look fine.
 * ipKeyGenerator collapses IPv6 to its /56 network (and leaves IPv4 alone), so
 * the bucket is the allocation rather than the address.
 *
 * express-rate-limit v8 detects a keyGenerator that touches req.ip without the
 * helper and warns with ERR_ERL_KEY_GEN_IPV6. That warning is how this was
 * caught here - it fired during the SPEC-2 section 8 test run, not in review.
 */
function createLimiter({ name, windowMs, max, message }) {
  const store = getStore();
  announceOnce();
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    ...(store ? { store } : {}),
    keyGenerator: (req) => keyFor(name, req.ip),
  });
}

/**
 * The auth limiter: same 5-per-minute budget as the one currently in
 * routes/auth.js, so wiring it in Phase 3 changes the store and nothing else.
 * Behaviour parity matters - a phase that silently tightened the limit would be
 * indistinguishable from a phase that broke it.
 */
const authLimiter = () =>
  createLimiter({
    name: 'auth',
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many requests. Please try again in a minute.',
  });

/**
 * For the unauthenticated donation-initiation path, which writes a database row
 * per call with no authentication and no limiter today (SEC-11). Not wired
 * either; routes/payment.js is fenced.
 */
const paymentInitiateLimiter = () =>
  createLimiter({
    name: 'payment-initiate',
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many donation attempts. Please try again shortly.',
  });

module.exports = {
  createLimiter,
  authLimiter,
  paymentInitiateLimiter,
  keyFor,
  /** 'redis' or 'memory'. Asserted by the tests. */
  storeKind: () => storeKind,
  /** For test teardown only. */
  disconnect: async () => {
    if (redisClient && redisClient.isOpen) await redisClient.quit();
    redisClient = null;
  },
};
