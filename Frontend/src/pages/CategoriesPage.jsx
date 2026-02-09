
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { categoriesAPI } from "../utils/api";

const CategoriesPage = ({ userRole }) => {
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Check if user is admin
  const isAdmin = userRole === "admin";

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const { data, error, ok } = await categoriesAPI.getAll();
        if (ok) {
          setCategories(data);
        } else {
          setError(error || "Failed to fetch categories");
        }
      } catch {
        setError("Failed to fetch categories");
      } finally {
        setLoading(false);
      }
    };

    fetchCategories();
  }, []);

  const handleDonate = (category) => {
    // Navigate to donate page with category - no login required
    navigate("/donate", { state: { category } });
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Loading categories...</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-lg">
        {error}
      </div>
    </div>
  );

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="text-center sm:text-left">
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Donation Categories
              </h1>
              <p className="text-gray-600 max-w-2xl">
                Choose a category to make a difference. Every donation counts!
              </p>
            </div>

            {/* Admin Action Buttons */}
            {isAdmin && (
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => navigate("/admin/categories-list")}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 text-[#05699e] font-medium rounded-lg transition-colors duration-200 shadow-sm hover:shadow-md border border-[#05699e] whitespace-nowrap"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  View All Categories
                </button>
                <button
                  onClick={() => navigate("/admin/add-category")}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200 shadow-sm hover:shadow-md whitespace-nowrap"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Add Category
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Categories Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {categories.map((cat) => (
            <div
              key={cat._id}
              className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden border border-gray-200"
            >
              {/* Card Header with Icon */}
              <div className="bg-[#05699e] p-6 text-white">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xl font-semibold">{cat.name}</h3>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                {cat.donationAmount && (
                  <div className="flex items-baseline">
                    <span className="text-2xl font-bold">₹{cat.donationAmount}</span>
                    <span className="ml-2 text-white/80 text-sm">per donation</span>
                  </div>
                )}
              </div>

              {/* Card Body */}
              <div className="p-6">
                {/* Short Description */}
                {cat.sortDescription && (
                  <p className="text-gray-700 text-sm mb-4 leading-relaxed">
                    {cat.sortDescription}
                  </p>
                )}

                {/* Additional Descriptions */}
                {cat.descriptions && cat.descriptions.length > 0 && cat.descriptions.some(d => d.trim()) && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                      <svg className="w-4 h-4 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Details
                    </h4>
                    <ul className="space-y-2">
                      {cat.descriptions.filter(d => d.trim()).map((desc, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm text-gray-600">
                          <svg className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span>{desc}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Donate Button */}
                <button
                  onClick={() => handleDonate(cat)}
                  className="w-full px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200 inline-flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Donate {cat.donationAmount && `₹${cat.donationAmount}`}
                </button>
              </div>

              {/* Card Footer */}
              <div className="bg-gray-50 px-6 py-3 border-t border-gray-100">
                <p className="text-xs text-gray-500 text-center">
                  Click to make a donation
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Empty State */}
        {categories.length === 0 && !loading && (
          <div className="bg-white rounded-lg shadow-sm p-12 text-center">
            <svg className="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <h3 className="text-lg font-semibold text-gray-700 mb-2">No Categories Available</h3>
            <p className="text-gray-500">Categories will appear here once they are added.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default CategoriesPage;
