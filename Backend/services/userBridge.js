/**
 * =============================================================================
 * User read-through bridge - TEMPORARY, DELETED IN PACKAGE 3.5
 * =============================================================================
 * Package 3.2 migrates `auth.js`, `users.js` and `middleware/` onto MySQL. The
 * three route files that still READ users do not move until 3.3, 3.4 and 3.5:
 *
 *   donations.js x2   populate("userId", "name email")
 *   payment.js   x1   populate('userId', 'name email')
 *   admin.js          the user list and counters
 *
 * Without a bridge, a user created after 3.2 exists only in MySQL and those
 * listings show their donations as having no donor.
 *
 * THE ALLOWLIST IS THE POINT (AE2). All three call sites asked populate for
 * `"name email"`. This returns exactly `_id`, `name` and `email` and nothing
 * else. A User row carries `password`, `resetPasswordCode`, `loginOTP` and
 * `resetPasswordAttempts`; a bridge that returned "the whole record" would be
 * an information leak wearing the clothes of a compatibility shim - introduced
 * by a package whose stated purpose is to change nothing.
 *
 * It is an ALLOWLIST, not a denylist. A denylist is wrong the first time a
 * column is added, and the column that gets added is never the harmless one.
 * =============================================================================
 */

'use strict';

const { createBridge } = require('./legacyBridge');

/** ONLY these fields cross the boundary. See the header before widening it. */
const ALLOWED = ['_id', 'name', 'email'];

function project(id, name, email) {
  return { _id: id, id, name: name || '', email: email || '' };
}

const bridge = createBridge({
  name: 'user',
  repository: () => require('../repositories/users'),
  model: () => require('../models/User'),
  // Phase 3 keeps the ObjectId as the external identifier so that
  // Donation.userId - a Mongoose ObjectId ref - stays valid (ADR-051).
  fromRepository: (row) => project(row.legacyId || row.id, row.name, row.email),
  fromMongo: (doc) => project(doc._id.toString(), doc.name, doc.email),
});

module.exports = {
  resolveUser: bridge.resolve,
  resolveMany: bridge.resolveMany,
  /** Replace `userId` on a donation (or a list of them) with the resolved user. */
  attachUsers: (docs) => bridge.attach(docs, 'userId'),
  ALLOWED_FIELDS: ALLOWED,
};
