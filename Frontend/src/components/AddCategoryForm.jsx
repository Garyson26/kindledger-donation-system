import React from "react";

function AddCategoryForm({
  form,
  setForm,
  editing,
  onSubmit,
  onCancel
}) {
  // Add new description field
  const addDescriptionField = () => {
    setForm({ ...form, descriptions: [...form.descriptions, ""] });
  };

  // Remove description field
  const removeDescriptionField = (index) => {
    const newDescriptions = form.descriptions.filter((_, i) => i !== index);
    setForm({ ...form, descriptions: newDescriptions.length > 0 ? newDescriptions : [""] });
  };

  // Update specific description
  const updateDescription = (index, value) => {
    const newDescriptions = [...form.descriptions];
    newDescriptions[index] = value;
    setForm({ ...form, descriptions: newDescriptions });
  };

  return (
    <form onSubmit={onSubmit} className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-200">
      <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          {editing ? "Edit Category" : "Add New Category"}
        </h3>
      </div>

      <div className="p-6 space-y-5">
        {/* Category Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Category Name <span className="text-red-600">*</span>
          </label>
          <input
            placeholder="e.g., Education, Healthcare, Food"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent"
            name="name"
            required
          />
        </div>

        {/* Donation Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Donation Amount (₹) <span className="text-red-600">*</span>
          </label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">₹</span>
            <input
              type="number"
              placeholder="e.g., 5000"
              value={form.donationAmount}
              onChange={e => setForm({ ...form, donationAmount: e.target.value })}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent"
              name="donationAmount"
              required
            />
          </div>
        </div>

        {/* Short Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Short Description <span className="text-red-600">*</span>
          </label>
          <input
            placeholder="Brief one-line description"
            value={form.sortDescription}
            onChange={e => setForm({ ...form, sortDescription: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent"
            name="sortDescription"
            required
          />
        </div>

        {/* Multiple Descriptions Section */}
        <div className="bg-gray-50 rounded-lg p-5 border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <div>
              <label className="block text-sm font-semibold text-gray-800">Additional Descriptions</label>
              <p className="text-xs text-gray-500 mt-1">Add detailed information about this category</p>
            </div>
            <button
              type="button"
              onClick={addDescriptionField}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors duration-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Description
            </button>
          </div>

          <div className="space-y-3">
            {form.descriptions.map((desc, index) => (
              <div key={index} className="flex gap-2 items-start bg-white rounded-lg p-3 border border-gray-200 hover:border-[var(--kl-primary)]/50 transition-colors duration-200">
                <div className="flex-1 relative">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 text-xs font-bold text-white bg-[var(--kl-primary)] rounded-full">
                      {index + 1}
                    </span>
                    <span className="text-xs font-medium text-gray-500">Description {index + 1}</span>
                  </div>
                  <textarea
                    placeholder={`Enter description details here...`}
                    value={desc}
                    onChange={e => updateDescription(index, e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent resize-none text-sm"
                    rows="3"
                  />
                </div>
                {form.descriptions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeDescriptionField(index)}
                    className="flex-shrink-0 p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors duration-200"
                    title="Remove this description"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          {form.descriptions.length === 0 && (
            <div className="text-center py-8 bg-white rounded-lg border-2 border-dashed border-gray-300">
              <svg className="w-12 h-12 mx-auto text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm text-gray-700 font-medium">No additional descriptions yet</p>
              <p className="text-xs text-gray-500 mt-1">Click "Add Description" to add one</p>
            </div>
          )}
        </div>

        {/* Form Actions */}
        <div className="flex gap-3 pt-4 border-t border-gray-200">
          <button
            type="submit"
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-[var(--kl-primary)] hover:bg-[var(--kl-primary-dark)] text-white font-medium rounded-lg transition-colors duration-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={editing ? "M5 13l4 4L19 7" : "M12 4v16m8-8H4"} />
            </svg>
            {editing ? "Update Category" : "Add Category"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors duration-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Cancel
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

export default AddCategoryForm;

