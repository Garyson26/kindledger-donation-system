/**
 * =============================================================================
 * PayU configuration, and the guard that config/jwt.js already had (BH5)
 * =============================================================================
 * `MERCHANT_SALT` is the shared secret the PayU request and response hashes are
 * built from. It is the ONLY thing that makes a callback claiming "payment
 * succeeded" distinguishable from one an attacker wrote (SEC-01, ADR-026).
 *
 * -----------------------------------------------------------------------------
 * WITH IT BLANK, THE CHECK IS NOT WEAKER - IT IS PUBLIC
 * -----------------------------------------------------------------------------
 * `docker-compose.yml` declares it as a bare `${PAYU_MERCHANT_SALT}` with no
 * default and no `:?`, and it is absent from `.env`. So the container starts,
 * reports healthy, and `verifyHash` computes
 *
 *     sha512("undefined|success||||||...")
 *
 * which anyone can compute too. Every callback endpoint would accept a forged
 * one and mark a donation PAID. Nothing in the logs would look wrong, because
 * nothing IS wrong from the code's point of view - it verified a hash, and the
 * hash matched.
 *
 * -----------------------------------------------------------------------------
 * THE SIXTH AY2 ADJACENCY, AND THE CONTROL WAS IN THE SAME DIRECTORY
 * -----------------------------------------------------------------------------
 * `config/jwt.js` refuses to load at all without a 32-character JWT_SECRET.
 * This file, next to it, read an equally load-bearing secret into `undefined`
 * and said nothing. The pattern is not "a control was missing"; it is "the
 * control existed a few files away and was not applied here".
 *
 * -----------------------------------------------------------------------------
 * WHY THIS REFUSES AT THE SECURITY DECISION AND NOT AT BOOT
 * -----------------------------------------------------------------------------
 * A throw at require-time, like jwt.js's, would stop the whole application
 * starting - including for work that never touches payments, and including the
 * test harnesses that boot the app to measure auth timing. That creates
 * pressure to set a dummy salt to get the stack up, which is how a guard turns
 * into a formality.
 *
 * Refusing inside `assertSigningConfigured()` fails CLOSED at the exact point
 * the secret is used, cannot be bypassed by how the process was started, and
 * leaves everything that does not sign a PayU message working.
 * =============================================================================
 */

/**
 * THE KEY AND THE SALT ARE NOT THE SAME KIND OF THING, and my first version of
 * this file treated them as if they were.
 *
 * `PAYU_MERCHANT_KEY` is an IDENTIFIER. It travels in the payment form, the
 * customer's browser sees it, and PayU's own test key is `gtKFFx`. It is not
 * secret and has no minimum length - requiring one is a category error.
 *
 * `PAYU_MERCHANT_SALT` is the SECRET. It never leaves the server and is the
 * only thing making a callback unforgeable.
 *
 * I ORIGINALLY REQUIRED 16+ CHARACTERS FOR BOTH, and it rejected
 * `TESTMERCHANTKEY` - fifteen characters - on first contact, failing sixteen
 * tests. That is the argument I made in BB1 for preferring "shares at least one
 * identifier" over a threshold: a number you choose is a number you then have
 * to relax. I made the mistake three steps after writing the warning.
 */
function isPresent(value) {
  return String(value == null ? '' : value).trim().length > 0;
}

/**
 * The salt is the secret, so a placeholder is as bad as nothing. Sixteen is not
 * a strength claim - PayU issues 32-character salts - it is the shortest value
 * that cannot be `test`, `salt`, `changeme` or `xxx`, which is what somebody
 * types to get past an emptiness check.
 */
function isUsableSecret(value) {
  const v = String(value == null ? '' : value).trim();
  return v.length >= 16;
}

/**
 * Refuse to build or check a PayU hash without the secret that makes it mean
 * anything. Called by BOTH `generateHash` and `verifyHash` - signing a request
 * with an empty salt is as wrong as verifying a response with one.
 */
function assertSigningConfigured() {
  const problems = [];
  // The SECRET gets the strength check; the IDENTIFIER only has to exist.
  if (!isUsableSecret(process.env.PAYU_MERCHANT_SALT)) problems.push('PAYU_MERCHANT_SALT');
  if (!isPresent(process.env.PAYU_MERCHANT_KEY)) problems.push('PAYU_MERCHANT_KEY');
  if (problems.length === 0) return;

  const err = new Error(
    `REFUSING to build or verify a PayU hash: ${problems.join(' and ')} ` +
      (problems.length > 1 ? 'are' : 'is') +
      ' missing or too short (16+ characters required). The salt is the ONLY ' +
      'thing that distinguishes a genuine PayU callback from one an attacker ' +
      'wrote; with it blank the hash is sha512 over a string anyone can build, ' +
      'and every forged "payment succeeded" would be accepted (SEC-01, ADR-026). ' +
      'Set it in .env - docker-compose.yml declares it with no default, so a ' +
      'missing value starts a HEALTHY-LOOKING stack with no payment authenticity.'
  );
  err.code = 'ERR_PAYU_UNCONFIGURED';
  throw err;
}

module.exports = {
  assertSigningConfigured,
  isUsableSecret,
  isPresent,
  // Test credentials - Replace with production credentials
  MERCHANT_KEY: process.env.PAYU_MERCHANT_KEY,
  MERCHANT_SALT: process.env.PAYU_MERCHANT_SALT,

  // PayU URLs
  // NO FALLBACK (BW1). This read `|| 'https://test.payu.in'`, which is the
  // same defect as the compose default one layer down - and worse, because it
  // would have survived the compose file being fixed.
  //
  // `docker-compose.yml` now refuses to start without it. An installation that
  // runs the API some other way gets `undefined`, which PayU rejects, which is
  // a loud failure rather than a silent sandbox.
  PAYU_BASE_URL: process.env.PAYU_BASE_URL,

  // Response URLs - Update with your domain
  SUCCESS_URL: process.env.SUCCESS_URL,
  FAILURE_URL: process.env.FAILURE_URL,
  CANCEL_URL: process.env.CANCEL_URL,
  NOTIFY_URL: process.env.NOTIFY_URL, // Webhook for status updates

  // Frontend URLs for redirection
  FRONTEND_SUCCESS_URL: process.env.FRONTEND_SUCCESS_URL,
  FRONTEND_FAILURE_URL: process.env.FRONTEND_FAILURE_URL,
};

