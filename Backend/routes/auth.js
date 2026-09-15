/**
 * =============================================================================
 * Authentication routes - MIGRATED TO MySQL (SPEC-3 package 3.2)
 * =============================================================================
 * NO MONGOOSE. All storage goes through Backend/repositories.
 *
 * FINDINGS CLOSED HERE
 *
 *   SEC-03  Unauthenticated authentication bypass. The hotfix on
 *           `hotfix/sec-03-auth-bypass` patched ONE instance by rejecting
 *           non-scalar bodies; this closes the CLASS. A JSON object cannot
 *           become a query operator because nothing is interpolated into a
 *           query any more - `users.findByEmail` binds a parameter. The type
 *           check below is kept as defence in depth, not as the fix.
 *   SEC-04  The Redis-backed limiter from Phase 2 is WIRED HERE. It was built
 *           and left unimported, which is why ADR-042 recorded the finding as
 *           open: the store existing and the store being used are different
 *           claims. This import is the second one.
 *   SEC-05  Tokens carry `tokenVersion`, and the middleware refuses a stale
 *           one. `setPassword` increments it in the data layer, so a call site
 *           cannot forget.
 *   SEC-08  Generic responses on `/login/resend-otp`, `/forgot-password/verify`
 *           and `/forgot-password/reset`. See the note on `/signup` for the one
 *           that is deferred, and on `/login` for the one that was never real.
 *   SEC-10  ONE password validator, applied on every path that sets a password.
 *           There were previously three different rules and two paths with none.
 *   SEC-13  OTPs and reset codes are stored as sha256 hashes by the repository.
 *           They were plaintext in MongoDB.
 *   SEC-18  bcrypt cost 12, in the repository, for every hash it writes.
 *   SEC-19  `failed()` logs the detail and sends a generic message.
 * =============================================================================
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { refuse, failed } = require("../utils/respond");
const authMiddleware = require("../middleware/authMiddleware");
const { JWT_SECRET } = require("../config/jwt");
const {
  sendVerificationEmail,
  sendLoginOTP,
  sendSignupOTP,
  sendSignupAttemptNotice,
} = require("../config/email");

// SEC-04. THIS IMPORT IS WHAT CLOSES THE FINDING. Phase 2 built
// config/rateLimiters.js with a Redis store and nothing imported it; the
// limiter actually in force was a per-process MemoryStore declared inline here.
// Same 5-per-minute budget, so wiring it changes the STORE and nothing else -
// a package that silently tightened the limit would be indistinguishable from
// one that broke something.
const {
  authLimiter: makeAuthLimiter,
  resetAttemptLimiter: makeResetAttemptLimiter,
} = require("../config/rateLimiters");
const authLimiter = makeAuthLimiter();

// AQ1, built in AV1. The per-ADDRESS reset-attempt cap. It runs BEFORE the
// handler, so an address with no account is capped identically to one with an
// account - the uniformity is structural rather than two branches somebody has
// to keep byte-identical. See config/rateLimiters.js for why it is a window and
// not a budget.
const resetAttemptLimiter = makeResetAttemptLimiter();

const users = require("../repositories/users");
const pendingSignups = require("../repositories/pendingSignups");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;

const generateVerificationCode = () => crypto.randomInt(100000, 1000000).toString();

// -----------------------------------------------------------------------------
// SEC-03 - defence in depth, NOT the fix
// -----------------------------------------------------------------------------
// The fix is that this file no longer builds queries from user input. This
// remains because rejecting a type is free and does not depend on every future
// call site staying parameterised.
//
// REJECTED, NOT COERCED. `String({$ne:null})` is "[object Object]", which would
// turn an attack into a lookup for a nonexistent user and quietly succeed at
// looking like an ordinary failure. An object arriving here is an attack.
function isScalar(v) {
  return v === null || v === undefined || typeof v !== "object";
}

router.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object") return next();
  for (const [key, value] of Object.entries(req.body)) {
    if (isScalar(value)) continue;
    console.warn(`[SEC-03] Rejected non-scalar '${key}' on ${req.method} ${req.path}`);
    // Indistinguishable from a wrong password on the credential paths, so a
    // probe cannot tell "operators are rejected" from "no such account".
    return refuse(res, 400, "Invalid credentials");
  }
  if (req.body.email !== undefined && req.body.email !== null && typeof req.body.email !== "string") {
    return refuse(res, 400, "Invalid credentials");
  }
  return next();
});

// -----------------------------------------------------------------------------
// SEC-10 - ONE password policy, and it now lives in ONE MODULE.
// -----------------------------------------------------------------------------
// It was defined here in package 3.2, which made it one validator across the
// five paths IN THIS FILE. routes/admin.js had a sixth, whose check said 10 and
// whose message said 6. "One validator" has to mean one module or the next file
// that needs it writes a seventh. See utils/password.js.
const { passwordProblem } = require("../utils/password");

/**
 * The session token.
 *
 * SEC-05: `tokenVersion` is a CLAIM the middleware compares against the stored
 * value. A password change or a disable increments the stored one, and every
 * token issued before that stops verifying.
 */
function issueToken(user) {
  return jwt.sign(
    { userId: user.legacyId || user.id, role: user.role, tokenVersion: user.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

/** The wire shape for a user. The repository never returns a hash to begin with. */
function present(user) {
  return {
    _id: user.legacyId || user.id,
    uuid: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

// =============================================================================
// Signup
// =============================================================================

router.post("/signup", authLimiter, async (req, res) => {
  try {
    const { name, email, password, role, adminKey } = req.body;

    if (!name || !email) return refuse(res, 400, "Name and email are required");
    const problem = passwordProblem(password);
    if (problem) return refuse(res, 400, problem);

    // Admin creation stays fail-closed: without a matching key the request is
    // refused outright rather than silently downgraded to a normal user, so a
    // misconfigured deployment cannot mint admins by accident.
    let assignedRole = "user";
    if (role === "admin") {
      if (!process.env.ADMIN_CREATION_KEY || adminKey !== process.env.ADMIN_CREATION_KEY) {
        return refuse(res, 403, "Admin creation requires a valid adminKey");
      }
      assignedRole = "admin";
    }

    // =========================================================================
    // SEC-08's LAST ORACLE, CLOSED (package 3.5a)
    // =========================================================================
    // This answered `400 "User already exists with this email"`, which told an
    // attacker the address holds an account. It answers identically now,
    // whether or not it does.
    //
    // BOTH HALVES ARE REQUIRED. A uniform response with no email behind it is a
    // lie to the attacker and a SILENCE TO THE VICTIM - the person whose
    // address was used would never learn it happened. So the existing-account
    // path sends a notice instead of an OTP, and says the same thing to the
    // caller either way.
    //
    // BOTH SENDS ARE FIRE-AND-FORGET, AND GETTING THAT WRONG FIRST IS WHY THE
    // COMMENT SAYS SO.
    //
    // My first version made only the NOTICE best-effort and left the OTP path
    // awaiting its send with a rollback and a 500. That did not close the
    // oracle - IT INVERTED IT. With mail degraded, an address that HAS an
    // account answers 200 and one that does not answers 500, which distinguishes
    // them perfectly. The test caught it immediately; reading the code did not,
    // because the asymmetry is in the branch I was not editing.
    //
    // So neither branch signals mail delivery. `/signup/resend-otp` already
    // worked this way for exactly this reason, in this file - the precedent was
    // three functions away and I did not apply it.
    //
    // THE COST, STATED: a user whose address genuinely bounces is told "check
    // your email" and receives nothing. That is inherent to a uniform response
    // and it is the price SEC-08 asks. The pending row is KEPT rather than
    // rolled back so `/signup/resend-otp` is a real recovery path, and the
    // 24-hour sweep removes it if nobody uses it.
    //
    // WHAT REMAINS AND IS NOT CLOSED HERE: a TIMING difference. The new-account
    // path hashes a password and writes a row; this one does neither. That is a
    // far weaker signal than a distinct message and closing it means constant-
    // time signup, which is a different piece of work. Recorded in the map
    // rather than left implied by the absence of a comment.
    const existing = await users.findByEmail(email);

    if (existing) {
      sendSignupAttemptNotice(email, existing.name).catch((e) =>
        console.error("[auth] signup-attempt notice failed:", e && e.message)
      );
    } else {
      const otp = generateVerificationCode();
      await pendingSignups.upsert({
        name,
        email,
        password,
        role: assignedRole,
        otp,
        otpExpiresAt: Date.now() + OTP_TTL_MS,
      });

      // The Mongoose version rolled back here on a mail failure, reasoning that
      // "a pending signup whose OTP was never delivered is a row nobody can act
      // on". That stopped being true when `/signup/resend-otp` was made uniform
      // - the row IS actionable now, by the person who owns the address.
      sendSignupOTP(email, otp, name).catch((e) =>
        console.error("[auth] signup OTP send failed:", e && e.message)
      );
    }

    // ONE response object, constructed once, reached by both paths. Two
    // `res.json` calls with the same literal would be two things somebody has
    // to keep byte-identical - which is exactly how my first SEC-08 fix left a
    // fourth endpoint differing (AP1).
    res.json({
      message: "Registration initiated. Please check your email for OTP verification.",
      email,
    });
  } catch (err) {
    failed(res, "Could not start registration", err, { tag: "auth" });
  }
});

router.post("/signup/verify-otp", authLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return refuse(res, 400, "Email and OTP are required");

    // SEC-08. EVERY failure on this endpoint answers identically, including
    // "there is no pending signup at all". The previous 404 told an attacker
    // which addresses had registrations in flight - a weaker oracle than
    // account existence, but an oracle, and one that also reveals that someone
    // is mid-signup right now.
    //
    // The attempt cap still runs; it simply does not announce itself. A real
    // user who exhausts it requests a new code and it works.
    const pending = await pendingSignups.findByEmail(email);
    if (!pending) return refuse(res, 400, "Invalid OTP");

    const verdict = await pendingSignups.verifyOtp(email, otp);
    if (!verdict.ok) {
      if (verdict.reason === "attempts-exhausted") {
        await pendingSignups.remove(email);
        return refuse(res, 400, "Invalid OTP");
      }
      // SEC-02 parity for the signup path. The Mongoose version had NO attempt
      // cap here at all - the cap existed on login and on reset, and this was
      // the gap.
      await pendingSignups.incrementOtpAttempts(email);
      return refuse(res, 400, "Invalid OTP");
    }

    const created = await users.createFromPendingSignup(email);
    if (!created) return refuse(res, 400, "Invalid OTP");

    res.json({
      message: "Email verified successfully. Account created!",
      token: issueToken(created),
      user: present(created),
    });
  } catch (err) {
    failed(res, "Could not verify the code", err, { tag: "auth" });
  }
});

router.post("/signup/resend-otp", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return refuse(res, 400, "Email is required");

    const otp = generateVerificationCode();
    const pending = await pendingSignups.setOtp(email, otp, Date.now() + OTP_TTL_MS);
    if (pending) {
      // Fire and forget, so a mail failure cannot distinguish by status either.
      sendSignupOTP(email, otp, pending.name).catch((e) =>
        console.error("[auth] signup OTP resend failed:", e && e.message)
      );
    }

    // SEC-08. WAS 404 for an unknown address and 200 for a known one. Identical
    // now, whatever happened.
    res.json({ message: "If a signup is pending for this address, a new code has been sent." });
  } catch (err) {
    failed(res, "Could not resend the code", err, { tag: "auth" });
  }
});

// =============================================================================
// Login
// =============================================================================

router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return refuse(res, 400, "Invalid credentials");

    // An unverified signup. NOT a SEC-08 leak, despite the review listing it as
    // one: the disclosure below is reached ONLY when the password matches, so a
    // caller who does not already hold the credentials gets the same
    // "Invalid credentials" as every other failure. Verified by reading the
    // branch rather than inherited from the review (AN3).
    const pending = await pendingSignups.findByEmail(email);
    if (pending) {
      if (!(await pendingSignups.verifyPassword(email, password))) {
        return refuse(res, 400, "Invalid credentials");
      }
      const otp = generateVerificationCode();
      await pendingSignups.setOtp(email, otp, Date.now() + OTP_TTL_MS);
      await sendSignupOTP(email, otp, pending.name);
      return res.status(403).json({
        error: "Your email is not verified yet. We've sent a new OTP to complete your signup.",
        message: "Your email is not verified yet. We've sent a new OTP to complete your signup.",
        needsSignupVerification: true,
        email,
      });
    }

    const user = await users.findByEmail(email);
    // SEC-08, and the shape that must not change: an unknown address and a
    // wrong password answer IDENTICALLY. The natural repository implementation
    // returns null for one and false for the other, and reporting those
    // separately reads like better error handling - see the warning on
    // repositories/users.verifyPassword.
    if (!user) return refuse(res, 400, "Invalid credentials");
    if (!(await users.verifyPassword(user.id, password))) {
      return refuse(res, 400, "Invalid credentials");
    }

    // SEC-05: a disabled account cannot log in. The flag existed and nothing
    // ever read it, so "disable user" had no effect at all.
    if (!user.isActive) return refuse(res, 403, "This account has been disabled");

    // THIS COMMENT USED TO CLAIM A NARROWING THAT THE CODE DOES NOT DO (AJ3).
    // It said the branch had been "narrowed to accounts that predate the OTP
    // flow rather than applying to everyone". It applies to everyone. The
    // narrowing was described and never implemented, and the wrong version
    // would have been inherited by the next reader as a fact.
    //
    // WHAT IS ACTUALLY TRUE, checked by enumerating every read of the flag:
    // `isVerified` IS READ NOWHERE ELSE. Not in a route, not in a middleware.
    // The only line in the codebase that reads it is this one, and it exists to
    // set it true. So the flag GATES NOTHING - an "unverified" account has
    // exactly the capabilities of a verified one.
    //
    // That is SEC-05's shape exactly (a flag that exists, is settable from the
    // admin UI, and is never read), and it is why SEC-21 was understated at Low.
    // The practical exposure is narrower than SEC-05's was, because self-service
    // signup enforces verification STRUCTURALLY - the User row does not exist
    // until the PendingSignup OTP is confirmed - so only admin-created accounts
    // are affected.
    //
    // NOT CHANGED HERE. Making `isVerified` a real gate is a behaviour change
    // that belongs with SEC-21's owner (admin.js, 3.5); removing this line would
    // change nothing today and would leave admin-created accounts flagged
    // unverified forever with no difference in what they can do.
    if (!user.isVerified) await users.setVerified(user.id, true);

    const otp = generateVerificationCode();
    await users.setLoginOtp(user.id, otp, Date.now() + OTP_TTL_MS);

    const emailResult = await sendLoginOTP(email, otp, user.name);
    if (!emailResult.success) {
      return refuse(res, 500, "Failed to send OTP email. Please try again.");
    }

    res.json({ message: "OTP sent to your email", email, requiresOTP: true });
  } catch (err) {
    failed(res, "Could not sign you in", err, { tag: "auth" });
  }
});

router.post("/login/verify-otp", authLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return refuse(res, 400, "Email and OTP are required");

    // SEC-08, AND THIS ONE WAS STILL OPEN AFTER THE FIRST PASS. An unknown
    // address answered "Invalid credentials" while a known one with a wrong
    // code answered "Invalid OTP" - two different strings, so the endpoint
    // confirmed existence to anyone who tried one guess. Found by auditing
    // every branch rather than only the endpoints already under test (AP1).
    const user = await users.findByEmail(email);
    if (!user) return refuse(res, 400, "Invalid OTP");

    const verdict = await users.verifyLoginOtp(user.id, otp);
    if (!verdict.ok) {
      // Expired and exhausted both collapse into the same answer: an attacker
      // can DRIVE a known account into either state, so a distinct response for
      // them is an oracle with extra steps.
      if (verdict.reason === "attempts-exhausted") {
        await users.clearLoginOtp(user.id);
        return refuse(res, 400, "Invalid OTP");
      }
      await users.incrementLoginOtpAttempts(user.id);
      return refuse(res, 400, "Invalid OTP");
    }

    // Reached only with a CORRECT OTP, so this discloses nothing to anyone who
    // does not already hold it. Not an enumeration vector.
    if (!user.isActive) return refuse(res, 403, "This account has been disabled");

    await users.clearLoginOtp(user.id);
    const fresh = await users.findById(user.id);

    res.json({ message: "Login successful", token: issueToken(fresh), user: present(fresh) });
  } catch (err) {
    failed(res, "Could not verify the code", err, { tag: "auth" });
  }
});

router.post("/login/resend-otp", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return refuse(res, 400, "Email is required");

    const user = await users.findByEmail(email);
    if (user && user.isActive) {
      const otp = generateVerificationCode();
      await users.setLoginOtp(user.id, otp, Date.now() + OTP_TTL_MS);
      // Fire and forget, so a mail failure cannot reveal existence by timing or
      // by status.
      sendLoginOTP(email, otp, user.name).catch((e) =>
        console.error("[auth] login OTP resend failed:", e && e.message)
      );
    }

    // SEC-08 CLOSED HERE. This answered 404 "User not found" for an unknown
    // address and 200 for a known one, which is a free account oracle on an
    // unauthenticated endpoint. The response is now identical either way.
    res.json({ message: "If an account exists for this email, a new code has been sent." });
  } catch (err) {
    failed(res, "Could not resend the code", err, { tag: "auth" });
  }
});

// =============================================================================
// Password reset
// =============================================================================

router.post("/forgot-password/request", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return refuse(res, 400, "Email is required");

    const user = await users.findByEmail(email);
    if (user && user.isActive) {
      const code = generateVerificationCode();
      await users.setResetCode(user.id, code, Date.now() + RESET_TTL_MS);
      sendVerificationEmail(email, code, user.name).catch((e) =>
        console.error("[auth] reset email failed:", e && e.message)
      );
    }

    // Already generic before this package. Unchanged.
    res.json({
      message: "If an account exists for this email, a verification code has been sent.",
    });
  } catch (err) {
    failed(res, "Could not process the request", err, { tag: "auth" });
  }
});

router.post("/forgot-password/verify", authLimiter, resetAttemptLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return refuse(res, 400, "Email and verification code are required");

    const user = await users.findByEmail(email);
    // SEC-08 CLOSED HERE. This answered 404 "User not found" for an unknown
    // address. An unknown address now takes the same path as a wrong code.
    if (!user) return refuse(res, 400, "Invalid verification code");

    const verdict = await users.verifyResetCode(user.id, code);
    if (!verdict.ok) {
      // THE SEC-02 / SEC-08 CONFLICT IS RESOLVED (AQ1, built in AV1).
      //
      // WAS: `429 Too many attempts` plus `clearResetCode(user.id)`. Two
      // separate problems.
      //
      //   1. THE 429 WAS AN ORACLE. It was reachable only for an address that
      //      HAS an account - an attacker requested a reset for the address,
      //      guessed five times, and the 429 confirmed the account exists. The
      //      per-ADDRESS limiter now produces that 429 for every address, above
      //      this handler, before anything has been looked up.
      //
      //   2. VOIDING THE CODE WAS A GRIEFING PRIMITIVE. It defended nothing -
      //      an exhausted counter already refuses the code without comparing it
      //      - and it let anyone who knows an address destroy that user's
      //      pending reset with five requests. That is capping the ACCOUNT, and
      //      AQ1's second requirement exists to forbid it.
      //
      // So exhaustion now answers EXACTLY like a wrong code, and the row is
      // untouched. The per-account counter remains as defence in depth: it
      // survives a Redis outage, and it still refuses without ever revealing
      // that it is the thing refusing.
      //
      // A user delayed by the cap is never stuck: `/forgot-password/request` is
      // deliberately NOT behind this limiter, so a fresh code and a fresh
      // per-account budget are always obtainable.
      if (verdict.reason === "attempts-exhausted") {
        return refuse(res, 400, "Invalid verification code");
      }
      // SEC-08, AND MY FIRST FIX WAS INCOMPLETE. A known address with no code
      // answered "No verification code found" while an unknown address
      // answered "Invalid verification code" - so the oracle survived the
      // change that was supposed to remove it. Both are now the same string.
      // Found by the test asserting byte-identical bodies rather than merely
      // identical statuses.
      await users.incrementResetAttempts(user.id);
      return refuse(res, 400, "Invalid verification code");
    }

    // ADR-034: the attempt counter is deliberately NOT cleared on a correct
    // code. This endpoint only CHECKS it; /reset still has to accept it, and
    // clearing here would hand a lucky guesser a fresh budget of five, then
    // another five by alternating between the two endpoints.
    res.json({ message: "Verification successful", verified: true });
  } catch (err) {
    failed(res, "Could not verify the code", err, { tag: "auth" });
  }
});

router.post("/forgot-password/reset", authLimiter, resetAttemptLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return refuse(res, 400, "All fields are required");

    const problem = passwordProblem(newPassword);
    if (problem) return refuse(res, 400, problem);

    const user = await users.findByEmail(email);
    // SEC-08 CLOSED HERE, same as /verify.
    if (!user) return refuse(res, 400, "Invalid verification code");

    const verdict = await users.verifyResetCode(user.id, code);
    if (!verdict.ok) {
      // Same resolution as /verify (AQ1): exhaustion is indistinguishable from
      // a wrong code, and the user's row is not touched. The two endpoints
      // share ONE per-address bucket, so alternating between them cannot top
      // the budget up - ADR-034's concern, enforced by the limiter's key rather
      // than by each handler remembering.
      if (verdict.reason === "attempts-exhausted") {
        return refuse(res, 400, "Invalid verification code");
      }
      // SEC-08: same as /verify - "no code" and "no such account" must be
      // indistinguishable.
      await users.incrementResetAttempts(user.id);
      return refuse(res, 400, "Invalid verification code");
    }

    // SEC-05: setPassword clears the code, resets the counter AND increments
    // tokenVersion, all in the data layer - so every session issued before this
    // reset stops working, which is the point of resetting a password after a
    // compromise.
    await users.setPassword(user.id, newPassword);

    res.json({ message: "Password reset successful" });
  } catch (err) {
    failed(res, "Could not reset the password", err, { tag: "auth" });
  }
});

// =============================================================================
// Authenticated
// =============================================================================

router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const problem = passwordProblem(newPassword);
    if (problem) return refuse(res, 400, problem);

    const user = req.user.uuid ? await users.findById(req.user.uuid) : null;
    if (!user) return refuse(res, 404, "User not found");

    if (!(await users.verifyPassword(user.id, oldPassword))) {
      return refuse(res, 400, "Invalid old password");
    }

    await users.setPassword(user.id, newPassword);

    // The caller's own token is now stale - `setPassword` incremented
    // tokenVersion. Stated in the response so a client can re-authenticate
    // rather than discovering it on the next request.
    res.json({
      msg: "Password changed successfully",
      message: "Password changed successfully",
      reauthenticationRequired: true,
    });
  } catch (err) {
    failed(res, "Could not change the password", err, { tag: "auth" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    // Via the middleware now, not an inline JWT verification. The duplicate
    // copy meant every check added to authMiddleware - SEC-05's isActive among
    // them - silently did not apply here.
    const user = req.user.uuid ? await users.findById(req.user.uuid) : null;
    if (!user) return refuse(res, 404, "User not found");

    res.json({
      _id: user.legacyId || user.id,
      uuid: user.id,
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || "",
      address: user.address || "",
      role: user.role || "user",
    });
  } catch (err) {
    failed(res, "Could not load the profile", err, { tag: "auth" });
  }
});

module.exports = router;
