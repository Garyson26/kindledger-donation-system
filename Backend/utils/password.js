/**
 * =============================================================================
 * ONE password policy (SEC-10), now genuinely shared
 * =============================================================================
 * SEC-10's mechanism is "one shared validator across all five paths", and
 * package 3.2 implemented it - as a function local to `routes/auth.js`, which
 * made it one validator across the five paths IN THAT FILE.
 *
 * There was a sixth. `routes/admin.js`'s change-password endpoint had its own
 * rule, and it was wrong in a way that only a shared validator prevents:
 *
 *     if (!newPassword || newPassword.length < 10) {
 *       return res.status(400).json({ error: "Password must be at least 6 characters long" });
 *     }
 *
 * **The check says 10 and the message says 6.** An admin reading the message
 * and choosing a 7-character password is refused with an error that says it
 * should have worked. That is not a policy defect - the length is right - it is
 * the defect of having a second copy at all, which is exactly what SEC-10 was
 * about.
 *
 * "One validator" has to mean one MODULE, or the next file to need it writes a
 * seventh. Moved here so there is nowhere else to put one.
 * =============================================================================
 */

'use strict';

// A policy that differs by entry point is the weakest of its variants, because
// an attacker picks. Before SEC-10 there were three: `/forgot-password/reset`
// required 10 characters, `/signup` required nothing beyond Mongoose's
// `required`, and `/change-password` accepted a single character.
const MIN_PASSWORD_LENGTH = 10;

/**
 * @param {unknown} value
 * @returns {string|null} A message safe to show the caller, or null if the
 *   password is acceptable. The message quotes the constant rather than a
 *   literal, so the check and the text cannot disagree again.
 */
function passwordProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'Password is required';
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  return null;
}

module.exports = { passwordProblem, MIN_PASSWORD_LENGTH };
