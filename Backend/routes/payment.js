const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const payuConfig = require('../config/payu');
const Donation = require('../models/Donation');
const Category = require('../models/Category');

// Helper function to generate PayU hash
function generateHash(data) {
  // Formula: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
  const hashString = `${payuConfig.MERCHANT_KEY}|${data.txnid}|${data.amount}|${data.productinfo}|${data.firstname}|${data.email}|${data.udf1 || ''}|${data.udf2 || ''}|${data.udf3 || ''}|${data.udf4 || ''}|${data.udf5 || ''}||||||${payuConfig.MERCHANT_SALT}`;
  return crypto.createHash("sha512").update(hashString).digest("hex");
}

// Helper function to verify response hash (timing-safe comparison)
function verifyHash(data) {
  // Response formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
  const hashString = `${payuConfig.MERCHANT_SALT}|${data.status}||||||${data.udf5 || ''}|${data.udf4 || ''}|${data.udf3 || ''}|${data.udf2 || ''}|${data.udf1 || ''}|${data.email}|${data.firstname}|${data.productinfo}|${data.amount}|${data.txnid}|${payuConfig.MERCHANT_KEY}`;
  const expected = crypto.createHash("sha512").update(hashString).digest("hex");
  const received = data.hash || '';
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
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
    const dbCategory = await Category.findById(category);
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

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    // Update donation status if donationId exists
    if (donationId) {
      console.log('Updating donation:', donationId);

      const updatedDonation = await Donation.findByIdAndUpdate(
        donationId,
        {
          status: 'Approved',
          paymentStatus: 'Paid',
          transactionId: paymentData.txnid || paymentData.TXNID,
          paymentDetails: {
            mihpayid: paymentData.mihpayid || paymentData.MIHPAYID,
            amount: paymentData.amount || paymentData.AMOUNT,
            mode: paymentData.mode || paymentData.MODE,
            bank_ref_num: paymentData.bank_ref_num || paymentData.BANK_REF_NUM,
            paymentDate: new Date()
          }
        },
        { new: true, runValidators: false }
      );

      if (updatedDonation) {
        console.log('✓ Donation successfully marked as paid:', donationId);
      } else {
        console.error('✗ Donation NOT FOUND in database:', donationId);
      }
    } else {
      console.error('✗ No donation ID found in payment data');
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

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    // Store exact error message from PayU as-is
    const errorMessage = paymentData.error_Message ||
                        paymentData.error ||
                        paymentData.Error_Message ||
                        paymentData.ERROR_MESSAGE ||
                        'Payment failed';

    const failureReason = paymentData.field9 ||
                         paymentData.field_9 ||
                         paymentData['field[9]'] ||
                         '';

    // Update donation status if donationId exists
    if (donationId) {
      const updateData = {
        status: 'Rejected',
        paymentStatus: 'Failed',
        transactionId: paymentData.txnid || paymentData.TXNID || 'N/A',
        failureReason: failureReason || errorMessage,
        errorMessage: errorMessage,
        paymentDetails: {
          mihpayid: paymentData.mihpayid || paymentData.MIHPAYID || null,
          amount: paymentData.amount || paymentData.AMOUNT || 0,
          mode: paymentData.mode || paymentData.MODE || null,
          bank_ref_num: paymentData.bank_ref_num || paymentData.BANK_REF_NUM || null,
          paymentDate: new Date(),
          status: paymentData.status || paymentData.STATUS || 'failure',
          error_Message: errorMessage
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
    res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?txnid=${encodeURIComponent(paymentData.txnid || 'N/A')}&error=${encodeURIComponent(errorMessage)}`);

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

    // Extract donation ID - try multiple possible field names
    const donationId = paymentData.udf4 || paymentData.udf_4 || paymentData['udf[4]'];

    // Update donation status if donationId exists
    if (donationId) {
      const errorMessage = paymentData.error_Message ||
                          paymentData.error ||
                          paymentData.Error_Message ||
                          paymentData.ERROR_MESSAGE ||
                          'Payment cancelled by user';

      const failureReason = paymentData.field9 ||
                           paymentData.field_9 ||
                           paymentData['field[9]'] ||
                           '';

      try {
        const updatedDonation = await Donation.findByIdAndUpdate(
          donationId,
          {
            status: 'Pending',
            paymentStatus: 'Cancelled',
            transactionId: paymentData.txnid || paymentData.TXNID || 'N/A',
            failureReason: failureReason || errorMessage,
            errorMessage: errorMessage,
            paymentDetails: {
              mihpayid: paymentData.mihpayid || paymentData.MIHPAYID || null,
              amount: paymentData.amount || paymentData.AMOUNT || 0,
              mode: paymentData.mode || paymentData.MODE || null,
              bank_ref_num: paymentData.bank_ref_num || paymentData.BANK_REF_NUM || null,
              paymentDate: new Date(),
              status: paymentData.status || paymentData.STATUS || 'cancelled',
              error_Message: errorMessage
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
    const updateData = {
      paymentStatus,
      status: donationStatus,
      transactionId: paymentData.txnid,
      paymentDetails: {
        mihpayid: paymentData.mihpayid,
        amount: paymentData.amount,
        mode: paymentData.mode,
        bank_ref_num: paymentData.bank_ref_num,
        paymentDate: new Date(),
        status: paymentData.status,
        error_Message: paymentData.error_Message || paymentData.error || null
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

      updateData.failureReason = failureReason || errorMessage; // Use failureReason from field9, fallback to errorMessage
      updateData.errorMessage = errorMessage; // Store the exact error message from PayU
      console.log('Payment failed. Error:', errorMessage, 'Reason:', failureReason);
    } else if (paymentStatus === 'Cancelled') {
      const cancelReason = paymentData.error_Message ||
                          paymentData.error ||
                          paymentData.Error_Message ||
                          paymentData.ERROR_MESSAGE ||
                          'Payment cancelled by user';

      updateData.failureReason = cancelReason;
      updateData.errorMessage = cancelReason;
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
    const donation = await Donation.findOne({ transactionId: txnid })
      .populate('category')
      .populate('userId', 'name email');

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

