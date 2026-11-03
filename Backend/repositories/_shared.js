/**
 * =============================================================================
 * Repository shared helpers (SPEC-2 sections 4.2, 4.3)
 * =============================================================================
 * Identifier policy, money conversion and BigInt normalisation. One
 * implementation each, so the rules cannot drift between entities.
 * =============================================================================
 */

'use strict';

const { getPrisma } = require('../config/prisma');

/**
 * Resolve the client to use.
 *
 * Every repository function takes an optional client as its LAST argument. Pass
 * the `tx` from withTransaction() to enrol a call in that transaction; omit it
 * and the call runs on the singleton, on its own connection.
 *
 * The omission is silent by design of Prisma's API, not ours: a call without
 * `tx` inside a transaction block succeeds and simply is not part of the
 * transaction. That is the trap to watch for in Phase 3.
 */
function client(maybeClient) {
  return maybeClient || getPrisma();
}

// -----------------------------------------------------------------------------
// Identifiers (SPEC-1A section 4.1)
// -----------------------------------------------------------------------------
// Three columns exist per entity: the internal BIGINT `id` for joins, the
// external CHAR(36) `uuid`, and `legacy_id` holding the original MongoDB
// ObjectId for migrated rows.
//
// REPOSITORIES EXPOSE `uuid` AS `id` AND NEVER EXPOSE THE INTERNAL BIGINT.
// SPEC-1A section 4.1 is explicit that the internal key is never in an API
// response or a URL, and it is what closes the SEC-06 enumeration surface.
//
// Exposing it as `id` rather than `uuid` is deliberate: the test suites' store
// seam already returns `{ id: <string> }`, so callers written against the seam
// need no change, and Phase 3's swap stays a five-function job.
const newUuid = () => require('node:crypto').randomUUID();

// -----------------------------------------------------------------------------
// Money (SPEC-1A section 4.2, SPEC-2 section 4.3)
// -----------------------------------------------------------------------------
// Repositories accept and return INTEGER MINOR UNITS. No repository converts to
// or from a decimal representation; formatting is a Phase 3 and Phase 5
// concern.

/**
 * Convert a currency value to integer minor units (paise).
 *
 * The single implementation SPEC-2 section 4.3 asks for. PayU sends a decimal
 * STRING, which is parsed digit-wise and never passed through a float - the
 * reason for the whole minor-units decision (ADR-010). A JavaScript number
 * input is rounded, which is only correct because the legacy Mongoose column
 * holds at most two decimal places; that path disappears once the ETL has run.
 *
 *   "1500.00" -> 150000     "1500"  -> 150000
 *   "1500.5"  -> 150050     1500.07 -> 150007
 *   "1500.005"-> null       "1e3"   -> null
 *
 * @returns {number|null} null for anything malformed. Callers MUST treat null
 *   as a mismatch and never as zero.
 */
function toMinorUnits(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const minor = Math.round(value * 100);
    return Number.isSafeInteger(minor) ? minor : null;
  }
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const fraction = m[2] ? Number.parseInt(m[2].padEnd(2, '0'), 10) : 0;
  const minor = major * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Normalise a Prisma BIGINT to a JavaScript number.
 *
 * Prisma surfaces BIGINT as BigInt, which JSON.stringify throws on - so
 * returning one to a route handler would produce a 500 the first time it was
 * serialised. Converting here means it happens once, in the data layer, rather
 * than being discovered per endpoint.
 *
 * Paise up to 2^53 is about 90 trillion rupees, so the range is not a practical
 * constraint - but it is checked rather than assumed, because silently losing
 * precision on a money column is the failure this whole design exists to
 * prevent.
 */
function fromBigInt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `Value ${String(value)} exceeds Number.MAX_SAFE_INTEGER and cannot be ` +
        'normalised without losing precision. This should be impossible for a ' +
        'money or identifier column; investigate rather than widening the check.'
    );
  }
  return n;
}

/** ISO string or null. Never a Date, so callers cannot mutate shared state. */
function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

module.exports = {
  client,
  newUuid,
  toMinorUnits,
  fromBigInt,
  iso,
};
