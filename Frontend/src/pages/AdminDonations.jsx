import { useBranding } from "../branding/BrandingProvider";
import React, { useEffect, useState } from "react";
import { donationsAPI } from "../utils/api";
import ConfirmModal from "../components/ConfirmModal";
import { generateDonationReceipt } from "../utils/pdfGenerator";

function AdminDonations() {
  const { organisationName } = useBranding();
  const [donations, setDonations] = useState([]);
  const [loadingId, setLoadingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState("");
  const [deleteModal, setDeleteModal] = useState({ isOpen: false, donationId: null });
  const [statusModal, setStatusModal] = useState({ isOpen: false, donationId: null, status: null });

  useEffect(() => {
    const fetchDonations = async () => {
      const { data, ok } = await donationsAPI.getAll();
      if (ok) {
        setDonations(data);
      }
    };
    fetchDonations();
  }, []);

  const handleDelete = (id) => {
    setDeleteModal({ isOpen: true, donationId: id });
  };

  const confirmDelete = async () => {
    const id = deleteModal.donationId;
    setDeletingId(id);
    setError("");
    try {
      const { ok, error } = await donationsAPI.delete(id);
      if (!ok) throw new Error(error || "Failed to delete donation");
      setDonations(donations.filter(d => d._id !== id));
    } catch (err) {
      setError(err.message || "Error deleting donation");
    } finally {
      setDeletingId(null);
    }
  };

  const updateStatus = async (id, status) => {
    const statusValue = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    setStatusModal({ isOpen: true, donationId: id, status: statusValue });
  };

  const confirmStatusUpdate = async () => {
    const { donationId: id, status: statusValue } = statusModal;
    setLoadingId(id);
    setError("");
    try {
      const { data, ok, error } = await donationsAPI.update(id, { status: statusValue });
      if (!ok) throw new Error(error || "Failed to update status");
      setDonations(donations.map(d => d._id === id ? data.donation : d));
    } catch (err) {
      setError(err.message || "Error updating status");
    } finally {
      setLoadingId(null);
    }
  };

  const getStatusColor = (status) => {
    const statusLower = status?.toLowerCase();
    if (statusLower === 'approved') return 'text-green-600 bg-green-50 border-green-600';
    if (statusLower === 'rejected') return 'text-red-600 bg-red-50 border-red-600';
    return 'text-yellow-600 bg-yellow-50 border-yellow-600';
  };

  const getPaymentStatusColor = (status) => {
    if (status === 'Paid') return 'text-green-600';
    if (status === 'Failed') return 'text-red-600';
    return 'text-yellow-600';
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, donationId: null })}
        onConfirm={confirmDelete}
        title="Delete Donation"
        message="Are you sure you want to delete this donation? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        type="danger"
      />

      {/* Confirm Status Update Modal */}
      <ConfirmModal
        isOpen={statusModal.isOpen}
        onClose={() => setStatusModal({ isOpen: false, donationId: null, status: null })}
        onConfirm={confirmStatusUpdate}
        title="Update Donation Status"
        message={`Are you sure you want to ${statusModal.status?.toLowerCase()} this donation?`}
        confirmText="Confirm"
        cancelText="Cancel"
        type="info"
      />

      <h2 className="mb-6 text-2xl font-bold text-center text-gray-800">Donation Requests</h2>

      {error && (
        <div className="mb-4 text-center text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </div>
      )}

      {donations.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No donations found.</p>
      ) : (
        <ul className="space-y-4">
          {donations.map(d => (
            <li
              key={d._id}
              className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col md:flex-row gap-4 items-start"
            >
              <div className="flex-1 w-full">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <strong className="text-lg font-semibold text-gray-800">
                    {d.item || d.category?.name || "Donation"}
                  </strong>
                  <span className={`ml-auto px-3 py-1 rounded-full text-xs font-bold border ${getStatusColor(d.status)}`}>
                    {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
                  </span>
                </div>

                <div className="text-sm text-gray-600 space-y-1 leading-relaxed">
                  <div>
                    <strong className="text-gray-700">Donor:</strong> {d.userId?.name || d.donorName || "Guest User"}
                    <span className="text-gray-500 ml-1">
                      {d.userId ? "(Registered)" : "(Guest)"}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-x-4">
                    <span>
                      <strong className="text-gray-700">Email:</strong> {d.userId?.email || d.donorEmail || "N/A"}
                    </span>
                    {d.donorPhone && (
                      <span>
                        <strong className="text-gray-700">Phone:</strong> {d.donorPhone}
                      </span>
                    )}
                  </div>

                  {d.category?.name && (
                    <div>
                      <strong className="text-gray-700">Category:</strong> {d.category.name}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-4">
                    <span>
                      <strong className="text-gray-700">Quantity:</strong> {d.quantity || 1}
                    </span>
                  </div>

                  {/* Amount breakdown */}
                  <div className="bg-gray-50 rounded-md p-3 mt-2 border border-gray-200">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {d.baseAmount && (
                        <div>
                          <div className="text-xs text-gray-500">Base Amount</div>
                          <div className="font-bold text-blue-600">
                            ₹{parseFloat(d.baseAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      )}
                      {d.extraAmount !== undefined && (
                        <div>
                          <div className="text-xs text-gray-500">Extra Amount</div>
                          <div className="font-bold text-purple-600">
                            ₹{parseFloat(d.extraAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      )}
                      {d.amount && (
                        <div>
                          <div className="text-xs text-gray-500">Total Amount</div>
                          <div className="font-bold text-green-600 text-lg">
                            ₹{parseFloat(d.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {d.paymentStatus && (
                    <div>
                      <strong className="text-gray-700">Payment Status:</strong>{" "}
                      <span className={`font-bold ${getPaymentStatusColor(d.paymentStatus)}`}>
                        {d.paymentStatus}
                      </span>
                      {d.transactionId && (
                        <span className="ml-2 text-gray-400 text-xs">
                          (TxnID: {d.transactionId})
                        </span>
                      )}
                    </div>
                  )}

                  <div className="text-xs text-gray-400 mt-2">
                    {new Date(d.date).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="flex flex-row md:flex-col gap-2 w-full md:w-auto md:min-w-[130px]">
                {/* Receipt Download Button */}
                <button
                  onClick={() => generateDonationReceipt(d, organisationName)}
                  title="Download receipt PDF"
                  className="px-4 py-2 text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-700 rounded-md shadow-sm transition-all duration-200 whitespace-nowrap"
                >
                  📄 Receipt
                </button>

                {(d.status && d.status.toLowerCase() === "pending") && (
                  <>
                    <button
                      onClick={() => updateStatus(d._id, "Approved")}
                      disabled={loadingId === d._id}
                      title="Approve this donation"
                      className={`px-4 py-2 text-sm font-bold text-white rounded-md shadow-sm transition-all duration-200 whitespace-nowrap ${
                        loadingId === d._id
                          ? 'bg-green-300 cursor-not-allowed'
                          : 'bg-green-600 hover:bg-green-700 cursor-pointer'
                      }`}
                    >
                      {loadingId === d._id ? "Processing..." : "✔ Approve"}
                    </button>
                    <button
                      onClick={() => updateStatus(d._id, "rejected")}
                      disabled={loadingId === d._id}
                      title="Reject this donation"
                      className={`px-4 py-2 text-sm font-bold text-white rounded-md shadow-sm transition-all duration-200 whitespace-nowrap ${
                        loadingId === d._id
                          ? 'bg-red-300 cursor-not-allowed'
                          : 'bg-red-600 hover:bg-red-700 cursor-pointer'
                      }`}
                    >
                      {loadingId === d._id ? "Processing..." : "✖ Reject"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => handleDelete(d._id)}
                  disabled={deletingId === d._id}
                  title="Delete this donation"
                  className={`px-4 py-2 text-sm font-bold text-white rounded-md shadow-sm transition-all duration-200 whitespace-nowrap ${
                    deletingId === d._id
                      ? 'bg-gray-300 cursor-not-allowed'
                      : 'bg-gray-600 hover:bg-gray-700 cursor-pointer'
                  }`}
                >
                  {deletingId === d._id ? "Deleting..." : "🗑 Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default AdminDonations;
