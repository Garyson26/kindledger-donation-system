/**
 * =============================================================================
 * User repository (SPEC-2 section 4)
 * =============================================================================
 * Shaped to the auth suite's store seam: createUserWithResetCode, readUser.
 *
 * NOTE ON WHAT IS DELIBERATELY ABSENT. Nothing here reads or returns
 * password_hash, reset_code_hash or login_otp_hash. routes/admin.js currently
 * does `user.toObject()` then `delete obj.password`, which fetches the hash
 * across the wire and then discards it. Omitting the column is strictly better,
 * and it is why `verifyPassword` and `verifyResetCode` take the candidate and
 * do the comparison here rather than handing the hash back.
 * =============================================================================
 */

'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { client, newUuid, iso } = require('./_shared');
// For createFromPendingSignup: the account and the pending row must move together.
const { withTransaction } = require('../config/prisma');

// SEC-18 asks for cost 12 rather than the 10 used throughout the legacy code.
const BCRYPT_COST = 12;

const SELECT = {
  uuid: true,
  legacyId: true,
  name: true,
  email: true,
  role: true,
  phone: true,
  address: true,
  isActive: true,
  isVerified: true,
  tokenVersion: true,
  loginOtpExpiresAt: true,
  loginOtpAttempts: true,
  resetCodeExpiresAt: true,
  resetCodeAttempts: true,
  createdAt: true,
  updatedAt: true,
};

function normalise(row) {
  if (!row) return null;
  return {
    id: row.uuid,
    legacyId: row.legacyId,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone ?? null,
    address: row.address ?? null,
    isActive: row.isActive,
    isVerified: row.isVerified,
    tokenVersion: row.tokenVersion,
    loginOtpExpiresAt: iso(row.loginOtpExpiresAt),
    loginOtpAttempts: row.loginOtpAttempts,
    resetCodeExpiresAt: iso(row.resetCodeExpiresAt),
    resetCodeAttempts: row.resetCodeAttempts,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** SEC-13: codes are stored hashed, never in plaintext. */
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

async function create(input, tx) {
  const row = await client(tx).user.create({
    data: {
      uuid: input.uuid || newUuid(),
      // ADR-051: MINTED when not supplied. A user created here with a null
      // legacy_id would be addressed by uuid, and Donation.userId is a required
      // Mongoose ObjectId ref until donations migrate - so that donation could
      // not be attributed. The ETL supplies the real ObjectId and this branch
      // is not taken for migrated rows.
      legacyId: input.legacyId ?? mintObjectId(),
      name: input.name,
      // Lowercased on write. The unique index is case-insensitive
      // (utf8mb4_0900_as_ci) so this is defence in depth, not the only control.
      email: String(input.email).trim().toLowerCase(),
      passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
      role: input.role || 'user',
      phone: input.phone ?? null,
      address: input.address ?? null,
      isActive: input.isActive !== undefined ? input.isActive : true,
      isVerified: input.isVerified !== undefined ? input.isVerified : false,
    },
    select: SELECT,
  });
  return normalise(row);
}

async function findById(id, tx) {
  return normalise(await client(tx).user.findUnique({ where: { uuid: id }, select: SELECT }));
}

async function findByEmail(email, tx) {
  const normalised = String(email == null ? '' : email).trim().toLowerCase();
  if (!normalised) return null;
  return normalise(await client(tx).user.findUnique({ where: { email: normalised }, select: SELECT }));
}

/**
 * Compares in the data layer so the hash never leaves it.
 *
 * SEC-08, AND THE WAY IT GETS REINTRODUCED. This returns `false` for a wrong
 * password, and `findByEmail` returns `null` for an address nobody holds. Those
 * are two different facts, and REPORTING THEM SEPARATELY TO THE CLIENT REOPENS
 * USER ENUMERATION across the whole login surface.
 *
 * It is worth stating here rather than only in a test, because the person about
 * to make this mistake is reading this file. "No account with that address" and
 * "Incorrect password" read like better error handling; they are the finding.
 * `/login` currently answers `400 "Invalid credentials"` to both, byte for byte,
 * and must continue to.
 */
async function verifyPassword(id, candidate, tx) {
  const row = await client(tx).user.findUnique({
    where: { uuid: id },
    select: { passwordHash: true },
  });
  if (!row) return false;
  return bcrypt.compare(String(candidate), row.passwordHash);
}

async function setPassword(id, plaintext, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: {
      passwordHash: await bcrypt.hash(plaintext, BCRYPT_COST),
      resetCodeHash: null,
      resetCodeExpiresAt: null,
      resetCodeAttempts: 0,
      // SEC-05: a password change invalidates every issued token. Phase 3 reads
      // tokenVersion in the middleware; incrementing it here means the data
      // layer cannot be bypassed by forgetting to do it at the call site.
      tokenVersion: { increment: 1 },
    },
  });
  return findById(id, tx);
}

async function setResetCode(id, code, expiresAt, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: {
      resetCodeHash: hashCode(code),
      resetCodeExpiresAt: new Date(expiresAt),
      resetCodeAttempts: 0,
    },
  });
  return findById(id, tx);
}

/**
 * SEC-02. Returns a verdict, never the hash.
 *
 * Deliberately does NOT reset the attempt counter on a correct code. ADR-034:
 * clearing it on a correct guess at /verify would hand a lucky guesser a fresh
 * budget of five at /reset, and alternating between the endpoints would keep it
 * topped up. The counter is cleared only by setPassword.
 */
async function verifyResetCode(id, candidate, tx) {
  const db = client(tx);
  const row = await db.user.findUnique({
    where: { uuid: id },
    select: { resetCodeHash: true, resetCodeExpiresAt: true, resetCodeAttempts: true },
  });
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.resetCodeAttempts >= 5) return { ok: false, reason: 'attempts-exhausted' };
  if (!row.resetCodeHash) return { ok: false, reason: 'no-code' };
  if (!row.resetCodeExpiresAt || new Date() > row.resetCodeExpiresAt) {
    return { ok: false, reason: 'expired' };
  }

  const expected = Buffer.from(row.resetCodeHash, 'hex');
  const actual = Buffer.from(hashCode(candidate), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}

async function incrementResetAttempts(id, tx) {
  const row = await client(tx).user.update({
    where: { uuid: id },
    data: { resetCodeAttempts: { increment: 1 } },
    select: { resetCodeAttempts: true },
  });
  return row.resetCodeAttempts;
}

async function clearResetCode(id, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: { resetCodeHash: null, resetCodeExpiresAt: null, resetCodeAttempts: 0 },
  });
  return findById(id, tx);
}

/** SEC-05 support. Phase 3 enforces it; the data layer provides it. */
async function setActive(id, isActive, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: {
      isActive: Boolean(isActive),
      // Disabling an account must also invalidate its live tokens, or the
      // holder keeps working for up to an hour.
      ...(isActive ? {} : { tokenVersion: { increment: 1 } }),
    },
  });
  return findById(id, tx);
}

/**
 * Mint an ObjectId-shaped external identifier (ADR-051).
 *
 * A user created in MySQL has no MongoDB ObjectId, and `Donation.userId` is a
 * required Mongoose ObjectId ref until donations migrate. Handing back a uuid
 * would make it impossible to attribute a donation to an account created after
 * this package.
 *
 * Generated here rather than by Mongoose so this file imports none. Layout is
 * the documented one: 4-byte seconds, 5-byte random, 3-byte counter.
 * `uq_users_legacy_id` turns a collision into a constraint violation rather
 * than a silent overwrite.
 *
 * AE1(a): a minted value is distinguishable from a real one ONLY while MongoDB
 * exists - look it up; no row means minted. Package 3.6 NULLs these BEFORE
 * deleting Mongo, in that order, or the distinction is lost permanently.
 */
let objectIdCounter = crypto.randomBytes(3).readUIntBE(0, 3);
function mintObjectId() {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = crypto.randomBytes(5).toString('hex');
  objectIdCounter = (objectIdCounter + 1) % 0xffffff;
  return seconds + random + objectIdCounter.toString(16).padStart(6, '0');
}

/**
 * Promote a verified pending signup into a real user, in ONE transaction.
 *
 * The Mongoose version did `new User(...).save()` and then
 * `PendingSignup.findByIdAndDelete(...)` as two independent writes. A failure
 * between them left the account created AND the pending row present, so the
 * next signup attempt for that address hit "user already exists" while a stale
 * pending row kept answering the resend endpoint. Transactions are available
 * now (SPEC-2 section 4.4) and this is exactly what they are for.
 *
 * THE PASSWORD HASH IS MOVED, NOT RE-HASHED. It was hashed at cost 12 when the
 * pending signup was created; re-hashing would need the plaintext, which this
 * layer no longer has and should not want.
 */
async function createFromPendingSignup(email, tx) {
  const normalised = String(email == null ? '' : email).trim().toLowerCase();

  const run = async (db) => {
    const pending = await db.pendingSignup.findUnique({
      where: { email: normalised },
      select: { id: true, name: true, email: true, passwordHash: true, role: true },
    });
    if (!pending) return null;

    const row = await db.user.create({
      data: {
        uuid: newUuid(),
        legacyId: mintObjectId(),
        name: pending.name,
        email: pending.email,
        passwordHash: pending.passwordHash,
        role: pending.role === 'admin' ? 'admin' : 'user',
        // Verified by construction: this is only reached after the signup OTP
        // was accepted. SEC-21's auto-verify branch exists because the admin
        // creation path did NOT set this.
        isVerified: true,
        isActive: true,
        tokenVersion: 0,
      },
      select: SELECT,
    });

    await db.pendingSignup.delete({ where: { id: pending.id } });
    return normalise(row);
  };

  if (tx) return run(tx);
  return withTransaction(run);
}

/** By the MongoDB ObjectId. The bridge's MySQL-first lookup (ADR-050). */
async function findByLegacyId(legacyId, tx) {
  if (!legacyId) return null;
  return normalise(
    await client(tx).user.findUnique({ where: { legacyId: String(legacyId) }, select: SELECT })
  );
}

/**
 * Issue a login OTP. Stored HASHED (SEC-13) and the attempt counter is reset,
 * because a new code is a new budget - unlike the reset-code counter, which
 * ADR-034 deliberately does not clear on a correct guess.
 */
async function setLoginOtp(id, code, expiresAt, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: {
      loginOtpHash: hashCode(code),
      loginOtpExpiresAt: new Date(expiresAt),
      loginOtpAttempts: 0,
    },
  });
  return findById(id, tx);
}

/** SEC-02 parity for the login path. Returns a verdict, never the hash. */
async function verifyLoginOtp(id, candidate, tx) {
  const row = await client(tx).user.findUnique({
    where: { uuid: id },
    select: { loginOtpHash: true, loginOtpExpiresAt: true, loginOtpAttempts: true },
  });
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.loginOtpAttempts >= 5) return { ok: false, reason: 'attempts-exhausted' };
  if (!row.loginOtpHash) return { ok: false, reason: 'no-code' };
  if (!row.loginOtpExpiresAt || new Date() > row.loginOtpExpiresAt) {
    return { ok: false, reason: 'expired' };
  }
  const expected = Buffer.from(row.loginOtpHash, 'hex');
  const actual = Buffer.from(hashCode(candidate), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}

async function incrementLoginOtpAttempts(id, tx) {
  const row = await client(tx).user.update({
    where: { uuid: id },
    data: { loginOtpAttempts: { increment: 1 } },
    select: { loginOtpAttempts: true },
  });
  return row.loginOtpAttempts;
}

async function clearLoginOtp(id, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: { loginOtpHash: null, loginOtpExpiresAt: null, loginOtpAttempts: 0 },
  });
  return findById(id, tx);
}

async function setVerified(id, isVerified, tx) {
  await client(tx).user.update({
    where: { uuid: id },
    data: { isVerified: Boolean(isVerified) },
  });
  return findById(id, tx);
}

/** Profile fields a user may change about themselves. An ALLOWLIST. */
async function updateProfile(id, fields, tx) {
  const data = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.phone !== undefined) data.phone = fields.phone;
  if (fields.address !== undefined) data.address = fields.address;
  if (Object.keys(data).length === 0) return findById(id, tx);
  await client(tx).user.update({ where: { uuid: id }, data });
  return findById(id, tx);
}

async function countAdmins(tx) {
  return client(tx).user.count({ where: { role: 'admin' } });
}

async function deleteByEmailPrefix(prefix, tx) {
  const res = await client(tx).user.deleteMany({ where: { email: { startsWith: prefix } } });
  return res.count;
}

// -----------------------------------------------------------------------------
// Inactive-account retention (package 3.3)
// -----------------------------------------------------------------------------
/**
 * Accounts eligible for the ten-year retention purge.
 *
 * THIS EXISTS BECAUSE RETIRING `dataCleanupService` WOULD OTHERWISE DROP A
 * CONTROL. That service did three things - donation retention, pending-signup
 * expiry, and this - and `services/scheduler.js` had replaced only the first
 * two. The map recorded that the scheduler "already implements the same
 * retention rules", which was true of two thirds of them. Losing a
 * data-retention control silently during a migration is exactly the failure
 * this project exists to avoid, so the rule is carried across rather than
 * quietly dropped.
 *
 * THE GUARDS ARE THE LEGACY ONES, KEPT DELIBERATELY:
 *
 *   - `role: 'user'` - an admin account is never purged, however old.
 *   - NO DONATIONS. A donor's account is never removed by this job. The FK is
 *     ON DELETE SET NULL, so deleting a donor would not destroy their
 *     donations, but it WOULD sever a donation from the person who made it,
 *     and a retention job must not launder attribution away as a side effect.
 *
 * `createdAt` is the right column here, unlike the donation purge (ADR-054):
 * the thing being retained IS the account, so the date the account came into
 * existence is the date the policy is about.
 */
function inactiveWhere(cutoff) {
  return {
    role: 'user',
    createdAt: { lt: new Date(cutoff) },
    donations: { none: {} },
  };
}

async function countInactiveOlderThan(cutoff, tx) {
  return client(tx).user.count({ where: inactiveWhere(cutoff) });
}

async function deleteInactiveOlderThan(cutoff, tx) {
  const res = await client(tx).user.deleteMany({ where: inactiveWhere(cutoff) });
  return res.count;
}

module.exports = {
  create,
  createFromPendingSignup,
  mintObjectId,
  findById,
  findByEmail,
  findByLegacyId,
  setLoginOtp,
  verifyLoginOtp,
  incrementLoginOtpAttempts,
  clearLoginOtp,
  setVerified,
  updateProfile,
  verifyPassword,
  setPassword,
  setResetCode,
  verifyResetCode,
  incrementResetAttempts,
  clearResetCode,
  setActive,
  countAdmins,
  deleteByEmailPrefix,
  // Inactive-account retention (package 3.3), carried across from the retired
  // dataCleanupService rather than dropped with it.
  countInactiveOlderThan,
  deleteInactiveOlderThan,
  normalise,
  BCRYPT_COST,
};
