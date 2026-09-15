const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const payuConfig = require('../config/payu');
const Donation = require('../models/Donation');
// models/Category IS DELIBERATELY NOT IMPORTED (AS2). Package 3.1 replaced
// every use in this file with services/categoryBridge and left the import
// behind; it was dead, and a dead Mongoose import is the seed of the next
// crossing - the next person editing this file has `Category` in scope.
// Found by test/migration-state.test.js, which the AR1 audit could not have
// found because that audit enumerated CALL SITES and a dead import has none.
// TEMPORARY (ADR-050, deleted in package 3.6). `Category` now lives in MySQL;
// this file is not migrated until a later package, so category reads go through
// the bridge, which tries MySQL first and falls back to MongoDB with a warning.
const categoryBridge = require('../services/categoryBridge');


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
router.post('/initiate', async (req, res) => {
  try {
    const {
      firstname,
      email,
      phone,
      productinfo,
      category,
      item,
      quantity,
      extraAmount,
      userId // Optional - will be present if user is logged in
    } = req.body;

    // Validation
    if (!firstname || !email) {
      return res.status(400).json({
        error: 'Firstname and email are required'
      });
    }

    if (!category) {
      return res.status(400).json({
        error: 'Category is required'
      });
    }

    // Server-side amount calculation — never trust client-supplied amount (BE-CRIT-01)
    //
    // Via the bridge (ADR-050): categories moved to MySQL in package 3.1 and
    // this file does not migrate until 3.5. resolveCategory NEVER THROWS on a
    // malformed id - the previous Category.findById raised a CastError, so a
    // junk category id produced a 500 here rather than the 400 below. That is
    // the SEC-14 shape on the pricing path.
    const dbCategory = await categoryBridge.resolveCategory(category);
    if (!dbCategory) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const extra = Math.max(0, Math.min(1_000_000, parseFloat(extraAmount) || 0));
    const baseAmt = dbCategory.donationAmount * qty;
    const totalAmt = +(baseAmt + extra).toFixed(2);

    // Generate unique transaction ID
    const txnid = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // Create donation record in database
    const newDonation = new Donation({
      donorName: firstname,
      donorEmail: email,
      donorPhone: phone || '',
      userId: userId || null, // Will be null for guest users
      item: item || productinfo || 'Donation',
      category: category,
      quantity: qty,
      amount: totalAmt,
      baseAmount: baseAmt,
      extraAmount: extra,
      status: 'Pending',
      paymentStatus: 'Pending',
      transactionId: txnid
    });

    const savedDonation = await newDonation.save();

    // Prepare payment data
    const paymentData = {
      key: payuConfig.MERCHANT_KEY,
      txnid: txnid,
      amount: totalAmt.toFixed(2),
      productinfo: productinfo || 'Donation',
      firstname: firstname,
      email: email,
      phone: phone || '9999999999',
      surl: payuConfig.SUCCESS_URL,
      furl: payuConfig.FAILURE_URL,
      curl: payuConfig.CANCEL_URL,
      notify_url: payuConfig.NOTIFY_URL, // Webhook for automatic status updates
      // UDF fields for custom data
      udf1: category || '',
      udf2: item || '',
      udf3: qty.toString(),
      udf4: savedDonation._id.toString(), // Use the saved donation ID
      udf5: userId || '' // Store userId for reference
    };

    // Generate hash
    paymentData.hash = generateHash(paymentData);

    // Return payment data and PayU URL
    res.json({
      success: true,
      paymentData,
      payuUrl: `${payuConfig.PAYU_BASE_URL}/_payment`,
      donationId: savedDonation._id,
      message: 'Payment initiated successfully'
    });

  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({
      error: 'Failed to initiate payment'
    });
  }
});

// Payment Success Callback
router.post('/success', async (req, res) => {
  try {
    const paymentData = req.body;

    console.log('========================================');
    console.log('Payment Success Callback - Full Request Body:', JSON.stringify(paymentData, null, 2));
    console.log('========================================');

    // Verify hash
    if (!verifyHash(paymentData)) {
      console.error('✗ Hash verification failed');
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    console.log('✓ Hash verified successfully');

    // SEC-01 (1/4): a valid hash is not a successful payment. Refuse anything
    // whose SIGNED status is not a success - notably a genuine, correctly
    // signed failure or cancellation payload replayed at this endpoint.
    if (!isSuccessStatus(paymentData.status)) {
      console.warn('Success callback: refusing payload with signed status', paymentData.status);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=payment_not_successful`);
    }

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    if (!donationId) {
      console.error('✗ No donation ID found in payment data');
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
    }

    // SEC-01 (2/4): load the donation before mutating it, so the signed
    // amount can be checked against what we priced server-side.
    const donation = await Donation.findById(donationId);
    if (!donation) {
      console.error('✗ Donation NOT FOUND in database:', donationId);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
    }

    // SEC-01 (3/4): idempotency. A donation already marked Paid is not
    // rewritten - a replayed genuine success must not overwrite the original
    // payment metadata or move paymentDate forward.
    if (donation.paymentStatus === 'Paid') {
      console.log('Success callback: donation already Paid, no-op:', donationId);
      return res.redirect(
        `${payuConfig.FRONTEND_SUCCESS_URL}?txnid=${encodeURIComponent(paymentData.txnid || '')}&amount=${encodeURIComponent(paymentData.amount || '')}&status=success`
      );
    }

    // SEC-01 (4/4): the signed amount must equal the server-priced amount,
    // compared as integer minor units.
    const signedMinor = toMinorUnits(paymentData.amount || paymentData.AMOUNT);
    const expectedMinor = toMinorUnits(donation.amount);
    if (signedMinor === null || expectedMinor === null || signedMinor !== expectedMinor) {
      console.error('✗ Amount mismatch', {
        txnid: paymentData.txnid,
        donationId,
        signedMinor,
        expectedMinor
      });
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=amount_mismatch`);
    }

    console.log('Updating donation:', donationId);

    // Field-level $set, NOT a whole-subdocument assignment (ADR-024 item 2).
    //
    // Assigning `paymentDetails: {...}` makes Mongoose REPLACE the entire
    // subdocument. Since /webhook also writes paymentDetails - including
    // `status` and `error_Message` - and the two callbacks race with no
    // ordering guarantee (ADR-012), a /success arriving second used to wipe
    // whatever the webhook had recorded. Dotted paths merge instead.
    //
    // `status` is now written verbatim from the payload rather than omitted, so
    // the system can be asked what PayU actually sends. It is UNSIGNED data
    // (ADR-026) recorded for observability only - never read it for a state
    // decision.
    const updatedDonation = await Donation.findByIdAndUpdate(
      donationId,
      {
        $set: {
          status: 'Approved',
          paymentStatus: 'Paid',
          transactionId: paymentData.txnid || paymentData.TXNID,
          'paymentDetails.mihpayid': paymentData.mihpayid || paymentData.MIHPAYID,
          'paymentDetails.amount': paymentData.amount || paymentData.AMOUNT,
          'paymentDetails.mode': paymentData.mode || paymentData.MODE,
          'paymentDetails.bank_ref_num': paymentData.bank_ref_num || paymentData.BANK_REF_NUM,
          'paymentDetails.status': paymentData.status,
          'paymentDetails.paymentDate': new Date()
        }
      },
      { new: true, runValidators: false }
    );

    if (updatedDonation) {
      console.log('✓ Donation successfully marked as paid:', donationId);
    } else {
      console.error('✗ Donation disappeared mid-request:', donationId);
    }

    // Redirect to frontend success page
    res.redirect(`${payuConfig.FRONTEND_SUCCESS_URL}?txnid=${encodeURIComponent(paymentData.txnid || '')}&amount=${encodeURIComponent(paymentData.amount || '')}&status=${encodeURIComponent(paymentData.status || '')}`);

  } catch (error) {
    console.error('Payment success handler error:', error);
    console.error('Error stack:', error.stack);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// Payment Failure Callback
router.post('/failure', async (req, res) => {
  try {
    const paymentData = req.body;

    // Verify hash before mutating any state (BE-CRIT-03)
    if (!verifyHash(paymentData)) {
      console.warn('Failure callback: hash mismatch from', req.ip);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    // SEC-01: refuse a signed SUCCESS payload here. The status must match the
    // endpoint in both directions, otherwise a genuine success replayed at
    // this URL would mark a paid donation as Rejected/Failed.
    if (isSuccessStatus(paymentData.status)) {
      console.warn('Failure callback: refusing a signed success payload', paymentData.txnid);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=status_mismatch`);
    }

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    // Store exactly what PayU sent, or nothing. The previous `|| 'Payment
    // failed'` fallback wrote OUR string into a field meant to hold PayU's,
    // making the two indistinguishable in the data - so the stored value could
    // never answer "what did PayU actually say?" (ADR-021).
    const errorMessage = paymentData.error_Message ||
                        paymentData.error ||
                        paymentData.Error_Message ||
                        paymentData.ERROR_MESSAGE ||
                        null;

    const failureReason = paymentData.field9 ||
                         paymentData.field_9 ||
                         paymentData['field[9]'] ||
                         null;

    // Update donation status if donationId exists
    if (donationId) {
      // Field-level $set so a concurrent /webhook write is merged rather than
      // clobbered (ADR-024 item 2).
      const updateData = {
        $set: {
          status: 'Rejected',
          paymentStatus: 'Failed',
          transactionId: paymentData.txnid || paymentData.TXNID || 'N/A',
          failureReason: failureReason || errorMessage,
          errorMessage: errorMessage,
          'paymentDetails.mihpayid': paymentData.mihpayid || paymentData.MIHPAYID || null,
          'paymentDetails.amount': paymentData.amount || paymentData.AMOUNT || 0,
          'paymentDetails.mode': paymentData.mode || paymentData.MODE || null,
          'paymentDetails.bank_ref_num': paymentData.bank_ref_num || paymentData.BANK_REF_NUM || null,
          'paymentDetails.paymentDate': new Date(),
          // Verbatim, no 'failure' fallback. This is PayU's vocabulary.
          'paymentDetails.status': paymentData.status,
          'paymentDetails.error_Message': errorMessage
        }
      };

      try {
        const updatedDonation = await Donation.findByIdAndUpdate(
          donationId,
          updateData,
          { new: true }
        );

        if (!updatedDonation) {
          console.error('Failure callback: donation not found', donationId);
        }
      } catch (updateError) {
        console.error('Failure callback: DB update error', updateError.message);
      }
    }

    // Redirect to frontend failure page
    // The friendly fallback belongs HERE, at the display boundary - not in the
    // stored value. Storing it would contaminate PayU's vocabulary; omitting it
    // here would show the donor the string "null".
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?txnid=${encodeURIComponent(paymentData.txnid || 'N/A')}&error=${encodeURIComponent(errorMessage || 'Payment failed')}`);

  } catch (error) {
    console.error('Payment failure handler error:', error);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// Payment Cancel Callback
router.post('/cancel', async (req, res) => {
  try {
    const paymentData = req.body;

    // Verify hash before mutating any state (BE-CRIT-03)
    if (!verifyHash(paymentData)) {
      console.warn('Cancel callback: hash mismatch from', req.ip);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }

    // SEC-01: refuse a signed SUCCESS payload here, for the same reason as
    // /failure - a paid donation must not be walked back to Cancelled.
    if (isSuccessStatus(paymentData.status)) {
      console.warn('Cancel callback: refusing a signed success payload', paymentData.txnid);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=status_mismatch`);
    }

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    // Update donation status if donationId exists
    if (donationId) {
      // Store exactly what PayU sent, or nothing. The previous
      // `|| 'Payment cancelled by user'` fallback wrote our own string into a
      // field meant to hold PayU's (ADR-021).
      const errorMessage = paymentData.error_Message ||
                          paymentData.error ||
                          paymentData.Error_Message ||
                          paymentData.ERROR_MESSAGE ||
                          null;

      const failureReason = paymentData.field9 ||
                           paymentData.field_9 ||
                           paymentData['field[9]'] ||
                           null;

      try {
        // Field-level $set so a concurrent /webhook write is merged rather
        // than clobbered (ADR-024 item 2).
        const updatedDonation = await Donation.findByIdAndUpdate(
          donationId,
          {
            $set: {
              status: 'Pending',
              paymentStatus: 'Cancelled',
              transactionId: paymentData.txnid || paymentData.TXNID || 'N/A',
              failureReason: failureReason || errorMessage,
              errorMessage: errorMessage,
              'paymentDetails.mihpayid': paymentData.mihpayid || paymentData.MIHPAYID || null,
              'paymentDetails.amount': paymentData.amount || paymentData.AMOUNT || 0,
              'paymentDetails.mode': paymentData.mode || paymentData.MODE || null,
              'paymentDetails.bank_ref_num': paymentData.bank_ref_num || paymentData.BANK_REF_NUM || null,
              'paymentDetails.paymentDate': new Date(),
              // Verbatim, no 'cancelled' fallback. This is PayU's vocabulary,
              // and per ADR-021 a real cancellation arrives as status=failure.
              'paymentDetails.status': paymentData.status,
              'paymentDetails.error_Message': errorMessage
            }
          },
          { new: true }
        );

        if (!updatedDonation) {
          console.error('Cancel callback: donation not found', donationId);
        }
      } catch (updateError) {
        console.error('Cancel callback: DB update error', updateError.message);
      }
    }

    // Redirect to frontend
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?txnid=${encodeURIComponent(paymentData.txnid || 'N/A')}&status=cancelled`);

  } catch (error) {
    console.error('Payment cancel handler error:', error);
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=processing_error`);
  }
});

// PayU Webhook/Notify URL - This is called by PayU automatically
router.post('/webhook', async (req, res) => {
  try {
    const paymentData = req.body;

    console.log('PayU Webhook received:', paymentData);

    // Verify hash for security
    const isValid = verifyHash(paymentData);

    if (!isValid) {
      console.error('Webhook hash verification failed');
      return res.status(400).json({ error: 'Invalid hash' });
    }

    // Extract donation ID from udf4
    const donationId = paymentData.udf4;

    if (!donationId) {
      console.error('Donation ID not found in webhook data');
      return res.status(400).json({ error: 'Donation ID missing' });
    }

    // Determine status based on PayU response
    let paymentStatus = 'Pending';
    let donationStatus = 'Pending';

    switch (paymentData.status?.toLowerCase()) {
      case 'success':
        paymentStatus = 'Paid';
        donationStatus = 'Approved';
        break;
      case 'failure':
        paymentStatus = 'Failed';
        donationStatus = 'Rejected';
        break;
      case 'pending':
      case 'in progress':
        paymentStatus = 'Pending';
        donationStatus = 'Pending';
        break;
      case 'cancelled':
      case 'cancel':
        paymentStatus = 'Cancelled';
        donationStatus = 'Pending';
        break;
      default:
        paymentStatus = 'Pending';
        donationStatus = 'Pending';
    }

    // Prepare update data
    // Field-level $set here too. Fixing only /success would leave the reverse
    // ordering lossy: a webhook arriving second would replace the subdocument
    // and drop whatever /success had written. Both writers must merge for the
    // race to be harmless (ADR-024 item 2).
    const updateData = {
      $set: {
        paymentStatus,
        status: donationStatus,
        transactionId: paymentData.txnid,
        'paymentDetails.mihpayid': paymentData.mihpayid,
        'paymentDetails.amount': paymentData.amount,
        'paymentDetails.mode': paymentData.mode,
        'paymentDetails.bank_ref_num': paymentData.bank_ref_num,
        'paymentDetails.paymentDate': new Date(),
        'paymentDetails.status': paymentData.status,
        'paymentDetails.error_Message': paymentData.error_Message || paymentData.error || null
      }
    };

    // Store exact error message from PayU as-is
    if (paymentStatus === 'Failed') {
      const errorMessage = paymentData.error_Message ||
                          paymentData.error ||
                          paymentData.Error_Message ||
                          paymentData.ERROR_MESSAGE ||
                          'Payment failed';

      const failureReason = paymentData.field9 ||
                           paymentData.field_9 ||
                           paymentData['field[9]'] ||
                           '';

      // Must target $set: an update document may not mix operator and
      // non-operator keys - MongoDB rejects the whole update.
      updateData.$set.failureReason = failureReason || errorMessage;
      updateData.$set.errorMessage = errorMessage;
      console.log('Payment failed. Error:', errorMessage, 'Reason:', failureReason);
    } else if (paymentStatus === 'Cancelled') {
      const cancelReason = paymentData.error_Message ||
                          paymentData.error ||
                          paymentData.Error_Message ||
                          paymentData.ERROR_MESSAGE ||
                          'Payment cancelled by user';

      updateData.$set.failureReason = cancelReason;
      updateData.$set.errorMessage = cancelReason;
      console.log('Payment cancelled. Reason:', cancelReason);
    }

    // Update donation in database
    const updatedDonation = await Donation.findByIdAndUpdate(
      donationId,
      updateData,
      { new: true }
    );

    if (!updatedDonation) {
      console.error('Donation not found:', donationId);
      return res.status(404).json({ error: 'Donation not found' });
    }

    console.log('Donation updated via webhook:', updatedDonation._id, 'Status:', paymentStatus);

    // Respond to PayU
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      donationId: updatedDonation._id,
      paymentStatus
    });

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({
      error: 'Webhook processing failed',
      details: error.message
    });
  }
});

// Check Payment Status
router.get('/status/:txnid', async (req, res) => {
  try {
    const { txnid } = req.params;

    // Find donation by transaction ID
    const donationDoc = await Donation.findOne({ transactionId: txnid })
      .populate('userId', 'name email');
    // populate('category') removed: a category created after package 3.1 has no
    // MongoDB row, so populate would resolve it to null and the receipt would
    // show no category at all.
    const donation = donationDoc ? await categoryBridge.attachCategories(donationDoc) : null;

    if (!donation) {
      return res.status(404).json({
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      donation,
      paymentStatus: donation.paymentStatus,
      status: donation.status
    });

  } catch (error) {
    console.error('Payment status check error:', error);
    res.status(500).json({
      error: 'Failed to check payment status',
      details: error.message
    });
  }
});

module.exports = router;

