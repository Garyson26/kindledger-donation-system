import React, { useState, useEffect } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { validateCategory } from "../utils/validateForm";
import { categoriesAPI } from "../utils/api";
import AddCategoryForm from "../components/AddCategoryForm";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";

function EditCategory() {
  const navigate = useNavigate();
  const { id } = useParams();
  const location = useLocation();
  const { toasts, showToast, hideToast } = useToast();
  const [form, setForm] = useState({
    name: "",
    donationAmount: "",
    sortDescription: "",
    descriptions: [""]
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Try to get category from navigation state first
    if (location.state?.category) {
      const category = location.state.category;
      setForm({
        name: category.name,
        donationAmount: category.donationAmount || "",
        sortDescription: category.sortDescription || "",
        descriptions: category.descriptions && category.descriptions.length > 0
          ? category.descriptions
          : [""]
      });
      setLoading(false);
    } else {
      // Otherwise fetch from API
      categoriesAPI.getAll()
        .then(response => {
          if (response.ok) {
            const category = response.data.find(c => c._id === id);
            if (category) {
              setForm({
                name: category.name,
                donationAmount: category.donationAmount || "",
                sortDescription: category.sortDescription || "",
                descriptions: category.descriptions && category.descriptions.length > 0
                  ? category.descriptions
                  : [""]
              });
            } else {
              showToast("Category not found!", "error");
              setTimeout(() => navigate("/admin/categories-list"), 1500);
            }
          }
          setLoading(false);
        });
    }
  }, [id, location.state, navigate, showToast]);

  const handleUpdate = e => {
    e.preventDefault();
    const validationError = validateCategory(form);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }
    categoriesAPI.update(id, form)
      .then(response => {
        if (response.ok) {
          showToast("Category updated successfully!", "success");
          setTimeout(() => navigate("/admin/categories-list"), 1500);
        } else {
          showToast(response.error, "error");
        }
      });
  };

  const handleCancel = () => {
    navigate("/admin/categories-list");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex justify-center items-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading category...</p>
        </div>
      </div>
    );
  }

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

      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => navigate("/admin/categories-list")}
            className="mb-4 inline-flex items-center gap-2 px-4 py-2 text-[#05699e] hover:text-[#044d73] font-medium transition-colors duration-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Categories List
          </button>
          <h2 className="text-3xl font-bold text-gray-900 mb-2">Edit Category</h2>
          <p className="text-gray-600">Update category information and descriptions</p>
        </div>

        {/* Form */}
        <AddCategoryForm
          form={form}
          setForm={setForm}
          editing={true}
          onSubmit={handleUpdate}
          onCancel={handleCancel}
        />
      </div>
    </div>
  );
}

export default EditCategory;

