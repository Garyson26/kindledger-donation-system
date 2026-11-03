import React, { useState } from "react";

function CategoriesList({ categories, onEdit, onDelete, onReorder }) {
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [expandedIds, setExpandedIds] = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  const toggleExpand = (id) => {
    setExpandedIds(prev => 
      prev.includes(id) 
        ? prev.filter(expId => expId !== id)
        : [...prev, id]
    );
  };

  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    setIsDragging(true);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === dropIndex) return;

    const newCategories = [...categories];
    const draggedItem = newCategories[draggedIndex];
    
    // Remove from old position
    newCategories.splice(draggedIndex, 1);
    // Insert at new position
    newCategories.splice(dropIndex, 0, draggedItem);

    // Update displayOrder for all categories
    const reorderedCategories = newCategories.map((cat, index) => ({
      id: cat._id,
      displayOrder: index
    }));

    setDraggedIndex(null);
    console.log('🔄 Reorder triggered with:', reorderedCategories);
    console.log('🔍 onReorder function exists?', typeof onReorder === 'function');
    console.log('🔍 onReorder function code:', onReorder.toString());
    if (onReorder && typeof onReorder === 'function') {
      onReorder(reorderedCategories);
    }
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setIsDragging(false);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-200">
      <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          Categories List ({categories.length})
        </h3>
        <p className="text-sm text-gray-600 mt-1">Drag and drop to reorder categories</p>
      </div>

      <div className="p-6">
        {categories.length === 0 ? (
          <div className="text-center py-12">
            <svg className="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-gray-700 text-lg font-medium">No categories found</p>
            <p className="text-gray-500 text-sm mt-1">Add your first category using the button above</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {categories.map((cat, index) => {
              const isExpanded = expandedIds.includes(cat._id);
              
              return (
              <li 
                key={cat._id}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, index)}
                className={`bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all duration-200 overflow-hidden ${
                  draggedIndex === index ? 'opacity-50 scale-95' : ''
                }`}
              >
                {/* Header - Always Visible */}
                <div 
                  className="flex items-center justify-between p-5"
                >
                  <div className="flex items-center gap-3 flex-1">
                    {/* Drag Handle */}
                    <div 
                      draggable="true"
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragEnd={handleDragEnd}
                      className="drag-handle flex-shrink-0 text-blue-500 hover:text-blue-700 cursor-grab active:cursor-grabbing p-2 bg-blue-50 rounded hover:bg-blue-100"
                      title="Drag to reorder"
                    >
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/>
                      </svg>
                    </div>
                    
                    {/* Clickable area for expand/collapse */}
                    <div 
                      className="flex items-center gap-3 flex-1 cursor-pointer"
                      onClick={() => toggleExpand(cat._id)}
                    >
                      {/* Position Number */}
                      <span className="inline-flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-800 text-sm font-bold rounded-full flex-shrink-0">
                        {index + 1}
                      </span>
                      
                      {/* Category Name */}
                      <strong className="text-xl text-gray-900 font-semibold">{cat.name}</strong>
                      
                      {/* Donation Amount */}
                      {cat.donationAmount && (
                        <span className="inline-flex items-center bg-blue-100 text-blue-800 text-sm font-semibold px-3 py-1 rounded-full border border-blue-600">
                          ₹{cat.donationAmount}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Expand/Collapse Icon */}
                  <div 
                    className="flex items-center gap-2 cursor-pointer"
                    onClick={() => toggleExpand(cat._id)}
                  >
                    <svg 
                      className={`w-6 h-6 text-gray-500 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" 
                      stroke="currentColor" 
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expandable Content */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-gray-100">
                    <div className="pt-4">
                      {cat.sortDescription && (
                        <p className="text-gray-600 text-sm mb-3 leading-relaxed">{cat.sortDescription}</p>
                      )}

                      {/* Display additional descriptions */}
                      {cat.descriptions && cat.descriptions.length > 0 && cat.descriptions.some(d => d.trim()) && (
                        <div className="mt-4 pt-4 border-t border-gray-200">
                          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-1">
                            <svg className="w-4 h-4 text-[var(--kl-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            Additional Details
                          </p>
                          <ul className="space-y-2">
                            {cat.descriptions.filter(d => d.trim()).map((desc, idx) => (
                              <li key={idx} className="text-sm text-gray-700 flex items-start gap-3 bg-[var(--kl-primary)]/10 rounded-lg p-3 border border-[var(--kl-primary)]/20">
                                <span className="inline-flex items-center justify-center w-6 h-6 text-xs font-bold text-white bg-[var(--kl-primary)] rounded-full flex-shrink-0 mt-0.5">
                                  {idx + 1}
                                </span>
                                <span className="flex-1">{desc}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="flex gap-2 mt-4 pt-4 border-t border-gray-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(cat);
                          }}
                          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-[var(--kl-primary)] hover:bg-[var(--kl-primary-dark)] text-white font-medium rounded-lg transition-colors duration-200"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          Edit
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(cat._id);
                          }}
                          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors duration-200"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default CategoriesList;

