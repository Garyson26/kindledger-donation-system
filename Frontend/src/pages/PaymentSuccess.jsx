import { useBranding } from "../branding/BrandingProvider";
import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { paymentAPI } from "../utils/api";
import { generateDonationReceipt } from "../utils/pdfGenerator";

function PaymentSuccess() {
  const { organisationName } = useBranding();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [paymentInfo, setPaymentInfo] = useState(null);

  const txnid = searchParams.get('txnid');
  const amount = searchParams.get('amount');
  const status = searchParams.get('status');

  useEffect(() => {
    if (txnid) {
      // Fetch payment details
      paymentAPI.checkStatus(txnid).then(({ data, ok }) => {
        if (ok) {
          setPaymentInfo(data);
        }
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, [txnid]);

  const handleContinue = () => {
    const token = localStorage.getItem("token");
    if (token) {
      navigate("/my-donations");
    } else {
      navigate("/categories");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        {/* Success Card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-green-600 to-emerald-600 p-8 text-center">
            <div className="flex justify-center mb-4">
              <div className="bg-white rounded-full p-4">
                <svg className="w-16 h-16 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Payment Successful!</h1>
            <p className="text-green-100 text-lg">Thank you for your generous donation</p>
          </div>

          {/* Details */}
          <div className="p-8">
            <div className="space-y-4 mb-6">
              {amount && (
                <div className="flex justify-between items-center py-3 border-b border-gray-200">
                  <span className="text-gray-600 font-medium">Amount Paid</span>
                  <span className="text-2xl font-bold text-green-600">₹{parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              {txnid && (
                <div className="flex justify-between items-center py-3 border-b border-gray-200">
                  <span className="text-gray-600 font-medium">Transaction ID</span>
                  <span className="text-gray-900 font-mono text-sm">{txnid}</span>
                </div>
              )}
              {status && (
                <div className="flex justify-between items-center py-3 border-b border-gray-200">
                  <span className="text-gray-600 font-medium">Status</span>
                  <span className="bg-green-100 text-green-800 px-4 py-1 rounded-full font-semibold">
                    {status}
                  </span>
                </div>
              )}
              {paymentInfo?.donation && (
                <>
                  <div className="flex justify-between items-center py-3 border-b border-gray-200">
                    <span className="text-gray-600 font-medium">Item</span>
                    <span className="text-gray-900">{paymentInfo.donation.item}</span>
                  </div>
                  <div className="flex justify-between items-center py-3 border-b border-gray-200">
                    <span className="text-gray-600 font-medium">Quantity</span>
                    <span className="text-gray-900">{paymentInfo.donation.quantity}</span>
                  </div>
                </>
              )}
            </div>

            {/* Success Message */}
            <div className="bg-green-50 border-l-4 border-green-500 p-4 mb-6">
              <div className="flex">
                <svg className="w-5 h-5 text-green-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-green-800 font-medium">
                    Your donation has been received and will be processed shortly.
                  </p>
                  <p className="text-green-700 text-sm mt-1">
                    A confirmation email has been sent to your registered email address.
                  </p>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-4">
              {/* Download Receipt Button */}
              {paymentInfo?.donation && (
                <button
                  onClick={() => generateDonationReceipt(paymentInfo.donation, organisationName)}
                  className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white font-bold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download Receipt PDFs
                </button>
              )}

              <div className="flex gap-4">
                <button
                  onClick={handleContinue}
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-bold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105"
                >
                  {localStorage.getItem("token") ? "View My Donations" : "Back to Categories"}
                </button>
                <button
                  onClick={() => navigate("/")}
                  className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-3 px-6 rounded-lg transition-colors"
                >
                  Go to Home
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Additional Info */}
        <div className="mt-6 text-center text-gray-600">
          <p className="text-sm">
            Need help? Contact us at <a href="mailto:support@donation.com" className="text-green-600 hover:text-green-700 font-semibold">support@donation.com</a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default PaymentSuccess;

