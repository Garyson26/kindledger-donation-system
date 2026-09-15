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

// =============================================================================
// The AUTHORISATION projection - INTERNAL ONLY (AJ1)
// =============================================================================
// A SECOND ALLOWLIST ON THE SAME ENTITY. Under AF2 that is a parameter, not a
// second mechanism: no merging, no write path, no cross-store ordering.
//
// WHAT MAKES IT SAFE IS THAT IT IS NARROWER, NOT WIDER. The risk AE2 guards
// against is a bridge returning MORE than the caller asked for. This returns
// LESS - no email, no name beyond what the middleware needs for `req.user`, and
// nothing that could be serialised into a response - to a consumer that never
// serialises anything.
//
// NEVER PUT THIS IN A RESPONSE BODY. It carries `isActive` and `tokenVersion`,
// which describe the account's security state. Neither is secret, and neither
// is any client's business: `tokenVersion` in particular tells an attacker
// holding a stale token exactly why it stopped working, and whether an admin
// has noticed them. Asserted by `test/user-bridge.test.js`, not merely written
// here - the AI4 pattern.
const AUTH_ALLOWED = ['id', 'uuid', 'name', 'role', 'isActive', 'tokenVersion'];

function projectAuth(id, row, source, uuid) {
  return {
    // The EXTERNAL identifier - an ObjectId (ADR-051). Used for comparisons
    // against client-supplied ids and in responses.
    id,
    // The MySQL uuid, for repository lookups. NULL for a user still in
    // MongoDB, which is what makes a half-migrated account visibly
    // half-migrated rather than silently broken: a handler that needs the
    // repository gets null and answers 404, instead of looking up an ObjectId
    // as if it were a uuid and finding nothing for a reason nobody can see.
    uuid,
    name: row.name || '',
    role: row.role || 'user',
    // Mongo's User schema has isActive; it has NO tokenVersion, so a user still
    // in Mongo is version 0. Tokens issued before this package carry no version
    // claim and are read as 0 too, which is what lets them keep working until
    // they expire rather than logging everyone out at deploy.
    isActive: row.isActive !== false,
    tokenVersion: typeof row.tokenVersion === 'number' ? row.tokenVersion : 0,
    _source: source,
  };
}

/**
 * Resolve a user for an AUTHORISATION decision.
 *
 * @returns {Promise<null | {id, name, role, isActive, tokenVersion, _source}>}
 */
async function resolveAuthUser(id) {
  const { idShape } = require('./legacyBridge');
  const shape = idShape(id);
  if (shape === 'invalid') return null;
  const value = String(id).trim();

  const users = require('../repositories/users');
  const row = shape === 'objectid' ? await users.findByLegacyId(value) : await users.findById(value);
  if (row) return projectAuth(row.legacyId || row.id, row, 'mysql', row.id);

  if (shape === 'uuid') return null;

  let doc = null;
  try {
    doc = await require('../models/User').findById(value).select('name role isActive');
  } catch {
    return null;
  }
  if (!doc) return null;

  // AJ1b: NO SILENT FALLBACK FOR AUTH.
  //
  // Deliberately NOT just an increment on the shared counter. If MySQL missed
  // and MongoDB answered, an AUTHORISATION DECISION has been made from the
  // store we are migrating away from, for a user who is mid-migration. During
  // package 3.2 that is the single most interesting event in the system, and it
  // has to be findable in a log search rather than inferable from a total.
  //
  // The tag is deliberately ugly and unique so it greps cleanly.
  const total = require('./legacyBridge').noteFallback();
  // eslint-disable-next-line no-console
  console.warn(
    `[AUTH-DECISION-FROM-MONGO] userId=${value} role=${doc.role || 'user'} ` +
      `isActive=${doc.isActive !== false} tokenVersion=0(absent-in-mongo) ` +
      '- this account has NOT been migrated to MySQL and an authorisation ' +
      'decision was just made from MongoDB. Expected during package 3.2; ' +
      `investigate if seen afterwards (AJ1b). Fallbacks so far: ${total}.`
  );
  return projectAuth(doc._id.toString(), doc, 'mongo', null);
}

module.exports = {
  resolveUser: bridge.resolve,
  resolveMany: bridge.resolveMany,
  /** Replace `userId` on a donation (or a list of them) with the resolved user. */
  attachUsers: (docs) => bridge.attach(docs, 'userId'),
  resolveAuthUser,
  ALLOWED_FIELDS: ALLOWED,
  AUTH_ALLOWED_FIELDS: AUTH_ALLOWED,
  /** ADR-050's exit condition, read from the one declaration (AS2). */
  readyToDelete: () => require('./legacyBridge').readyToDelete('user'),
};
