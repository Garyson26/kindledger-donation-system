/**
 * =============================================================================
 * One shape for every refusal (BUG-11)
 * =============================================================================
 * Before this, a refused request named its reason under one of three keys
 * depending on which layer refused: route handlers used `error`, `adminAuth`
 * used `message`, `authMiddleware` used `msg`. Counted across the middleware
 * and two route files: 12 `error`, 9 `message`, 4 `msg`.
 *
 * THE HARM IS CONCRETE, NOT STYLISTIC. `Frontend/src/utils/api.js:73` reads
 *
 *     data.error || data.message || "Request failed"
 *
 * so every refusal from `authMiddleware` - "No token, authorization denied",
 * "Invalid token", "User not found" - reaches the user as **"Request failed"**.
 * Four carefully worded messages, none of which anyone has ever seen.
 *
 * AND IT WEAKENS THE TESTS (AG2). AC1 requires every refusal path to assert its
 * MECHANISM, including the reason. A test asserting a reason has to know which
 * key to read; with three possible keys the helper has to accept all of them,
 * which means it can no longer assert that a SPECIFIC key carries the reason.
 * Every reason-asserting test written against the old shape verifies less than
 * it appears to. That is why this is fixed FIRST in package 3.2, before the
 * characterisation suites for 3.3, 3.4 and 3.5 are written against it.
 *
 * THE SHAPE: `error` is canonical. `message` is emitted as well, because the
 * frontend already falls back to it and Phase 5 owns the frontend - changing
 * both at once would couple two packages for no benefit.
 *
 * `msg` IS DROPPED, deliberately. Nothing in the frontend reads it, which is
 * precisely why those refusals were invisible. Keeping it would preserve a
 * compatibility nobody has.
 *
 * PHASE 5 REMOVES `message` and leaves `error` alone, once the frontend reads
 * one key.
 * =============================================================================
 */

'use strict';

/**
 * Refuse a request with a status and a reason the client can actually read.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} reason  Safe for a client to see. NEVER pass err.message
 *   here - that is SEC-19. Log the detail, send a generic reason.
 * @param {object} [extra] Additional response fields, for the rare endpoint
 *   that must return structured detail alongside the reason.
 */
function refuse(res, status, reason, extra) {
  return res.status(status).json({
    error: reason,
    // Transitional alias. See the header: Phase 5 removes it.
    message: reason,
    ...(extra || {}),
  });
}

/**
 * Refuse because something went wrong on our side (SEC-19).
 *
 * The detail goes to the server log and NEVER to the client. Mongoose and
 * Prisma errors carry field names, values and occasionally connection details.
 */
function failed(res, reason, err, { status = 500, tag = 'api' } = {}) {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(`[${tag}] ${reason}:`, err && err.stack ? err.stack : err);
  }
  return refuse(res, status, reason);
}

module.exports = { refuse, failed };
