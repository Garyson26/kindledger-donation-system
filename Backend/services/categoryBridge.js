/**
 * =============================================================================
 * Category read-through bridge - TEMPORARY, DELETED IN PACKAGE 3.5
 * =============================================================================
 * ADR-050. `categories.js` migrated to MySQL in package 3.1, but three route
 * files still READ categories and do not move until 3.3, 3.4 and 3.5:
 *
 *   payment.js:116     prices every donation from the category
 *   donations.js  x4   the listings, the receipt and the charts
 *   admin.js:19        the dashboard count
 *
 * Without a bridge, a category created after 3.1 exists only in MySQL, those
 * readers look in MongoDB, and no donation can be made against it.
 *
 * NOW BUILT ON services/legacyBridge.js (AF2). This was the first instance of
 * the mechanism; package 3.2 needed a second for `User`, so the shared parts
 * moved out rather than being copied. The public interface here is deliberately
 * unchanged, which is why `test/category-bridge.test.js` passes untouched - a
 * refactor of a component on the pricing path has to be provable, not merely
 * plausible.
 *
 * THE FALLBACK IS NEVER SILENT (AD1a), and the counter now lives in
 * legacyBridge and is SHARED across all entities. That is what makes the
 * package 3.5 exit check (AE3) one number rather than three.
 *
 * THIS BRIDGE RETURNS THE WHOLE RECORD. That is a KNOWN EXCEPTION to the rule
 * in ADR-052 (AE2), which requires a bridge to return only the fields the
 * caller asked for. It is allowed here for two reasons and neither generalises:
 * a Category carries nothing sensitive, and the corrected donations.js
 * behaviour already depends on the superset. THE USER BRIDGE DOES NOT COPY IT -
 * see services/userBridge.js, where the allowlist is the whole point.
 * =============================================================================
 */

'use strict';

const legacy = require('./legacyBridge');

const bridge = legacy.createBridge({
  name: 'category',
  repository: () => require('../repositories/categories'),
  model: () => require('../models/Category'),
  // Phase 3 keeps the ObjectId as the external identifier so that
  // Donation.category - a required ObjectId ref - stays valid (ADR-051).
  fromRepository: (row) => ({
    _id: row.legacyId || row.id,
    id: row.legacyId || row.id,
    name: row.name,
    sortDescription: row.shortDescription,
    donationAmount: row.donationAmountMinor / 100,
    descriptions: row.descriptions || [],
  }),
  fromMongo: (doc) => ({
    _id: doc._id.toString(),
    id: doc._id.toString(),
    name: doc.name,
    sortDescription: doc.sortDescription,
    donationAmount: doc.donationAmount,
    descriptions: doc.descriptions || [],
  }),
});

/** Total ACTIVE categories, for admin.js's dashboard tile (ADR-004). */
async function countCategories() {
  return (await require('../repositories/categories').list()).length;
}

module.exports = {
  resolveCategory: bridge.resolve,
  resolveMany: bridge.resolveMany,
  attachCategories: (docs) => bridge.attach(docs, 'category'),
  countCategories,
  idShape: legacy.idShape,
  /** Read by the tests and by the package 3.5 exit check (AE3). */
  fallbackCount: legacy.fallbackCount,
  resetFallbackCount: legacy.resetFallbackCount,
  /** ADR-050's exit condition, read from the one declaration (AS2). */
  readyToDelete: () => legacy.readyToDelete('category'),
};
