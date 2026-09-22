import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { validateCategory } from "../utils/validateForm";
import { categoriesAPI } from "../utils/api";
import AddCategoryForm from "../components/AddCategoryForm";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";

function AddCategory() {
  const navigate = useNavigate();
  const { toasts, showToast, hideToast } = useToast();
  const [form, setForm] = useState({
    name: "",
    donationAmount: "",
    sortDescription: "",
    descriptions: [""]
  });

  const handleAdd = e => {
    e.preventDefault();
    const validationError = validateCategory(form);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }
    categoriesAPI.create(form)
      .then(response => {
        if (response.ok) {
          showToast("Category added successfully!", "success");
          setForm({
            name: "",
            donationAmount: "",
            sortDescription: "",
            descriptions: [""]
          });
          // Navigate to categories list after a short delay
          setTimeout(() => navigate("/admin/categories-list"), 1500);
        } else {
          showToast(response.error, "error");
        }
      });
  };

  const handleCancel = () => {
    navigate("/admin/categories-list");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8 px-4 sm:px-6 lg:px-8">
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
            className="mb-4 inline-flex items-center gap-2 text-[var(--kl-primary)] hover:text-[var(--kl-primary-dark)] font-medium transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Categories List
          </button>
          <h2 className="text-4xl font-bold text-gray-900 mb-2">Add New Category</h2>
          <p className="text-gray-600">Create a new donation category with detailed descriptions</p>
        </div>

        {/* Form */}
        <AddCategoryForm
          form={form}
          setForm={setForm}
          editing={false}
          onSubmit={handleAdd}
          onCancel={handleCancel}
        />
      </div>
    </div>
  );
}

export default AddCategory;

