/**
 * =============================================================================
 * BG1 - equalising the bcrypt cost between branches that find a row and
 *       branches that do not
 * =============================================================================
 * SEC-08 made several endpoints answer IDENTICALLY whether or not an account
 * exists. SEC-18 made bcrypt cost 12, deliberately expensive.
 *
 * **BOTH ARE CORRECT AND TOGETHER THEY LEAK.** The branch that finds a row
 * spends ~240 ms comparing a password; the branch that finds nothing returns in
 * ~4 ms. The bodies are identical, the clock is not, and BE1 measured three
 * endpoints where the distributions DO NOT OVERLAP - one request decides:
 *
 *   POST /signup             237.7 ms   51.9x
 *   POST /login              236.0 ms   60.0x
 *   POST /signup/verify-otp  240.7 ms
 *
 * This module is the equaliser. A branch with no row to check performs a bcrypt
 * operation against a throwaway hash and discards the result, so both paths pay
 * the same cost.
 *
 * -----------------------------------------------------------------------------
 * THE HASH IS GENERATED, NOT HARDCODED, AND THAT IS THE POINT
 * -----------------------------------------------------------------------------
 * A literal `$2a$12$...` in the source would be a SECOND place that encodes the
 * cost factor, and it would not follow `BCRYPT_COST` when SEC-18 next revisits
 * it. The equalisation would then quietly become partial - the dummy cheaper or
 * dearer than the real work - and nothing would say so.
 *
 * Generating it at load from the SAME constant makes the equality structural.
 * It costs one bcrypt (~240 ms) once, at boot, which is the correct place to
 * spend it.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS BUYS AND WHAT IT COSTS - the trade is not free (BG2)
 * -----------------------------------------------------------------------------
 * It converts an information leak into a CPU cost. Every request that would
 * have been refused cheaply now costs a full bcrypt, so an unauthenticated
 * caller can force ~240 ms of CPU per request instead of ~4 ms.
 *
 * **THE ONLY THING BOUNDING THAT IS `authLimiter`** - 5 requests per minute per
 * IP - and a limiter is a control that has already failed once in this project
 * (SEC-04: built, not wired, and reported closed while it was not).
 *
 * So the dependency is asserted, not noted: `test/password-timing.test.js`
 * fails if any endpoint using this equaliser loses its limiter. Unwiring one
 * would otherwise convert a closed oracle into a 60x CPU amplifier silently.
 * =============================================================================
 */

'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

/**
 * THE ONE definition of the cost factor (SEC-18). The repositories import it
 * from here so that the real hashes and the dummy one cannot drift apart - that
 * drift is precisely what would make this equaliser stop equalising.
 */
const BCRYPT_COST = 12;

/**
 * A hash of a value nobody knows and nothing stores. It exists to be compared
 * against and never to match: the plaintext is discarded at the end of this
 * line and is not recoverable from the hash.
 *
 * Synchronous on purpose. It must exist before the first request is served, and
 * a lazily-built one would make the FIRST request through each branch slower
 * than the rest - manufacturing exactly the kind of timing artefact this file
 * exists to remove.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

/**
 * Spend one bcrypt and throw the answer away.
 *
 * ALWAYS RETURNS FALSE. The return value is a constant, not a comparison
 * result, so no caller can come to depend on what it compared - and a reader
 * can see that the work is unconditional rather than incidental.
 *
 * DO NOT "OPTIMISE" THIS. The result is discarded on purpose; the COST is the
 * product. A compiler, a linter or a well-meaning refactor that removes work
 * whose result is unused would silently reopen three measured oracles. The
 * `await` and the discarded comparison are load-bearing.
 */
async function burnEquivalentBcrypt(candidate) {
  await bcrypt.compare(String(candidate == null ? '' : candidate), DUMMY_HASH);
  return false;
}

module.exports = { BCRYPT_COST, burnEquivalentBcrypt };
