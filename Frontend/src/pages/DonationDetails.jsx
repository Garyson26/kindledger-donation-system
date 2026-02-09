import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../config/constants';

function DonationDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [donation, setDonation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDonationDetails();
  }, [id]);

  const fetchDonationDetails = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE_URL}/api/donations/${id}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch donation details');
      }

      const data = await response.json();
      setDonation(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching donation:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const formatCurrency = (amount) => {
    if (!amount && amount !== 0) return '₹0.00';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR'
    }).format(amount);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status) => {
    const statusLower = status?.toLowerCase() || 'pending';
    let badgeClass = '';

    if (statusLower === 'approved') {
      badgeClass = 'bg-green-100 text-green-800 border-green-600';
    } else if (statusLower === 'rejected') {
      badgeClass = 'bg-red-100 text-red-800 border-red-600';
    } else {
      badgeClass = 'bg-yellow-100 text-yellow-800 border-yellow-600';
    }

    return (
      <span className={`px-3 py-1 rounded-full text-xs font-semibold border inline-block ${badgeClass}`}>
        {status?.charAt(0).toUpperCase() + status?.slice(1).toLowerCase() || 'Pending'}
      </span>
    );
  };

  const getPaymentStatusBadge = (status) => {
    const statusLower = status?.toLowerCase() || 'pending';
    let badgeClass = '';

    if (statusLower === 'paid') {
      badgeClass = 'bg-green-100 text-green-800 border-green-600';
    } else if (statusLower === 'failed') {
      badgeClass = 'bg-red-100 text-red-800 border-red-600';
    } else if (statusLower === 'cancelled') {
      badgeClass = 'bg-gray-100 text-gray-800 border-gray-600';
    } else {
      badgeClass = 'bg-yellow-100 text-yellow-800 border-yellow-600';
    }

    return (
      <span className={`px-3 py-1 rounded-full text-xs font-semibold border inline-block ${badgeClass}`}>
        {status?.charAt(0).toUpperCase() + status?.slice(1).toLowerCase() || 'Pending'}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-[#05699e] mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading donation details...</p>
        </div>
      </div>
    );
  }

  if (error || !donation) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Error</h2>
            <p className="text-gray-600 mb-6">{error || 'Donation not found'}</p>
            <button
              onClick={() => navigate(-1)}
              className="px-6 py-2 bg-[#05699e] text-white rounded-lg hover:bg-[#044d75] transition-colors"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 px-4 py-2 text-[#05699e] hover:bg-[#05699e]/10 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <h1 className="text-3xl font-bold text-gray-900">Donation Details</h1>
          <div className="w-20"></div> {/* Spacer for alignment */}
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          {/* Header Section */}
          <div className="bg-gradient-to-r from-[#05699e] to-[#044d75] text-white p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-2xl font-bold mb-2">{donation.category?.name || 'N/A'}</h2>
                <p className="text-blue-100 text-sm">
                  Donation ID: {donation._id}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-blue-100 mb-1">Total Amount</p>
                <p className="text-3xl font-bold">{formatCurrency(donation.amount)}</p>
              </div>
            </div>
            <div className="flex gap-3">
              {/*{getStatusBadge(donation.status)}*/}
              {getPaymentStatusBadge(donation.paymentStatus)}
            </div>
          </div>

          {/* Details Grid */}
          <div className="p-6 space-y-6">
            {/* Donor Information */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Donor Information
              </h3>
              <div className="bg-gray-50 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500 mb-1">Name</p>
                  <p className="text-gray-900 font-medium">{donation.donorName || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-1">Email</p>
                  <p className="text-gray-900 font-medium">{donation.donorEmail || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-1">Phone</p>
                  <p className="text-gray-900 font-medium">{donation.donorPhone || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-1">User Type</p>
                  <p className="text-gray-900 font-medium">
                    {donation.userId ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                        Registered User
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2 h-2 bg-gray-400 rounded-full"></span>
                        Guest User
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Amount Breakdown */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Amount Breakdown
              </h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <div className="flex justify-between items-center pb-3 border-b border-gray-200">
                  <span className="text-gray-600">Base Amount</span>
                  <span className="font-semibold text-gray-900">{formatCurrency(donation.baseAmount || 0)}</span>
                </div>
                <div className="flex justify-between items-center pb-3 border-b border-gray-200">
                  <span className="text-gray-600">Extra Amount</span>
                  <span className="font-semibold text-gray-900">{formatCurrency(donation.extraAmount || 0)}</span>
                </div>
                <div className="flex justify-between items-center pt-2">
                  <span className="text-lg font-semibold text-gray-900">Total Amount</span>
                  <span className="text-xl font-bold text-[#05699e]">{formatCurrency(donation.amount)}</span>
                </div>
              </div>
            </div>

            {/* Payment Information */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                Payment Information
              </h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-500 mb-1">Payment Status</p>
                    <div>{getPaymentStatusBadge(donation.paymentStatus)}</div>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 mb-1">Transaction ID</p>
                    <p className="text-gray-900 font-mono text-sm">
                      {donation.transactionId || 'N/A'}
                    </p>
                  </div>
                </div>

                {/* Payment Details */}
                {donation.paymentDetails && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <p className="text-sm font-semibold text-gray-700 mb-3">Transaction Details</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {donation.paymentDetails.mihpayid && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">PayU Payment ID</p>
                          <p className="text-gray-900 text-sm font-mono">{donation.paymentDetails.mihpayid}</p>
                        </div>
                      )}
                      {donation.paymentDetails.mode && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Payment Mode</p>
                          <p className="text-gray-900 text-sm font-medium uppercase">{donation.paymentDetails.mode}</p>
                        </div>
                      )}
                      {donation.paymentDetails.bank_ref_num && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Bank Reference Number</p>
                          <p className="text-gray-900 text-sm font-mono">{donation.paymentDetails.bank_ref_num}</p>
                        </div>
                      )}
                      {donation.paymentDetails.paymentDate && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Payment Date</p>
                          <p className="text-gray-900 text-sm">{formatDate(donation.paymentDetails.paymentDate)}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Failure Reason */}
                {(donation.paymentStatus === 'Failed' || donation.paymentStatus === 'Cancelled') && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    {donation.failureReason && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold text-red-700 mb-1 flex items-center gap-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Failure Reason
                        </p>
                        <p className="text-gray-900 text-sm bg-red-50 p-3 rounded border border-red-200">
                          {donation.failureReason}
                        </p>
                      </div>
                    )}
                    {donation.errorMessage && donation.errorMessage !== donation.failureReason && (
                      <div>
                        <p className="text-sm font-semibold text-red-700 mb-1 flex items-center gap-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                          Error Message
                        </p>
                        <p className="text-gray-900 text-sm bg-red-50 p-3 rounded border border-red-200">
                          {donation.errorMessage}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Category & Date Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                  Category
                </h3>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-900 font-semibold mb-1">{donation.category?.name || 'N/A'}</p>
                  {donation.category?.description && (
                    <p className="text-sm text-gray-600">{donation.category.description}</p>
                  )}
                  {donation.category?.price && (
                    <p className="text-sm text-gray-600 mt-2">
                      Base Price: {formatCurrency(donation.category.price)}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Date Information
                </h3>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500 mb-1">Donation Date</p>
                  <p className="text-gray-900 font-medium">{formatDate(donation.date)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DonationDetails;

