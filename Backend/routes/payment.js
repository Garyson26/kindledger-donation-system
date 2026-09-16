/**
 * =============================================================================
 * Payments - MIGRATED TO MySQL (SPEC-3 package 3.4)
 * =============================================================================
 * NO MONGOOSE. This was the LAST live writer of donations, so migrating it
 * closes the final `split` entity and completes the 3.2 + 3.3 + 3.4 merge unit
 * (ADR-057): until now a donation taken through `/initiate` landed in MongoDB
 * while `routes/donations.js` read MySQL, and was invisible to the admin
 * console, the receipt and the charts.
 *
 * WHAT IS PRESERVED EXACTLY, because `test/payment-callbacks.test.js` is
 * SEC-01's regression suite and its scenarios must pass unchanged: hash
 * verification before any state change, the status/endpoint match in both
 * directions, idempotency on an already-paid donation, the server-priced amount
 * comparison in integer minor units, PayU's vocabulary stored verbatim with no
 * invented text, field-level merges rather than subdocument replacement, and
 * every redirect target and query string.
 *
 * WHAT CHANGED, and each is a finding rather than a tidy-up - see the notes at
 * each site: SEC-06, SEC-07, SEC-11, SEC-14, SEC-19, PAY-01, ADR-012/026,
 * SPEC-3 section 4.6, and U-2's design half.
 * =============================================================================
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const payuConfig = require('../config/payu');

const { donations, categories, toMinorUnits: sharedToMinorUnits } = require('../repositories');
const { refuse, failed } = require('../utils/respond');
const { idShape } = require('../services/legacyBridge');
const authMiddleware = require('../middleware/authMiddleware');
// SEC-11: built in Phase 2 and never wired (ADR-042's shape - the limiter
// existing and the limiter being used are different claims). Wired below.
const { paymentInitiateLimiter } = require('../config/rateLimiters');

// services/categoryBridge IS NO LONGER USED HERE. `category` is
// MySQL-authoritative (config/migrationState), so this file reads the
// repository directly and the malformed-id case is handled by checking the id
// SHAPE before dispatch - which is what the bridge was doing for it. That
// removes two of the bridge's three remaining call sites; only
// admin.js's countCategories is left, and ADR-050 retires it in 3.6.

/** BUG-08's ceiling, applied to quantity rather than to a page size (PAY-01). */
const MAX_QUANTITY = 10_000;
const MAX_EXTRA_MAJOR = 1_000_000;

/**
 * The transaction reference sent to PayU and used by the receipt lookup.
 *
 * SEC-06. The old scheme was `TXN${Date.now()}${rand(0,999)}` - the timestamp
 * is recoverable from the value, so the search space collapses to a known
 * millisecond window times one thousand. It was the ONLY thing protecting
 * `GET /status/:txnid`, which is unauthenticated.
 *
 * 80 bits of randomness, no structure. Kept SHORT deliberately: the previous
 * scheme produced 16-17 characters and is proven against the live gateway at
 * that length, so this stays at 23 rather than using a 36-character uuid.
 *
 * **VERIFIED (AV3). PayU's documented limit is 25 characters; this is 23.**
 *
 *   "Transaction ID (or Order ID) generated at the merchant end. Must be
 *    unique for every new transaction. Character limit: 25."
 *   - https://docs.payu.in/reference/addl_info-payment-apis
 *
 * Two characters of headroom, and the value is alphanumeric. It was carried as
 * UNVERIFIED for one package and closed from the public documentation without a
 * sandbox at all - the `llms.txt` route. `test:payment-char` asserts the length
 * so the headroom cannot be spent by accident.
 */
function mintTransactionRef() {
  return 'TXN' + crypto.randomBytes(10).toString('hex');
}

/**
 * Optional authentication (BUG-06, fixed rather than inherited).
 *
 * `routes/donations.js` had a helper of this name that DELEGATED to
 * authMiddleware whenever any Authorization header was present - so a donor
 * whose session had lapsed was refused with a 401 instead of falling through to
 * a guest donation. That endpoint was deleted in 3.3 and the helper with it;
 * this one is written the way that one should have been.
 *
 * A BAD TOKEN IS A GUEST, NOT A REFUSAL. The endpoint does not require an
 * identity, so failing to establish one is not an error - and on the donation
 * path, turning a lapsed session into a refusal loses the donation.
 */
function optionalAuth(req, res, next) {
  const header = req.header('Authorization') || req.headers['authorization'];
  if (!header) return next();

  // A local response object: authMiddleware refuses by WRITING a response, and
  // here a refusal must be swallowed rather than sent.
  let refused = false;
  const sink = {
    status() {
      return sink;
    },
    json() {
      refused = true;
      return sink;
    },
  };

  Promise.resolve(authMiddleware(req, sink, () => {}))
    .catch(() => {
      refused = true;
    })
    .finally(() => {
      if (refused) delete req.user;
      next();
    });
}

// Helper function to generate PayU hash
function generateHash(data) {
  // Formula: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
  const hashString = `${payuConfig.MERCHANT_KEY}|${data.txnid}|${data.amount}|${data.productinfo}|${data.firstname}|${data.email}|${data.udf1 || ''}|${data.udf2 || ''}|${data.udf3 || ''}|${data.udf4 || ''}|${data.udf5 || ''}||||||${payuConfig.MERCHANT_SALT}`;
  return crypto.createHash("sha512").update(hashString).digest("hex");
}

// Helper function to verify response hash (timing-safe comparison)
//
// ============================================================================
// THIS FUNCTION MUST READ CANONICAL LOWERCASE FIELD NAMES ONLY.
// DO NOT MAKE IT CASE-TOLERANT OR ADD ALTERNATE-NAME FALLBACKS.
// ============================================================================
//
// The handlers below read several fields with alternate-case and alternate-name
// fallbacks: `paymentData.AMOUNT`, `.STATUS`, `.TXNID`, `.MIHPAYID`, and
// `udf_4` / `udf[4]`. This function does not. That disagreement is a parser
// differential, and it is currently safe only by accident of direction: a
// payload lacking the lowercase form hashes a different string and is rejected
// here, before any handler fallback is ever consulted. The fallbacks are
// therefore dead code rather than a hole.
//
// THE DISAGREEMENT IS THE BUG, NOT THE DIRECTION OF IT.
//
// Making this function case-tolerant looks like a robustness improvement -
// someone reads SEC-14, sees brittle input handling, and hardens it. At that
// moment a payload can VERIFY against one field and be PROCESSED from another:
// the hash would cover `status` while the SEC-01 gate reads `STATUS`. That is a
// hash-verified authentication bypass, assembled from two individually
// reasonable changes neither of whose authors did anything obviously wrong.
//
// If you want to remove the brittleness, delete the fallbacks in the handlers.
// Never widen what this function accepts. See docs/decisions.md ADR-026.
//
// PayU's documented formula, which this implements verbatim:
//   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
// Only those fields are signed. Everything else in the callback is unsigned and
// attacker-mutable, because the payload arrives via the donor's browser.
function verifyHash(data) {
  // Response formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
  const hashString = `${payuConfig.MERCHANT_SALT}|${data.status}||||||${data.udf5 || ''}|${data.udf4 || ''}|${data.udf3 || ''}|${data.udf2 || ''}|${data.udf1 || ''}|${data.email}|${data.firstname}|${data.productinfo}|${data.amount}|${data.txnid}|${payuConfig.MERCHANT_KEY}`;
  const expected = crypto.createHash("sha512").update(hashString).digest("hex");
  const received = data.hash || '';
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

// SEC-01: the signed `status` field must match the endpoint being called.
// PayU signs failure and cancellation responses with the same formula as a
// success, so a valid hash proves only that PayU sent the payload - not that
// the payment succeeded. The donor can read their own failed payload straight
// out of the browser network tab, because PayU delivers these as a form POST
// through the browser.
function isSuccessStatus(status) {
  return String(status || '').trim().toLowerCase() === 'success';
}

// SEC-01: convert a currency value to integer minor units (paise) for exact
// comparison. Amounts must never be compared as floats - `1500.00 !== 1500.00`
// is not a hypothetical once values arrive as strings from a gateway and as
// binary doubles from the database.
//
// PayU sends a decimal string, which is parsed digit-wise and never passed
// through a float. The stored amount is currently a Mongoose Number, so it is
// rounded; that rounding disappears in Phase 1a, where the column becomes
// integer paise.
//
// Returns null for anything malformed, which callers must treat as a mismatch.
function toMinorUnits(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const minor = m[2] ? Number.parseInt(m[2].padEnd(2, '0'), 10) : 0;
  return major * 100 + minor;
}

// Initiate Payment
/**
 * SEC-14: a hash must LOOK like a hash before it is decoded.
 *
 * `verifyHash` compares lengths and then calls `Buffer.from(received, 'hex')`.
 * A 128-character string that is not hex decodes to fewer than 64 bytes, and
 * `timingSafeEqual` throws a RangeError on a length mismatch - which escapes as
 * an unhandled rejection and answers 500 instead of refusing.
 *
 * The donation stays Pending, so it FAILS CLOSED and no money moves. It is
 * still wrong: a malformed input from an untrusted source must be a DECISION,
 * and a test asserting only the donation state cannot tell a refusal from a
 * crash. That is SEC-14's actual content, and it is why AC1 asks for the
 * mechanism.
 */
function isWellFormedHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{128}$/i.test(value);
}

/**
 * Start a payment.
 *
 * SEC-11: rate limited. The limiter has existed since Phase 2 and nothing
 * imported it, so an unauthenticated caller could create donation rows and
 * trigger gateway traffic without limit.
 */
router.post('/initiate', paymentInitiateLimiter(), optionalAuth, async (req, res) => {
  try {
    const { firstname, email, phone, productinfo, category, item, quantity, extraAmount } =
      req.body || {};

    // SEC-07: `userId` IS NOT READ FROM THE BODY.
    //
    // It used to be destructured from `req.body` on an endpoint with no
    // authentication at all, so anyone on the internet could attribute a
    // donation to any account they could name - writing rows into a stranger's
    // donation history. The identity now comes from the token or there is no
    // identity, which is what `optionalAuth` is for: a guest donation is a
    // donation with no user, not a donation with a user the caller asserted.
    const donorUserId = req.user && req.user.id ? req.user.id : null;

    if (!firstname || !email) {
      return refuse(res, 400, 'Firstname and email are required');
    }
    if (!category) {
      return refuse(res, 400, 'Category is required');
    }

    // The category, read from MySQL directly. The SHAPE is checked before the
    // lookup so a malformed id is a 400 rather than a driver error - the job
    // the bridge was doing here (ADR-050).
    const shape = idShape(category);
    const dbCategory =
      shape === 'objectid'
        ? await categories.findByLegacyId(String(category).trim())
        : shape === 'uuid'
          ? await categories.findById(String(category).trim())
          : null;
    if (!dbCategory) {
      return refuse(res, 400, 'Invalid category');
    }

    // PAY-01: BOTH inputs are bounded now.
    //
    // `extraAmount` was clamped and `quantity` was not, on adjacent lines - and
    // the asymmetry is the tell: a reviewer reading the pair concludes that
    // amounts are bounded. `quantity=99999999999999999999` priced a donation at
    // 1.5e23, and against MySQL it would have been an unauthenticated 500 when
    // the value failed to convert to integer paise.
    const qty = Math.min(MAX_QUANTITY, Math.max(1, Number.parseInt(quantity, 10) || 1));
    const extraMajor = Math.max(0, Math.min(MAX_EXTRA_MAJOR, Number.parseFloat(extraAmount) || 0));

    // Money in integer minor units from here down (ADR-010). The category price
    // is ALREADY minor units in MySQL, so the multiplication is exact and there
    // is no float in the chain at all - the previous version computed
    // `donationAmount * qty + extra` in floating point and rounded at the edge.
    const extraMinor = sharedToMinorUnits(extraMajor);
    if (extraMinor === null) {
      return refuse(res, 400, 'extraAmount is not a valid amount');
    }
    const baseMinor = dbCategory.donationAmountMinor * qty;
    const totalMinor = baseMinor + extraMinor;

    const txnid = mintTransactionRef();

    const donation = await donations.create({
      // NO MINTED `legacyId`, AND THIS IS AE1-b's TRIGGER FIRING.
      //
      // Categories and users minted ObjectId-shaped legacy ids for one reason:
      // `Donation.category` and `Donation.userId` were Mongoose ObjectId refs,
      // and a MySQL-only row could not be referenced by one. THIS LINE IS THE
      // LAST PLACE THAT MATTERED - it is where a donation referencing them was
      // written - and it now writes MySQL.
      //
      // So a donation created from here has `legacy_id` NULL and is addressed
      // by its uuid. ADR-051 anticipated exactly this state and warns the ETL
      // not to read `legacy_id IS NULL` as "created after cutover"; that is now
      // a live condition rather than a hypothetical one.
      transactionRef: txnid,
      donorName: firstname,
      donorEmail: email,
      donorPhone: phone || null,
      userId: donorUserId || undefined,
      categoryId: dbCategory.legacyId || dbCategory.id,
      item: item || productinfo || 'Donation',
      quantity: qty,
      baseAmountMinor: baseMinor,
      extraAmountMinor: extraMinor,
      amountMinor: totalMinor,
      status: 'Pending',
      paymentStatus: 'Pending',
    });

    const externalId = donation.legacyId || donation.id;

    const paymentData = {
      key: payuConfig.MERCHANT_KEY,
      txnid,
      amount: (totalMinor / 100).toFixed(2),
      productinfo: productinfo || 'Donation',
      firstname,
      email,
      phone: phone || '9999999999',
      surl: payuConfig.SUCCESS_URL,
      furl: payuConfig.FAILURE_URL,
      curl: payuConfig.CANCEL_URL,
      notify_url: payuConfig.NOTIFY_URL,
      udf1: dbCategory.legacyId || dbCategory.id,
      udf2: item || '',
      udf3: String(qty),
      udf4: externalId,
      // U-2's design half: `udf5` carried the client-supplied userId, which
      // SEC-07 has just removed as an input. It now carries the AUTHENTICATED
      // user's id, or nothing - so the value in PayU's records is one we
      // established rather than one the caller asserted.
      udf5: donorUserId || '',
    };

    paymentData.hash = generateHash(paymentData);

    res.json({
      success: true,
      paymentData,
      payuUrl: `${payuConfig.PAYU_BASE_URL}/_payment`,
      donationId: externalId,
      message: 'Payment initiated successfully',
    });
  } catch (error) {
    // SEC-19: the detail goes to the log, never to the client.
    return failed(res, 'Failed to initiate payment', error, { tag: 'payment' });
  }
});

/**
 * Resolve a donation from a callback, WITHOUT letting a malformed id reach the
 * database (AD1b).
 */
async function resolveDonation(externalId) {
  const shape = idShape(externalId);
  if (shape === 'objectid') return donations.findByLegacyId(String(externalId).trim());
  if (shape === 'uuid') return donations.findById(String(externalId).trim());
  return null;
}

/**
 * SPEC-3 section 4.6: THE ALTERNATE-NAME FALLBACKS ARE DELETED.
 *
 * The handlers used to read `paymentData.AMOUNT`, `.STATUS`, `.TXNID`,
 * `.MIHPAYID`, `udf_4` and `udf[4]` while `verifyHash` read the canonical
 * lowercase names only. That disagreement is a PARSER DIFFERENTIAL, and it was
 * safe purely by accident of direction: a payload lacking the lowercase form
 * hashed differently and was rejected before any fallback was consulted.
 *
 * The fallbacks were therefore dead code - but dead code that makes the
 * differential one edit away from being live. Someone reads SEC-14, decides the
 * input handling is brittle, makes `verifyHash` case-tolerant, and at that
 * moment a payload can VERIFY against one field and be PROCESSED from another.
 * That is a hash-verified authentication bypass assembled from two individually
 * reasonable changes.
 *
 * ADR-026 said the fix is to delete the fallbacks rather than widen the
 * verifier. Done here. The signed field names are the only field names.
 */
const signedDonationId = (d) => d.udf4;

/** Unsigned text, stored verbatim or not at all (ADR-021). Never our words. */
function payuErrorText(d) {
  return d.error_Message || d.error || null;
}

function payuFailureReason(d) {
  return d.field9 || null;
}

// =============================================================================
// POST /success
// =============================================================================
router.post('/success', async (req, res) => {
  try {
    const paymentData = req.body || {};

    if (!isWellFormedHash(paymentData.hash) || !verifyHash(paymentData)) {
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    // SEC-01 (1/4): a valid hash is not a successful payment. Refuse anything
    // whose SIGNED status is not a success - notably a genuine, correctly
    // signed failure or cancellation payload replayed at this endpoint.
    if (!isSuccessStatus(paymentData.status)) {
      console.warn('Success callback: refusing payload with signed status', paymentData.status);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=payment_not_successful`);
    }

    const donationId = signedDonationId(paymentData);
    if (!donationId) {
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
    }

    // SEC-01 (2/4): load before mutating, so the signed amount can be checked
    // against what we priced server-side.
    const donation = await resolveDonation(donationId);
    if (!donation) {
      console.error('Success callback: donation not found', donationId);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
    }

    // SEC-01 (3/4): idempotency. Checked here so an already-paid donation gets
    // the same success redirect it always did - and ENFORCED in the database by
    // `onlyIfNotPaid` below, because this read-then-write is exactly what
    // ADR-012 says cannot be relied upon under two concurrent callbacks.
    if (donation.paymentStatus === 'Paid') {
      return res.redirect(
        `${payuConfig.FRONTEND_SUCCESS_URL}?txnid=${encodeURIComponent(paymentData.txnid || '')}&amount=${encodeURIComponent(paymentData.amount || '')}&status=success`
      );
    }

    // SEC-01 (4/4): the signed amount must equal the server-priced amount, as
    // integer minor units. The stored side is ALREADY integer paise now, so
    // only the gateway's decimal string is converted - one conversion in the
    // comparison instead of two.
    const signedMinor = toMinorUnits(paymentData.amount);
    if (signedMinor === null || signedMinor !== donation.amountMinor) {
      console.error('Success callback: amount mismatch', {
        txnid: paymentData.txnid,
        donationId,
        signedMinor,
        expectedMinor: donation.amountMinor,
      });
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=amount_mismatch`);
    }

    const result = await donations.settlePayment(donation.id, {
      onlyIfNotPaid: true,
      status: 'Approved',
      paymentStatus: 'Paid',
      transactionRef: paymentData.txnid,
      mihpayid: paymentData.mihpayid || null,
      amountMinor: signedMinor,
      mode: paymentData.mode || null,
      bankRefNum: paymentData.bank_ref_num || null,
      // Verbatim. UNSIGNED data (ADR-026) recorded for observability only -
      // never read it for a state decision.
      gatewayStatus: paymentData.status,
      paidAt: new Date(),
    });

    if (!result.applied && result.reason === 'already-settled') {
      // A concurrent callback won. Not an error, and not something to overwrite.
      console.log('Success callback: already settled by a concurrent write', donationId);
    }

    res.redirect(
      `${payuConfig.FRONTEND_SUCCESS_URL}?txnid=${encodeURIComponent(paymentData.txnid || '')}&amount=${encodeURIComponent(paymentData.amount || '')}&status=${encodeURIComponent(paymentData.status || '')}`
    );
  } catch (error) {
    console.error('[payment] success handler error:', error && error.stack ? error.stack : error);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// =============================================================================
// POST /failure
// =============================================================================
router.post('/failure', async (req, res) => {
  try {
    const paymentData = req.body || {};

    if (!isWellFormedHash(paymentData.hash) || !verifyHash(paymentData)) {
      console.warn('Failure callback: hash mismatch from', req.ip);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    // SEC-01: refuse a signed SUCCESS payload here. The status must match the
    // endpoint in both directions, or a genuine success replayed at this URL
    // would mark a paid donation as Rejected/Failed.
    if (isSuccessStatus(paymentData.status)) {
      console.warn('Failure callback: refusing a signed success payload', paymentData.txnid);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=status_mismatch`);
    }

    const donationId = signedDonationId(paymentData);
    const errorMessage = payuErrorText(paymentData);
    const failureReason = payuFailureReason(paymentData);

    if (donationId) {
      const donation = await resolveDonation(donationId);
      if (!donation) {
        console.error('Failure callback: donation not found', donationId);
      } else {
        // ADR-012: a donation already Paid is TERMINAL. A late or replayed
        // failure must not walk it back, and `onlyIfNotPaid` is what makes that
        // true under concurrency rather than merely intended.
        await donations.settlePayment(donation.id, {
          onlyIfNotPaid: true,
          status: 'Rejected',
          paymentStatus: 'Failed',
          transactionRef: paymentData.txnid || undefined,
          failureReason: failureReason || errorMessage,
          errorMessage,
          mihpayid: paymentData.mihpayid || null,
          amountMinor: toMinorUnits(paymentData.amount),
          mode: paymentData.mode || null,
          bankRefNum: paymentData.bank_ref_num || null,
          gatewayStatus: paymentData.status,
          detailErrorMessage: errorMessage,
          paidAt: new Date(),
        });
      }
    }

    // The friendly fallback belongs HERE, at the display boundary - not in the
    // stored value. Storing it would contaminate PayU's vocabulary; omitting it
    // here would show the donor the string "null".
    res.redirect(
      `${payuConfig.FRONTEND_FAILURE_URL}?txnid=${encodeURIComponent(paymentData.txnid || 'N/A')}&error=${encodeURIComponent(errorMessage || 'Payment failed')}`
    );
  } catch (error) {
    console.error('[payment] failure handler error:', error && error.message ? error.message : error);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// =============================================================================
// POST /cancel
// =============================================================================
router.post('/cancel', async (req, res) => {
  try {
    const paymentData = req.body || {};

    if (!isWellFormedHash(paymentData.hash) || !verifyHash(paymentData)) {
      console.warn('Cancel callback: hash mismatch from', req.ip);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    if (isSuccessStatus(paymentData.status)) {
      console.warn('Cancel callback: refusing a signed success payload', paymentData.txnid);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=status_mismatch`);
    }

    const donationId = signedDonationId(paymentData);

    if (donationId) {
      const errorMessage = payuErrorText(paymentData);
      const failureReason = payuFailureReason(paymentData);
      const donation = await resolveDonation(donationId);

      if (!donation) {
        console.error('Cancel callback: donation not found', donationId);
      } else {
        await donations.settlePayment(donation.id, {
          onlyIfNotPaid: true,
          status: 'Pending',
          paymentStatus: 'Cancelled',
          transactionRef: paymentData.txnid || undefined,
          failureReason: failureReason || errorMessage,
          errorMessage,
          mihpayid: paymentData.mihpayid || null,
          amountMinor: toMinorUnits(paymentData.amount),
          mode: paymentData.mode || null,
          bankRefNum: paymentData.bank_ref_num || null,
          // Verbatim, no 'cancelled' fallback: per ADR-021 a real cancellation
          // arrives as status=failure, and inventing the word would erase that.
          gatewayStatus: paymentData.status,
          detailErrorMessage: errorMessage,
          paidAt: new Date(),
        });
      }
    }

    res.redirect(
      `${payuConfig.FRONTEND_FAILURE_URL}?txnid=${encodeURIComponent(paymentData.txnid || 'N/A')}&status=cancelled`
    );
  } catch (error) {
    console.error('[payment] cancel handler error:', error && error.message ? error.message : error);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// =============================================================================
// POST /webhook - called by PayU's servers, not the browser
// =============================================================================
router.post('/webhook', async (req, res) => {
  try {
    const paymentData = req.body || {};

    if (!isWellFormedHash(paymentData.hash) || !verifyHash(paymentData)) {
      console.error('Webhook hash verification failed');
      return refuse(res, 400, 'Invalid hash');
    }

    const donationId = signedDonationId(paymentData);
    if (!donationId) {
      return refuse(res, 400, 'Donation ID missing');
    }

    let paymentStatus = 'Pending';
    let donationStatus = 'Pending';
    switch (String(paymentData.status || '').toLowerCase()) {
      case 'success':
        paymentStatus = 'Paid';
        donationStatus = 'Approved';
        break;
      case 'failure':
        paymentStatus = 'Failed';
        donationStatus = 'Rejected';
        break;
      case 'cancelled':
      case 'cancel':
        paymentStatus = 'Cancelled';
        donationStatus = 'Pending';
        break;
      case 'pending':
      case 'in progress':
      default:
        paymentStatus = 'Pending';
        donationStatus = 'Pending';
    }

    const donation = await resolveDonation(donationId);
    if (!donation) {
      console.error('Webhook: donation not found', donationId);
      return refuse(res, 404, 'Donation not found');
    }

    const errorMessage = payuErrorText(paymentData);
    const failureReason = payuFailureReason(paymentData);

    const fields = {
      onlyIfNotPaid: true,
      status: donationStatus,
      paymentStatus,
      transactionRef: paymentData.txnid || undefined,
      mihpayid: paymentData.mihpayid || null,
      amountMinor: toMinorUnits(paymentData.amount),
      mode: paymentData.mode || null,
      bankRefNum: paymentData.bank_ref_num || null,
      gatewayStatus: paymentData.status,
      detailErrorMessage: errorMessage,
      paidAt: new Date(),
    };

    // ADR-021: PayU's words or nothing. The Mongoose version wrote our own
    // 'Payment failed' / 'Payment cancelled by user' into these columns when
    // the gateway said nothing, which made the stored value unable to answer
    // "what did PayU actually say?".
    if (paymentStatus === 'Failed' || paymentStatus === 'Cancelled') {
      fields.failureReason = failureReason || errorMessage;
      fields.errorMessage = errorMessage;
    }

    const result = await donations.settlePayment(donation.id, fields);

    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      donationId: donation.legacyId || donation.id,
      paymentStatus: result.applied ? paymentStatus : result.donation.paymentStatus,
    });
  } catch (error) {
    // SEC-19: `details: error.message` is gone. It handed the caller the store,
    // the driver and the column on any internal failure.
    return failed(res, 'Webhook processing failed', error, { tag: 'payment' });
  }
});

// =============================================================================
// GET /status/:txnid - the donor's receipt lookup
// =============================================================================
/**
 * SEC-06, closed in two moves, and PAY-02 repaired as a side effect.
 *
 * 1. THE REFERENCE IS NO LONGER GUESSABLE. `TXN${Date.now()}${rand(0,999)}`
 *    made the timestamp recoverable from the value, so the search space was a
 *    known millisecond window times one thousand. It is now 80 random bits.
 *
 * 2. THE RESPONSE IS A RECEIPT, NOT THE DONOR RECORD. It used to return the
 *    whole populated donation - donor name, EMAIL, PHONE, the linked user - to
 *    a caller with no credential at all. A receipt needs the amount, the
 *    category, the state and the date. The donor's own name is kept because it
 *    is what makes a receipt recognisable; their email, phone and account are
 *    not, and nobody needs them to confirm a payment went through.
 *
 * WHY NOT SIMPLY AUTHENTICATE IT: guest donations have no account, and
 * requiring a login to see a receipt would lock out exactly the donors who
 * cannot get one. The reference IS the capability; the fix is to make it
 * unguessable and to narrow what it grants.
 *
 * THE RESIDUAL, STATED: the reference still travels in a URL - every callback
 * redirects to `FRONTEND_SUCCESS_URL?txnid=...` - so it reaches browser
 * history, the `Referer` sent to third parties on the success page, and any
 * analytics there. Anyone holding it sees a receipt. That is inherent to a
 * capability URL and is now bounded by what the receipt contains.
 *
 * PAY-02: this handler used `.populate('userId')`, which threw
 * `Schema hasn't been registered for model "User"` on every request after AS7
 * removed the last Mongoose User import. There is no populate here at all.
 */
router.get('/status/:txnid', async (req, res) => {
  try {
    const donation = await donations.findByTransactionRef(String(req.params.txnid || '').trim());
    if (!donation) {
      return refuse(res, 404, 'Transaction not found');
    }

    res.json({
      success: true,
      donation: {
        _id: donation.legacyId || donation.id,
        donorName: donation.donorName,
        amount: donation.amountMinor / 100,
        currency: donation.currency,
        quantity: donation.quantity,
        item: donation.item,
        date: donation.donatedAt,
        transactionId: donation.transactionRef,
        status: donation.status,
        paymentStatus: donation.paymentStatus,
        category: donation.category
          ? { _id: donation.category.legacyId || donation.category.id, name: donation.category.name }
          : null,
        paymentDetails: donation.paymentDetails
          ? {
              // U-2's design half: what a reconciliation against PayU's
              // `verify_payment` API needs, and nothing else. `mihpayid` is the
              // gateway's own reference and `bank_ref_num` is the bank's; with
              // the amount and the date they are enough to match a payment
              // without the outbound call this phase does not make.
              mihpayid: donation.paymentDetails.mihpayid,
              bank_ref_num: donation.paymentDetails.bankRefNum,
              mode: donation.paymentDetails.mode,
              status: donation.paymentDetails.gatewayStatus,
              paymentDate: donation.paymentDetails.paidAt,
            }
          : null,
      },
      paymentStatus: donation.paymentStatus,
      status: donation.status,
    });
  } catch (error) {
    return failed(res, 'Failed to check payment status', error, { tag: 'payment' });
  }
});

module.exports = router;


