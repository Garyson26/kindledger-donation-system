/**
 * =============================================================================
 * Category read-through bridge - TEMPORARY, DELETED IN PACKAGE 3.6
 * =============================================================================
 * ADR-050 / ADR-051. This exists for exactly one reason: `categories.js` is
 * migrated to MySQL in package 3.1, but three route files still READ categories
 * and do not move until 3.2, 3.3 and 3.5:
 *
 *   payment.js:116     prices every donation from the category
 *   donations.js  x4   populate("category") on every listing and the receipt
 *   admin.js:19        the dashboard count
 *
 * Without a bridge, a category created after 3.1 exists only in MySQL, those
 * readers look in MongoDB, and no donation can be made against it.
 *
 * DELETING THIS FILE IS A PHASE 3 EXIT CRITERION (SPEC-3 section 7), and the
 * check is EMPIRICAL rather than a promise: `fallbackCount()` reports how many
 * times the MongoDB path has been taken. Once donations.js, admin.js and
 * payment.js are migrated, a count of zero over a real run is evidence that
 * nothing depends on the fallback any more. A temporary abstraction that
 * reports whether it is still load-bearing is one that can actually be removed.
 *
 * THE FALLBACK IS NEVER SILENT (AD1a). Every hit logs a warning naming the id.
 * Silent fallback is precisely how a bridge becomes permanent: nothing ever
 * says it is still carrying traffic, so nobody can argue for deleting it.
 * =============================================================================
 */

'use strict';

const categories = require('../repositories/categories');

// -----------------------------------------------------------------------------
// Identifier shapes (AD1b)
// -----------------------------------------------------------------------------
// THE HELPER DECIDES WHICH STORE BY ID SHAPE, AND NEVER LETS A CastError
// ESCAPE. Passing a uuid to Mongoose's findById raises CastError, which the
// route turns into a 500 where a 400 is correct - the same shape as SEC-14,
// where a malformed input crashed the check instead of failing it. An id that
// matches neither shape is simply not found; it is never a 500.
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idShape(id) {
  if (typeof id !== 'string') return 'invalid';
  const v = id.trim();
  if (OBJECT_ID.test(v)) return 'objectid';
  if (UUID.test(v)) return 'uuid';
  return 'invalid';
}

let fallbacks = 0;

/**
 * The shape every caller gets, whichever store answered.
 *
 * Deliberately NOT the Mongoose document and NOT the repository row. Callers
 * during Phase 3 read `_id`, `name` and `donationAmount`, so those are the
 * names used - the point of the bridge is that the readers do not change
 * beyond the call itself.
 */
function normalise({ externalId, name, sortDescription, donationAmount, descriptions, source }) {
  return {
    _id: externalId,
    id: externalId,
    name,
    sortDescription,
    donationAmount,
    descriptions: descriptions || [],
    /** 'mysql' or 'mongo'. Read by the tests and by the 3.6 exit check. */
    _source: source,
  };
}

function fromRepository(row) {
  if (!row) return null;
  return normalise({
    // Phase 3 keeps the ObjectId as the external identifier so that
    // Donation.category (an ObjectId ref) stays valid - see ADR-051.
    externalId: row.legacyId || row.id,
    name: row.name,
    sortDescription: row.shortDescription,
    donationAmount: row.donationAmountMinor / 100,
    descriptions: row.descriptions,
    source: 'mysql',
  });
}

function fromMongo(doc) {
  if (!doc) return null;
  return normalise({
    externalId: doc._id.toString(),
    name: doc.name,
    sortDescription: doc.sortDescription,
    donationAmount: doc.donationAmount,
    descriptions: doc.descriptions,
    source: 'mongo',
  });
}

/**
 * Resolve one category by its external id.
 *
 * MySQL first, MongoDB second. Returns null for "no such category" in every
 * case, including a malformed id - the caller's job is to turn that into a 400,
 * not to handle two kinds of absence.
 */
async function resolveCategory(id) {
  const shape = idShape(id);
  if (shape === 'invalid') return null;

  const value = String(id).trim();

  // MySQL is the source of truth from package 3.1 onwards.
  const row =
    shape === 'objectid'
      ? await categories.findByLegacyId(value)
      : await categories.findById(value);
  if (row) return fromRepository(row);

  // A uuid can only ever have come from MySQL. There is nothing to fall back
  // to, and asking Mongo would raise the CastError this helper exists to stop.
  if (shape === 'uuid') return null;

  const doc = await mongoCategory(value);
  if (!doc) return null;

  fallbacks += 1;
  // eslint-disable-next-line no-console
  console.warn(
    `[categoryBridge] MongoDB FALLBACK for category ${value}. This bridge is ` +
      'temporary (ADR-050) and is still carrying traffic; it cannot be deleted ' +
      `until this stops. Fallbacks so far: ${fallbacks}.`
  );
  return fromMongo(doc);
}

/**
 * The Mongoose lookup, isolated so the CastError guard has one home.
 *
 * `require` is deferred rather than top-level: package 3.6 deletes the models,
 * and a top-level require would make this file fail to load at that point
 * instead of simply never taking this branch.
 */
async function mongoCategory(value) {
  try {
    const Category = require('../models/Category');
    return await Category.findById(value);
  } catch (err) {
    // Should be unreachable - the shape was validated above. Kept because the
    // whole point of this helper is that a bad id can never become a 500.
    // eslint-disable-next-line no-console
    console.warn('[categoryBridge] MongoDB lookup failed for', value, err && err.message);
    return null;
  }
}

/**
 * Resolve many at once, for the listing endpoints that used populate().
 *
 * De-duplicates, so a page of 50 donations across 6 categories issues 6
 * lookups rather than 50. Returns a Map keyed by the id STRING.
 */
async function resolveMany(ids) {
  const unique = [...new Set((ids || []).filter(Boolean).map((v) => String(v)))];
  const out = new Map();
  await Promise.all(
    unique.map(async (id) => {
      const c = await resolveCategory(id);
      if (c) out.set(id, c);
    })
  );
  return out;
}

/**
 * Replace what `.populate("category")` used to do, for a list of donations.
 *
 * populate() cannot work any more: a category created after package 3.1 has no
 * MongoDB row, so populate resolves it to NULL and the donation appears to have
 * no category at all. That is the same dangling-reference shape the old hard
 * delete produced, except it would now affect every NEW category.
 *
 * Mongoose documents are converted with toObject() first. Assigning a resolved
 * object onto a typed ObjectId path on a live document would be cast-checked
 * and rejected; a plain object has no such path typing.
 */
async function attachCategories(docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const plain = list.map((d) => (d && typeof d.toObject === 'function' ? d.toObject() : d));

  const map = await resolveMany(
    plain.map((d) => (d && d.category ? String(d.category) : null))
  );

  for (const d of plain) {
    if (!d) continue;
    // null when the category genuinely does not resolve - the pre-existing
    // orphan case from the old hard delete. Same value populate() gave, so
    // callers that already handled it are unaffected.
    d.category = d.category ? map.get(String(d.category)) || null : null;
  }

  return Array.isArray(docs) ? plain : plain[0];
}

/** Total categories, for admin.js's dashboard tile. Active only, per ADR-004. */
async function countCategories() {
  return (await categories.list()).length;
}

module.exports = {
  resolveCategory,
  resolveMany,
  attachCategories,
  countCategories,
  idShape,
  /** Read by the tests and by the package 3.6 exit check (SPEC-3 section 7). */
  fallbackCount: () => fallbacks,
  resetFallbackCount: () => {
    fallbacks = 0;
  },
};
