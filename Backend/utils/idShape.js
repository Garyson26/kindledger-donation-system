/**
 * =============================================================================
 * Identifier classification - the one piece of `services/legacyBridge.js` that
 * outlives it (package 3.6)
 * =============================================================================
 * The bridges are gone. This is not bridge logic and never was: it answers
 * "what SHAPE is this identifier", which the routes still need because ADR-051
 * keeps the ObjectId as the external id for migrated records through Phase 3.
 *
 * WHY IT IS NOT JUST AN INLINE REGEX. It exists because passing a uuid to
 * Mongoose's `findById` throws a CastError, which a route turns into a 500
 * where a 400 belongs - the SEC-14 shape. Mongoose is going, but the reason
 * generalises: `routes/donations.js` and `routes/payment.js` both dispatch on
 * the shape to decide which column to look in, and a malformed id must be a
 * clean 404 rather than a database error.
 *
 * Moved rather than deleted, and moved to `utils/` rather than left in
 * `services/`, because a helper living in a file named after a temporary
 * mechanism is how the mechanism outlives its purpose.
 * =============================================================================
 */

'use strict';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {'objectid'|'uuid'|'invalid'} */
function idShape(id) {
  if (typeof id !== 'string') return 'invalid';
  const v = id.trim();
  if (OBJECT_ID.test(v)) return 'objectid';
  if (UUID.test(v)) return 'uuid';
  return 'invalid';
}

module.exports = { idShape };
