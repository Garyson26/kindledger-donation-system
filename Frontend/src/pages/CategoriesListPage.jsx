import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { categoriesAPI } from "../utils/api";
import CategoriesList from "../components/CategoriesList";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";
import ConfirmModal from "../components/ConfirmModal";

function CategoriesListPage() {
  const navigate = useNavigate();
  const { toasts, showToast, hideToast } = useToast();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteModal, setDeleteModal] = useState({ isOpen: false, categoryId: null });

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCategories, setTotalCategories] = useState(0);

  useEffect(() => {
    loadCategories();
  }, [currentPage]);

  const loadCategories = () => {
    setLoading(true);

    // Add pagination parameters
    const params = new URLSearchParams({
      page: currentPage,
      limit: itemsPerPage
    });

    categoriesAPI.getAll(params.toString())
      .then(response => {
        if (response.ok) {
          // Handle paginated response
          if (response.data.categories && response.data.pagination) {
            setCategories(response.data.categories);
            setTotalPages(response.data.pagination.pages);
            setTotalCategories(response.data.pagination.total);
          } else {
            // Fallback for old response format (all categories)
            setCategories(Array.isArray(response.data) ? response.data : []);
            setTotalCategories(Array.isArray(response.data) ? response.data.length : 0);
            setTotalPages(1);
          }
        }
        setLoading(false);
      });
  };

  const handleEdit = category => {
    navigate(`/admin/edit-category/${category._id}`, { state: { category } });
  };

  const handleDelete = id => {
    setDeleteModal({ isOpen: true, categoryId: id });
  };

  const confirmDelete = () => {
    const id = deleteModal.categoryId;
    categoriesAPI.delete(id)
      .then(response => {
        if (response.ok) {
          setCategories(categories.filter(c => c._id !== id));
          showToast("Category deleted successfully!", "success");
        } else {
          showToast(response.error, "error");
        }
      });
  };

  const handleReorder = async (reorderedCategories) => {
    console.log('✅ CategoriesListPage handleReorder called');
    try {
      // Store original order for potential revert
      const originalCategories = [...categories];
      
      // Create a completely new array with the new order
      const newCategoriesOrder = reorderedCategories.map((item) => {
        const category = categories.find(c => c._id === item.id);
        return { 
          ...category, 
          displayOrder: item.displayOrder 
        };
      });
      
      // Update UI immediately
      setCategories([...newCategoriesOrder]);

      // Save to backend
      console.log('📡 Calling API with:', reorderedCategories);
      const response = await categoriesAPI.reorder(reorderedCategories);
      console.log('📡 API response:', response);
      
      if (response.ok) {
        showToast("Categories reordered successfully!", "success");
      } else {
        // Revert on error
        setCategories(originalCategories);
        showToast(response.error || "Failed to reorder categories", "error");
      }
    } catch (error) {
      console.error('❌ Reorder error:', error);
      // Reload from backend on error
      loadCategories();
      showToast("An error occurred while reordering categories", "error");
    }
  };

  return (
    <div className="box-mrg bg-gray-50 px-4 sm:px-6 lg:px-8"> 
      {/* Toast notifications */}
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => hideToast(toast.id)}
          duration={toast.duration}
        />
      ))}

      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, categoryId: null })}
        onConfirm={confirmDelete}
        title="Delete Category"
        message="Are you sure you want to delete this category? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        type="danger"
      />

      <div className="max-w-6xl mx-auto">
        {/* Header with Add Button */}
        <div className="mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold text-gray-900 mb-2">Categories</h2>
            <p className="text-gray-600">Manage all donation categories ({totalCategories} total)</p>
          </div>
          <button
            onClick={() => navigate("/admin/add-category")}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add New Category
          </button>
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#05699e] mx-auto mb-4"></div>
              <p className="text-gray-600">Loading categories...</p>
            </div>
          </div>
        ) : (
          <>
            <CategoriesList
              categories={categories}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onReorder={handleReorder}
            />

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="mt-6 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="text-sm text-gray-600">
                    Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalCategories)} of {totalCategories} categories
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      className={`px-3 py-2 rounded-lg font-medium transition-colors duration-200 ${
                        currentPage === 1
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>

                    {/* Page numbers */}
                    <div className="flex items-center gap-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`px-4 py-2 rounded-lg font-medium transition-colors duration-200 ${
                            currentPage === page
                              ? 'bg-[#05699e] text-white'
                              : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                          }`}
                        >
                          {page}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      className={`px-3 py-2 rounded-lg font-medium transition-colors duration-200 ${
                        currentPage === totalPages
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default CategoriesListPage;

