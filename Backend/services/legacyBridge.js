/**
 * =============================================================================
 * The read-through bridge, one mechanism for every entity - TEMPORARY
 * =============================================================================
 * ADR-050 generalised per AF2. `categoryBridge.js` was the first instance;
 * this is the same mechanism with the entity-specific parts as parameters, so
 * there is ONE CastError guard, ONE fallback counter and ONE file to delete in
 * package 3.5.
 *
 * WHAT IS A PARAMETER (AF2): the field allowlist, the id shapes, which
 * repository answers, how a row is projected. All three entities differ in
 * exactly those and in nothing else.
 *
 * WHAT WOULD BE A SECOND MECHANISM, and must stop rather than acquire a flag:
 * consulting both stores and MERGING results; a WRITE path through the bridge;
 * ordering or consistency guarantees ACROSS the stores. None is present. This
 * is a read, first-match-wins, against a store that is going away - which is
 * the only reason a bridge is acceptable at all.
 *
 * DELETION IS AN EMPIRICAL CHECK, NOT A PROMISE (AE3). `fallbackCount()`
 * reports how often MongoDB answered. Both parts are required before deleting:
 * zero across the FULL test suite, asserted rather than eyeballed; AND zero
 * across a manual exercise of every migrated route against a database holding
 * BOTH migrated and post-migration records. A database of only new records
 * cannot take the fallback path, so it proves nothing.
 *
 * AE2 - THE RETURN RULE. A bridge returns THE FIELDS THE CALLER ASKED FOR, not
 * the whole record. `Category` is a recorded exception (nothing sensitive, and
 * the 3.1 behaviour already depends on the superset). `User` is emphatically
 * not: it holds `password`, `resetPasswordCode` and `loginOTP`, and the three
 * call sites all want `name` and `email`. The allowlist below is an ALLOWLIST
 * and not a denylist, because a denylist is wrong the first time a column is
 * added.
 * =============================================================================
 */

'use strict';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify an identifier. THE HELPER DECIDES WHICH STORE BY SHAPE AND NEVER
 * LETS A CastError ESCAPE: passing a uuid to Mongoose's findById throws, which
 * a route turns into a 500 where a 400 belongs - the SEC-14 shape, and on the
 * payment path it would let one junk field 500 the donation endpoint.
 */
function idShape(id) {
  if (typeof id !== 'string') return 'invalid';
  const v = id.trim();
  if (OBJECT_ID.test(v)) return 'objectid';
  if (UUID.test(v)) return 'uuid';
  return 'invalid';
}

let fallbacks = 0;

/**
 * Build a bridge for one entity.
 *
 * @param {object} cfg
 * @param {string} cfg.name              For log messages.
 * @param {() => object} cfg.repository  Lazily required, so deleting the
 *   repository later is a clean failure rather than a load-time crash.
 * @param {() => object} cfg.model       Lazily required, for the same reason -
 *   package 3.6 deletes the Mongoose models.
 * @param {(row) => object} cfg.fromRepository  Project a MySQL row.
 * @param {(doc) => object} cfg.fromMongo       Project a Mongo document.
 */
function createBridge(cfg) {
  async function resolve(id) {
    const shape = idShape(id);
    if (shape === 'invalid') return null;
    const value = String(id).trim();

    const repo = cfg.repository();
    const row =
      shape === 'objectid' ? await repo.findByLegacyId(value) : await repo.findById(value);
    if (row) return { ...cfg.fromRepository(row), _source: 'mysql' };

    // A uuid can only have come from MySQL. There is nothing to fall back to,
    // and asking Mongo would raise the CastError this helper exists to stop.
    if (shape === 'uuid') return null;

    let doc = null;
    try {
      doc = await cfg.model().findById(value);
    } catch (err) {
      // Should be unreachable - the shape was validated. Kept because the whole
      // point is that a bad id can never become a 500.
      // eslint-disable-next-line no-console
      console.warn(`[legacyBridge:${cfg.name}] lookup failed for ${value}:`, err && err.message);
      return null;
    }
    if (!doc) return null;

    fallbacks += 1;
    // NEVER SILENT (AD1a). Silent fallback is how a bridge becomes permanent:
    // nothing ever says it is still carrying traffic, so nobody can argue for
    // deleting it.
    // eslint-disable-next-line no-console
    console.warn(
      `[legacyBridge:${cfg.name}] MongoDB FALLBACK for ${value}. This bridge is ` +
        `temporary (ADR-050) and is still carrying traffic. Fallbacks so far: ${fallbacks}.`
    );
    return { ...cfg.fromMongo(doc), _source: 'mongo' };
  }

  /** De-duplicated batch resolution. Replaces what populate() used to do. */
  async function resolveMany(ids) {
    const unique = [...new Set((ids || []).filter(Boolean).map((v) => String(v)))];
    const out = new Map();
    await Promise.all(
      unique.map(async (id) => {
        const v = await resolve(id);
        if (v) out.set(id, v);
      })
    );
    return out;
  }

  /**
   * Replace a reference field on a set of documents with the resolved record.
   *
   * populate() cannot do this any more: a record created after its entity
   * migrated has no MongoDB row, so populate resolves it to null and the
   * reference appears to be missing entirely.
   *
   * Mongoose documents are converted with toObject() first - assigning a plain
   * object onto a typed ObjectId path on a live document would be cast-checked
   * and rejected.
   */
  async function attach(docs, field) {
    const list = Array.isArray(docs) ? docs : [docs];
    const plain = list.map((d) => (d && typeof d.toObject === 'function' ? d.toObject() : d));
    const map = await resolveMany(plain.map((d) => (d && d[field] ? String(d[field]) : null)));
    for (const d of plain) {
      if (!d) continue;
      d[field] = d[field] ? map.get(String(d[field])) || null : null;
    }
    return Array.isArray(docs) ? plain : plain[0];
  }

  return { resolve, resolveMany, attach };
}

module.exports = {
  createBridge,
  idShape,
  /**
   * Record a fallback taken OUTSIDE createBridge - currently only
   * userBridge.resolveAuthUser, which does its own lookup so it can log the
   * event distinctly (AJ1b). Without this the shared total would under-report
   * exactly the fallbacks that matter most.
   */
  noteFallback: () => {
    fallbacks += 1;
    return fallbacks;
  },
  /** Read by the tests and by the package 3.5 exit check (AE3). */
  fallbackCount: () => fallbacks,
  resetFallbackCount: () => {
    fallbacks = 0;
  },
};
