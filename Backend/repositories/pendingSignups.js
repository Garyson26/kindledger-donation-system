/**
 * =============================================================================
 * Pending signup repository (SPEC-2 section 4)
 * =============================================================================
 * MYSQL HAS NO TTL INDEX. MongoDB's expires: 86400 auto-deleted abandoned
 * signups; here expiresAt plus the scheduler sweep replaces it (SPEC-1A
 * section 5.2). That makes deleteExpired() a correctness requirement rather
 * than housekeeping: without it, rows holding a name, an email and a bcrypt
 * hash accumulate indefinitely.
 *
 * ADR-033 notes the Mongo TTL may not even be active in production, in which
 * case that is a live retention issue on the old stack which nothing in this
 * repository addresses.
 * =============================================================================
 */

'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { client, newUuid, iso } = require('./_shared');

const BCRYPT_COST = 12;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/** SEC-13: OTPs are stored hashed, never in plaintext. */
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

const SELECT = {
  uuid: true,
  name: true,
  email: true,
  role: true,
  signupOtpExpiresAt: true,
  signupOtpAttempts: true,
  expiresAt: true,
  createdAt: true,
};

function normalise(row) {
  if (!row) return null;
  return {
    id: row.uuid,
    name: row.name,
    email: row.email,
    role: row.role,
    signupOtpExpiresAt: iso(row.signupOtpExpiresAt),
    signupOtpAttempts: row.signupOtpAttempts,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

async function create(input, tx) {
  const row = await client(tx).pendingSignup.create({
    data: {
      uuid: input.uuid || newUuid(),
      name: input.name,
      email: String(input.email).trim().toLowerCase(),
      passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
      role: input.role || 'user',
      signupOtpHash: hashCode(input.otp),
      signupOtpExpiresAt: new Date(input.otpExpiresAt),
      // Defaulted here so no caller can omit it and leave a row that never
      // expires. This column IS the TTL replacement.
      expiresAt: new Date(input.expiresAt || Date.now() + TWENTY_FOUR_HOURS),
    },
    select: SELECT,
  });
  return normalise(row);
}

async function findByEmail(email, tx) {
  const normalised = String(email == null ? '' : email).trim().toLowerCase();
  if (!normalised) return null;
  return normalise(
    await client(tx).pendingSignup.findUnique({ where: { email: normalised }, select: SELECT })
  );
}

/**
 * Verify the signup OTP.
 *
 * Attempt-capped at 5, which is parity with the login OTP. SEC-02 found that
 * cap enforced on login and absent on the reset path; signupOtpAttempts is a
 * new column added in Phase 1a for exactly this.
 */
async function verifyOtp(email, candidate, tx) {
  const normalised = String(email == null ? '' : email).trim().toLowerCase();
  const row = await client(tx).pendingSignup.findUnique({
    where: { email: normalised },
    select: { signupOtpHash: true, signupOtpExpiresAt: true, signupOtpAttempts: true },
  });
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.signupOtpAttempts >= 5) return { ok: false, reason: 'attempts-exhausted' };
  if (new Date() > row.signupOtpExpiresAt) return { ok: false, reason: 'expired' };

  const expected = Buffer.from(row.signupOtpHash, 'hex');
  const actual = Buffer.from(hashCode(candidate), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}

async function incrementOtpAttempts(email, tx) {
  const row = await client(tx).pendingSignup.update({
    where: { email: String(email).trim().toLowerCase() },
    data: { signupOtpAttempts: { increment: 1 } },
    select: { signupOtpAttempts: true },
  });
  return row.signupOtpAttempts;
}

async function remove(email, tx) {
  const res = await client(tx).pendingSignup.deleteMany({
    where: { email: String(email).trim().toLowerCase() },
  });
  return res.count;
}

/** The TTL replacement. Driven by the scheduler sweep. */
async function deleteExpired(now, tx) {
  const res = await client(tx).pendingSignup.deleteMany({
    where: { expiresAt: { lt: new Date(now || Date.now()) } },
  });
  return res.count;
}

async function countExpired(now, tx) {
  return client(tx).pendingSignup.count({
    where: { expiresAt: { lt: new Date(now || Date.now()) } },
  });
}

async function deleteByEmailPrefix(prefix, tx) {
  const res = await client(tx).pendingSignup.deleteMany({
    where: { email: { startsWith: prefix } },
  });
  return res.count;
}

module.exports = {
  create,
  findByEmail,
  verifyOtp,
  incrementOtpAttempts,
  remove,
  deleteExpired,
  countExpired,
  deleteByEmailPrefix,
  normalise,
  TWENTY_FOUR_HOURS,
};
