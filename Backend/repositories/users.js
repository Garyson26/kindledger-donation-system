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
      legacyId: input.legacyId ?? null,
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

module.exports = {
  create,
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
  normalise,
  BCRYPT_COST,
};
