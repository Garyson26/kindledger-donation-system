import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateDonationReceipt, generateUserDonationReport } from "../utils/pdfGenerator";
import { API_BASE_URL } from "../config/constants";

function DonationsPage() {
  const navigate = useNavigate();
  const [donations, setDonations] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [totalDonations, setTotalDonations] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('all'); // 'all' or 'user-wise'
  const [expandedUsers, setExpandedUsers] = useState(new Set());
  const [userWiseCurrentPage, setUserWiseCurrentPage] = useState(1);
  const [usersPerPage] = useState(5); // Show 5 users per page in user-wise view

  // Filter states
  const [filters, setFilters] = useState({
    userType: 'all', // 'all', 'registered', 'guest'
    paymentStatus: 'all', // 'all', 'Paid', 'Pending', 'Failed', 'Cancelled'
    searchQuery: '',
    dateFrom: '',
    dateTo: ''
  });

  // Dynamic filter options
  const [filterOptions, setFilterOptions] = useState({
    paymentStatuses: [],
    userTypes: [],
    dateRange: { min: null, max: null },
    counts: { total: 0, registered: 0, guest: 0, byStatus: {} }
  });

  // Fetch filter options from API on mount
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/donations/filter-options`)
      .then(res => res.json())
      .then(data => {
        setFilterOptions(data);
      })
      .catch(err => {
        console.error("Error fetching filter options:", err);
      });
  }, []);

  // Fetch donations with filters and pagination from API
  useEffect(() => {
    setLoading(true);

    // Build query parameters from filter state
    const params = new URLSearchParams();
    if (filters.userType !== 'all') params.append('userType', filters.userType);
    if (filters.paymentStatus !== 'all') params.append('paymentStatus', filters.paymentStatus);
    if (filters.searchQuery) params.append('searchQuery', filters.searchQuery);
    if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.append('dateTo', filters.dateTo);

    // Add pagination parameters
    params.append('page', currentPage);
    params.append('limit', itemsPerPage);

    const queryString = params.toString();
    const url = `${API_BASE_URL}/api/donations${queryString ? '?' + queryString : ''}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        // Handle paginated response
        if (data.donations && data.pagination) {
          setDonations(data.donations);
          setTotalPages(data.pagination.pages);
          setTotalDonations(data.pagination.total);
        } else {
          // Fallback for old response format
          const sortedData = Array.isArray(data)
            ? data.sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date))
            : [];
          setDonations(sortedData);
          setTotalDonations(sortedData.length);
          setTotalPages(Math.ceil(sortedData.length / itemsPerPage));
        }
        setLoading(false);
      })
      .catch(err => {
        console.error("Error fetching donations:", err);
        setDonations([]);
        setLoading(false);
      });
  }, [filters, currentPage, itemsPerPage]); // Re-fetch whenever filters or page changes

  // Remove client-side filtering - data comes filtered from API
  const filteredDonations = donations;

  // Use data directly from API (already paginated)
  const getPaginatedDonations = () => {
    return filteredDonations;
  };

  // Group donations by user
  const groupDonationsByUser = () => {
    const grouped = {};
    filteredDonations.forEach(donation => {
      const userKey = donation.userId?._id || donation.donorEmail || 'guest';
      if (!grouped[userKey]) {
        grouped[userKey] = {
          userInfo: {
            id: donation.userId?._id || null,
            name: donation.userId?.name || donation.donorName || 'Guest User',
            email: donation.userId?.email || donation.donorEmail || 'N/A',
            type: donation.userId ? 'Registered' : 'Guest'
          },
          donations: [],
          totalDonations: 0,
          totalAmount: 0,
          paidAmount: 0,
          pendingAmount: 0
        };
      }
      grouped[userKey].donations.push(donation);
      grouped[userKey].totalDonations++;
      if (donation.amount) {
        grouped[userKey].totalAmount += parseFloat(donation.amount);
        if (donation.paymentStatus === 'Paid') {
          grouped[userKey].paidAmount += parseFloat(donation.amount);
        } else {
          grouped[userKey].pendingAmount += parseFloat(donation.amount);
        }
      }
    });
    return Object.values(grouped).sort((a, b) => b.totalAmount - a.totalAmount);
  };

  const userGroups = groupDonationsByUser();

  // User-wise pagination helpers
  const totalUserPages = Math.ceil(userGroups.length / usersPerPage);

  const getPaginatedUsers = () => {
    const startIndex = (userWiseCurrentPage - 1) * usersPerPage;
    const endIndex = startIndex + usersPerPage;
    return userGroups.slice(startIndex, endIndex);
  };

  const toggleUserExpansion = (userId) => {
    const newExpanded = new Set(expandedUsers);
    if (newExpanded.has(userId)) {
      newExpanded.delete(userId);
    } else {
      newExpanded.add(userId);
    }
    setExpandedUsers(newExpanded);
  };

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-8">
          All Donations
        </h2>

        {/* View Mode Toggle */}
        <div className="flex justify-center gap-3 mb-8">
          <button
            onClick={() => {
              setViewMode('all');
              setCurrentPage(1);
            }}
            className={`px-4 py-2 font-medium rounded-lg transition-colors duration-200 inline-flex items-center gap-2 ${
              viewMode === 'all'
                ? 'bg-[#05699e] text-white'
                : 'bg-white text-[#05699e] border-2 border-[#05699e] hover:bg-[#05699e]/10'
            }`}
          >
            📋 All Donations
          </button>
          <button
            onClick={() => {
              setViewMode('user-wise');
              setUserWiseCurrentPage(1);
            }}
            className={`px-4 py-2 font-medium rounded-lg transition-colors duration-200 inline-flex items-center gap-2 ${
              viewMode === 'user-wise'
                ? 'bg-[#05699e] text-white'
                : 'bg-white text-[#05699e] border-2 border-[#05699e] hover:bg-[#05699e]/10'
            }`}
          >
            👥 User-Wise View
          </button>
        </div>

        {/* Filter Panel */}
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            🔍 Filters
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            {/* Search Box */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search Name/Email
              </label>
              <input
                type="text"
                placeholder="Search by name or email..."
                value={filters.searchQuery}
                onChange={(e) => {
                  setFilters({ ...filters, searchQuery: e.target.value });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* User Type Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                User Type
              </label>
              <select
                value={filters.userType}
                onChange={(e) => {
                  setFilters({ ...filters, userType: e.target.value });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Users ({filterOptions.counts.total})</option>
                {filterOptions.userTypes.includes('registered') && (
                  <option value="registered">Registered Only ({filterOptions.counts.registered})</option>
                )}
                {filterOptions.userTypes.includes('guest') && (
                  <option value="guest">Guest Only ({filterOptions.counts.guest})</option>
                )}
              </select>
            </div>

            {/* Payment Status Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Payment Status
              </label>
              <select
                value={filters.paymentStatus}
                onChange={(e) => {
                  setFilters({ ...filters, paymentStatus: e.target.value });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Status ({filterOptions.counts.total})</option>
                {filterOptions.paymentStatuses.map(status => (
                  <option key={status} value={status}>
                    {status} ({filterOptions.counts.byStatus[status] || 0})
                  </option>
                ))}
              </select>
            </div>

            {/* Date From */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date From
              </label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => {
                  setFilters({ ...filters, dateFrom: e.target.value });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Date To */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date To
              </label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => {
                  setFilters({ ...filters, dateTo: e.target.value });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Clear Filters Button */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setFilters({
                    userType: 'all',
                    paymentStatus: 'all',
                    searchQuery: '',
                    dateFrom: '',
                    dateTo: ''
                  });
                  setCurrentPage(1);
                  setUserWiseCurrentPage(1);
                }}
                className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors duration-200"
              >
                🔄 Clear Filters
              </button>
            </div>
          </div>

          {/* Active Filters Summary */}
          {(filters.userType !== 'all' || filters.paymentStatus !== 'all' || filters.searchQuery || filters.dateFrom || filters.dateTo) && (
            <div className="mt-4 p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
              <strong>Active Filters:</strong>
              {filters.userType !== 'all' && <span className="ml-2 px-2 py-1 bg-white rounded">User: {filters.userType}</span>}
              {filters.paymentStatus !== 'all' && <span className="ml-2 px-2 py-1 bg-white rounded">Payment: {filters.paymentStatus}</span>}
              {filters.searchQuery && <span className="ml-2 px-2 py-1 bg-white rounded">Search: "{filters.searchQuery}"</span>}
              {filters.dateFrom && <span className="ml-2 px-2 py-1 bg-white rounded">From: {filters.dateFrom}</span>}
              {filters.dateTo && <span className="ml-2 px-2 py-1 bg-white rounded">To: {filters.dateTo}</span>}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading donations...</p>
            </div>
          </div>
        ) : donations.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-12 text-center">
            <div className="text-6xl mb-4">📦</div>
            <p className="text-gray-600 text-lg">No donations found.</p>
          </div>
        ) : (
          <>
            <div className="mb-4 text-gray-600 text-sm">
              {filteredDonations.length === donations.length ? (
                <>
                  Total Donations: <strong>{donations.length}</strong>
                  {viewMode === 'user-wise' && <span className="ml-4">Total Users: <strong>{userGroups.length}</strong></span>}
                </>
              ) : (
                <>
                  Showing: <strong>{filteredDonations.length}</strong> of <strong>{donations.length}</strong> donations
                  {viewMode === 'user-wise' && <span className="ml-4">Users: <strong>{userGroups.length}</strong></span>}
                </>
              )}
            </div>

            {/* All Donations Table View */}
            {viewMode === 'all' && (
              <>
                <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Donor Name</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Base Amount</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Extra Amount</th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Amount</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Payment</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User Type</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {getPaginatedDonations().map((d, index) => (
                          <tr key={d._id} className={`${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-gray-100 transition-colors duration-150`}>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {(currentPage - 1) * itemsPerPage + index + 1}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {d.userId?.name || d.donorName || 'Guest User'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {d.userId?.email || d.donorEmail || 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {d.category?.name || 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {d.item || d.category?.name || 'Donation'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-center text-gray-900">
                              {d.quantity || 1}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-blue-600">
                              {d.baseAmount ? `₹${parseFloat(d.baseAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-purple-600">
                              {d.extraAmount ? `₹${parseFloat(d.extraAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '₹0.00'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-bold text-green-600">
                              {d.amount ? `₹${parseFloat(d.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              {d.paymentStatus && (
                                <span className={`px-3 py-1 rounded-full text-xs font-semibold border inline-block ${
                                  d.paymentStatus === 'Paid' 
                                    ? 'bg-green-100 text-green-800 border-green-600' 
                                    : d.paymentStatus === 'Failed' 
                                    ? 'bg-red-100 text-red-800 border-red-600' 
                                    : 'bg-yellow-100 text-yellow-800 border-yellow-600'
                                }`}>
                                  {d.paymentStatus}
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`px-2 py-1 rounded-md text-xs font-medium border ${
                                d.userId 
                                  ? 'bg-blue-50 text-blue-800 border-blue-200' 
                                  : 'bg-orange-50 text-orange-800 border-orange-200'
                              }`}>
                                {d.userId ? 'Registered' : 'Guest'}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {new Date(d.date).toLocaleDateString('en-IN', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric'
                              })}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              <div className="flex gap-2 justify-center">
                                <button
                                  onClick={() => navigate(`/donations/${d._id}`)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#05699e] hover:bg-[#044d75] text-white text-sm font-medium rounded-lg transition-colors duration-200"
                                  title="View Details"
                                >
                                  👁️ View
                                </button>
                                <button
                                  onClick={() => generateDonationReceipt(d)}
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
                  <div className="mt-6 p-4 border-t border-gray-200">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                      <div className="text-sm text-gray-600">
                        Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalDonations)} of {totalDonations} donations
                      </div>

                      <div className="flex items-center gap-2">
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
                          {(() => {
                            const pages = [];
                            const maxVisiblePages = 10;

                            if (totalPages <= maxVisiblePages) {
                              // Show all pages if total is less than max
                              for (let i = 1; i <= totalPages; i++) {
                                pages.push(i);
                              }
                            } else {
                              // Smart pagination for many pages
                              const leftSiblingIndex = Math.max(currentPage - 1, 1);
                              const rightSiblingIndex = Math.min(currentPage + 1, totalPages);

                              const shouldShowLeftDots = leftSiblingIndex > 2;
                              const shouldShowRightDots = rightSiblingIndex < totalPages - 1;

                              // Always show first page
                              pages.push(1);

                              if (shouldShowLeftDots) {
                                pages.push('...');
                              }

                              // Show current page and siblings
                              for (let i = leftSiblingIndex; i <= rightSiblingIndex; i++) {
                                if (i !== 1 && i !== totalPages) {
                                  pages.push(i);
                                }
                              }

                              if (shouldShowRightDots) {
                                pages.push('...');
                              }

                              // Always show last page
                              if (totalPages > 1) {
                                pages.push(totalPages);
                              }
                            }

                            return pages.map((page, index) => {
                              if (page === '...') {
                                return (
                                  <span key={`dots-${index}`} className="px-3 py-2 text-gray-500">
                                    ...
                                  </span>
                                );
                              }

                              return (
                                <button
                                  key={`page-${page}`}
                                  onClick={() => setCurrentPage(page)}
                                  className={`px-3 py-2 rounded-lg font-medium min-w-[40px] transition-all duration-200 ${
                                    currentPage === page
                                      ? 'bg-[#05699e] text-white font-bold'
                                      : 'bg-white text-[#05699e] border border-[#05699e] hover:bg-[#05699e]/10'
                                  }`}
                                >
                                  {page}
                                </button>
                              );
                            });
                          })()}
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
                    </div>
                  </div>
                )}
              </>
            )}

          {/* User-Wise Grouped View */}
          {viewMode === 'user-wise' && (
            <>
              <div className="mt-5 space-y-4">
                {getPaginatedUsers().map((userGroup) => {
                  const userId = userGroup.userInfo.id || userGroup.userInfo.email;
                  const isExpanded = expandedUsers.has(userId);

                  return (
                    <div key={userId} className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                      {/* User Header */}
                      <div
                        onClick={() => toggleUserExpansion(userId)}
                        className="px-5 py-4 bg-gray-50 cursor-pointer flex justify-between items-center transition-colors duration-200 hover:bg-gray-100"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-2xl">
                              {isExpanded ? '📂' : '📁'}
                            </span>
                            <div>
                              <h3 className="text-xl font-semibold text-gray-900 m-0">
                                {userGroup.userInfo.name}
                              </h3>
                              <p className="text-sm text-gray-600 mt-1 m-0">
                                {userGroup.userInfo.email}
                              </p>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                              userGroup.userInfo.type === 'Registered' 
                                ? 'bg-blue-50 text-blue-800 border-blue-200' 
                                : 'bg-orange-50 text-orange-800 border-orange-200'
                            }`}>
                              {userGroup.userInfo.type}
                            </span>
                          </div>
                        </div>

                        {/* Statistics */}
                        <div className="flex gap-6 mr-5">
                          <div className="text-center">
                            <div className="text-xs text-gray-600 mb-1">Total Donations</div>
                            <div className="text-xl font-bold text-[#05699e]">
                              {userGroup.totalDonations}
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-gray-600 mb-1">Total Amount</div>
                            <div className="text-xl font-bold text-green-600">
                              ₹{userGroup.totalAmount.toFixed(2)}
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-gray-600 mb-1">Paid</div>
                            <div className="text-lg font-bold text-green-600">
                              ₹{userGroup.paidAmount.toFixed(2)}
                            </div>
                          </div>
                          {userGroup.pendingAmount > 0 && (
                            <div className="text-center">
                              <div className="text-xs text-gray-600 mb-1">Pending</div>
                              <div className="text-lg font-bold text-yellow-600">
                                ₹{userGroup.pendingAmount.toFixed(2)}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Download Report Button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            generateUserDonationReport(userGroup);
                          }}
                          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white font-semibold rounded-lg transition-colors duration-200 inline-flex items-center gap-1.5 whitespace-nowrap mr-4"
                          title="Download User Donation Report"
                        >
                          📊 Download Report
                        </button>

                        <div className={`text-2xl text-[#05699e] transition-transform duration-300 ${
                          isExpanded ? 'rotate-180' : 'rotate-0'
                        }`}>
                          ▼
                        </div>
                      </div>

                      {/* Expanded Donations List */}
                      {isExpanded && (
                        <div className="p-4">
                          <table className="w-full border-collapse">
                            <thead>
                              <tr className="bg-gray-50 border-b-2 border-gray-200">
                                <th className="px-2 py-3 text-left text-sm font-semibold text-gray-700">#</th>
                                <th className="px-2 py-3 text-left text-sm font-semibold text-gray-700">Category</th>
                                <th className="px-2 py-3 text-left text-sm font-semibold text-gray-700">Item</th>
                                <th className="px-2 py-3 text-center text-sm font-semibold text-gray-700">Qty</th>
                                <th className="px-2 py-3 text-right text-sm font-semibold text-gray-700">Base Amt</th>
                                <th className="px-2 py-3 text-right text-sm font-semibold text-gray-700">Extra Amt</th>
                                <th className="px-2 py-3 text-right text-sm font-semibold text-gray-700">Total Amt</th>
                                <th className="px-2 py-3 text-center text-sm font-semibold text-gray-700">Payment</th>
                                <th className="px-2 py-3 text-left text-sm font-semibold text-gray-700">Date</th>
                                <th className="px-2 py-3 text-center text-sm font-semibold text-gray-700">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userGroup.donations.map((donation, idx) => (
                                <tr key={donation._id} className={`border-b border-gray-100 ${
                                  idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                                }`}>
                                  <td className="px-2 py-2.5 text-sm text-gray-600">{idx + 1}</td>
                                  <td className="px-2 py-2.5 text-sm">{donation.category?.name || 'N/A'}</td>
                                  <td className="px-2 py-2.5 text-sm">{donation.item || donation.category?.name || 'Donation'}</td>
                                  <td className="px-2 py-2.5 text-sm text-center">{donation.quantity || 1}</td>
                                  <td className="px-2 py-2.5 text-sm text-right font-semibold text-blue-600">
                                    {donation.baseAmount ? `₹${parseFloat(donation.baseAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                                  </td>
                                  <td className="px-2 py-2.5 text-sm text-right font-semibold text-purple-600">
                                    {donation.extraAmount ? `₹${parseFloat(donation.extraAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '₹0.00'}
                                  </td>
                                  <td className="px-2 py-2.5 text-sm text-right font-bold text-green-600">
                                    {donation.amount ? `₹${parseFloat(donation.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                                  </td>
                                  <td className="px-2 py-2.5 text-center">
                                    {donation.paymentStatus && (
                                      <span className={`px-2.5 py-0.5 rounded-lg text-xs font-semibold border ${
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
                                  <td className="px-2 py-2.5 text-sm text-gray-600">
                                    {new Date(donation.date).toLocaleDateString('en-IN', {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric'
                                    })}
                                  </td>
                                  <td className="px-2 py-2.5 text-center">
                                    <button
                                      onClick={() => navigate(`/donations/${donation._id}`)}
                                      className="inline-flex items-center gap-1 px-2 py-1 bg-[#05699e] hover:bg-[#044d75] text-white text-xs font-medium rounded-lg transition-colors duration-200"
                                      title="View Details"
                                    >
                                      👁️ View
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* User-Wise Pagination Controls */}
              {totalUserPages > 1 && (
                <div className="flex justify-center items-center gap-2.5 mt-6 p-4">
                  <button
                    onClick={() => setUserWiseCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={userWiseCurrentPage === 1}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${
                      userWiseCurrentPage === 1
                        ? 'bg-gray-200 text-gray-600 cursor-not-allowed'
                        : 'bg-[#05699e] text-white hover:bg-[#044d73] cursor-pointer'
                    }`}
                  >
                    ← Previous
                  </button>

                  <div className="flex gap-1.5 flex-wrap justify-center">
                    {Array.from({ length: totalUserPages }, (_, i) => i + 1).map(page => (
                      <button
                        key={page}
                        onClick={() => setUserWiseCurrentPage(page)}
                        className={`px-3 py-2 rounded-lg font-medium min-w-[40px] transition-all duration-200 ${
                          userWiseCurrentPage === page
                            ? 'bg-[#05699e] text-white font-bold'
                            : 'bg-white text-[#05699e] border border-[#05699e] hover:bg-[#05699e]/10'
                        }`}
                      >
                        {page}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setUserWiseCurrentPage(prev => Math.min(prev + 1, totalUserPages))}
                    disabled={userWiseCurrentPage === totalUserPages}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${
                      userWiseCurrentPage === totalUserPages
                        ? 'bg-gray-200 text-gray-600 cursor-not-allowed'
                        : 'bg-[#05699e] text-white hover:bg-[#044d73] cursor-pointer'
                    }`}
                  >
                    Next →
                  </button>
                </div>
              )}

              {/* User-Wise Pagination Info */}
              <div className="text-center text-gray-600 text-sm mt-3">
                Showing {(userWiseCurrentPage - 1) * usersPerPage + 1} to {Math.min(userWiseCurrentPage * usersPerPage, userGroups.length)} of {userGroups.length} users
              </div>
            </>
          )}
          </>
        )}
      </div>
    </div>
  );
}

export default DonationsPage;
