import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { donationsAPI, categoriesAPI } from "../utils/api";
import { generateDonationReceipt } from "../utils/pdfGenerator";

function MyDonations({ userId }) {
  const navigate = useNavigate();
  const [donations, setDonations] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [totalDonations, setTotalDonations] = useState(0);

  // Filter states
  const [filters, setFilters] = useState({
    category: 'all',
    dateFrom: '',
    dateTo: ''
  });

  // Fetch categories for filter dropdown
  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const { data, ok } = await categoriesAPI.getAll();
        if (ok && data) {
          setCategories(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        console.error("Error fetching categories:", err);
      }
    };
    fetchCategories();
  }, []);

  useEffect(() => {
    if (!userId) return;

    const token = localStorage.getItem("token");
    if (!token) {
      setDonations([]);
      setError("Not authenticated. Please log in.");
      return;
    }

    fetchDonations();
  }, [userId, currentPage, filters]);

  const fetchDonations = async () => {
    setLoading(true);
    setError(null);
    try {
      // Build query params
      const params = new URLSearchParams({
        page: currentPage,
        limit: itemsPerPage
      });

      if (filters.category && filters.category !== 'all') {
        params.append('category', filters.category);
      }
      if (filters.dateFrom) {
        params.append('dateFrom', filters.dateFrom);
      }
      if (filters.dateTo) {
        params.append('dateTo', filters.dateTo);
      }

      const { data, error, ok } = await donationsAPI.getByUser(userId, params.toString());

      if (!ok) {
        throw new Error(error || "Error fetching donations");
      }

      // Handle the new response format with pagination
      if (data.donations && data.pagination) {
        setDonations(Array.isArray(data.donations) ? data.donations : []);
        setTotalPages(data.pagination.pages);
        setTotalDonations(data.pagination.total);
      } else {
        // Fallback for old format
        const donationsArray = Array.isArray(data) ? data : [];
        setDonations(donationsArray);
        setTotalDonations(donationsArray.length);
        setTotalPages(Math.ceil(donationsArray.length / itemsPerPage));
      }
    } catch (err) {
      console.error("Error fetching donations:", err);
      setError(err.message || "Error fetching donations");
      setDonations([]);
      setTotalDonations(0);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (name, value) => {
    setFilters(prev => ({
      ...prev,
      [name]: value
    }));
    setCurrentPage(1); // Reset to first page when filter changes
  };

  const handleResetFilters = () => {
    setFilters({
      category: 'all',
      dateFrom: '',
      dateTo: ''
    });
    setCurrentPage(1);
  };

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">My Donations</h1>
          <p className="text-gray-600">Track and manage your donation requests</p>
        </div>

        {/* Filters Section */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6 border border-gray-200">
          <div className="flex items-center gap-3 mb-4">
            <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900">Filters</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Category Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Category
              </label>
              <select
                value={filters.category}
                onChange={(e) => handleFilterChange('category', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#05699e] focus:border-transparent outline-none transition-all duration-200"
              >
                <option value="all">All Categories</option>
                {categories.map(cat => (
                  <option key={cat._id} value={cat._id}>{cat.name}</option>
                ))}
              </select>
            </div>

            {/* Date From Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                From Date
              </label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#05699e] focus:border-transparent outline-none transition-all duration-200"
              />
            </div>

            {/* Date To Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                To Date
              </label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => handleFilterChange('dateTo', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#05699e] focus:border-transparent outline-none transition-all duration-200"
              />
            </div>
          </div>

          {/* Reset Button */}
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleResetFilters}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors duration-200"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Reset Filters
            </button>
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading your donations...</p>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center border border-red-200">
            <div className="text-6xl mb-4">⚠️</div>
            <p className="text-red-600 font-medium">{error}</p>
          </div>
        )}

        {/* Content */}
        {!loading && !error && (
          <div>
            {donations.length === 0 ? (
              <div className="bg-white rounded-lg shadow-sm p-12 text-center">
                <div className="text-6xl mb-4">📦</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">No donations yet</h3>
                <p className="text-gray-600 mb-6">You haven't made any donations. Start by making your first donation!</p>
                <a
                  href="/donate"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
                >
                  Make a Donation
                </a>
              </div>
            ) : (
              <>
                {/* Summary */}
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-gray-600">
                    You have made <strong className="text-gray-900">{totalDonations}</strong> donation{totalDonations !== 1 ? 's' : ''}
                    {(filters.category !== 'all' || filters.dateFrom || filters.dateTo) && (
                      <span className="text-sm text-[#05699e] ml-2">(filtered)</span>
                    )}
                  </div>
                  {totalDonations > 0 && (
                    <div className="text-sm text-gray-500">
                      Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, totalDonations)} of {totalDonations}
                    </div>
                  )}
                </div>

                {/* Table */}
                <div className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-200">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Base Amount</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Extra Amount</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Amount</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Payment</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Transaction ID</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {donations.map((donation, index) => (
                          <tr
                            key={donation._id}
                            className={`${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-gray-100 transition-colors duration-150`}
                          >
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {(currentPage - 1) * itemsPerPage + index + 1}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {donation.category?.name || 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {donation.item || donation.category?.name || 'Donation'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-center text-gray-900">
                              {donation.quantity}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-blue-600">
                              {donation.baseAmount ? `₹${parseFloat(donation.baseAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-purple-600">
                              {donation.extraAmount ? `₹${parseFloat(donation.extraAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '₹0.00'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-bold text-green-600">
                              {donation.amount ? `₹${parseFloat(donation.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              {donation.paymentStatus && (
                                <span className={`px-3 py-1 rounded-full text-xs font-semibold border inline-block ${
                                  donation.paymentStatus === 'Paid' 
                                    ? 'bg-green-100 text-green-800 border-green-600' 
                                    : donation.paymentStatus === 'Failed' 
                                    ? 'bg-red-100 text-red-800 border-red-600' 
                                    : 'bg-yellow-100 text-yellow-800 border-yellow-600'
                                }`}>
                                  {donation.paymentStatus}
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 font-mono">
                              {donation.transactionId ? (
                                <span title={donation.transactionId}>
                                  {donation.transactionId.length > 15 ? `${donation.transactionId.substring(0, 15)}...` : donation.transactionId}
                                </span>
                              ) : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {new Date(donation.date).toLocaleDateString('en-IN', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric'
                              })}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              <div className="flex gap-2 justify-center">
                                <button
                                  onClick={() => navigate(`/my-donations/${donation._id}`)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#05699e] hover:bg-[#044d75] text-white text-sm font-medium rounded-lg transition-colors duration-200"
                                  title="View Details"
                                >
                                  👁️ View
                                </button>
                                <button
                                  onClick={() => generateDonationReceipt(donation)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium rounded-lg transition-colors duration-200"
                                  title="Download Receipt PDF"
                                >
                                  📄 Receipt
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex justify-center items-center gap-2.5 mt-6 p-4">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                      disabled={currentPage === 1}
                      className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${
                        currentPage === 1
                          ? 'bg-gray-200 text-gray-600 cursor-not-allowed'
                          : 'bg-[#05699e] text-white hover:bg-[#044d73] cursor-pointer'
                      }`}
                    >
                      ← Previous
                    </button>

                    <div className="flex gap-1.5">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`px-3 py-2 rounded-lg font-medium min-w-[40px] transition-all duration-200 ${
                            currentPage === page
                              ? 'bg-[#05699e] text-white font-bold'
                              : 'bg-white text-[#05699e] border border-[#05699e] hover:bg-[#05699e]/10'
                          }`}
                        >
                          {page}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                      disabled={currentPage === totalPages}
                      className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${
                        currentPage === totalPages
                          ? 'bg-gray-200 text-gray-600 cursor-not-allowed'
                          : 'bg-[#05699e] text-white hover:bg-[#044d73] cursor-pointer'
                      }`}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MyDonations;
