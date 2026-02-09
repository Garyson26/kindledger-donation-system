import React, { useEffect, useState } from "react";
import { validateProfile } from "../utils/validateForm";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";
import { API_BASE_URL } from "../config/constants";

function ProfilePage() {
  const { toasts, showToast, hideToast } = useToast();
  const [profile, setProfile] = useState({ name: "", email: "", phone: "", address: "" });
  const [edit, setEdit] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch profile using token
    const token = localStorage.getItem("token");
    if (!token) {
      showToast("Please login to view profile", "error");
      setLoading(false);
      return;
    }

    fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: { Authorization: "Bearer " + token }
    })
      .then(async res => {
        if (res.status === 401) {
          // token invalid/expired - remove and redirect to login
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          localStorage.removeItem("userId");
          localStorage.removeItem("userRole");
          showToast("Session expired. Please log in again.", "error");
          window.setTimeout(() => { window.location.href = "/login"; }, 1500);
          throw new Error("Unauthorized");
        }

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`HTTP error! status: ${res.status} ${txt}`);
        }

        return res.json();
      })
      .then(data => {
        setProfile({
          name: data.name || "",
          email: data.email || "",
          phone: data.phone || "",
          address: data.address || ""
        });
        setLoading(false);
      })
      .catch(err => {
        if (err.message === 'Unauthorized') return; // already handled above
        console.error("Profile fetch error:", err);
        showToast("Error loading profile data", "error");
        setLoading(false);
      });
  }, [showToast]);

  const handleUpdate = (e) => {
    e.preventDefault();
    const validationError = validateProfile(profile);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }

    fetch(`${API_BASE_URL}/api/users/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("token")
      },
      body: JSON.stringify(profile)
    })
      .then(res => {
        // Handle 401 Unauthorized - invalid/expired token
        if (res.status === 401) {
          console.warn('Invalid or expired token. Redirecting to login...');
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          localStorage.removeItem("userId");
          localStorage.removeItem("userRole");
          showToast("Session expired. Please log in again.", "error");
          window.setTimeout(() => { window.location.href = "/login"; }, 1500);
          throw new Error("Unauthorized");
        }

        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log("Profile update response:", data);
        // Ensure we have all the fields we need
        const updatedProfile = {
          name: data.name || profile.name,
          email: data.email || profile.email,
          phone: data.phone || profile.phone,
          address: data.address || profile.address
        };
        setProfile(updatedProfile);
        setEdit(false);
        showToast("Profile saved successfully!", "success");
      })
      .catch(err => {
        if (err.message === 'Unauthorized') return; // Already handled
        console.error("Profile update error:", err);
        showToast("Error saving profile. Please try again.", "error");
      });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading profile...</p>
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

      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-2">My Profile</h2>
          <p className="text-gray-600">Manage your personal information</p>
        </div>

        {edit ? (
          <form onSubmit={handleUpdate} className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <div className="space-y-5">
              {/* Name Field */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={profile.name}
                  onChange={e => setProfile({ ...profile, name: e.target.value })}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Email Field (Read-only) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={profile.email}
                  disabled
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600 cursor-not-allowed"
                />
                <p className="mt-1 text-xs text-gray-500">Email cannot be changed</p>
              </div>

              {/* Phone Field */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone
                </label>
                <input
                  type="text"
                  value={profile.phone}
                  onChange={e => setProfile({ ...profile, phone: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Enter your phone number"
                />
              </div>

              {/* Address Field */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Address
                </label>
                <textarea
                  value={profile.address}
                  onChange={e => setProfile({ ...profile, address: e.target.value })}
                  rows="3"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                  placeholder="Enter your address"
                />
              </div>
            </div>

            {/* Form Actions */}
            <div className="flex gap-3 pt-6 border-t border-gray-200 mt-6">
              <button
                type="submit"
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Save Changes
              </button>
              <button
                type="button"
                onClick={() => setEdit(false)}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors duration-200"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            {/* Profile Header */}
            <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Profile Information
              </h3>
            </div>

            {/* Profile Details */}
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 bg-[#05699e]/10 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Name</p>
                  <p className="text-base font-semibold text-gray-900">{profile.name || "Not set"}</p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Email</p>
                  <p className="text-base font-semibold text-gray-900">{profile.email}</p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Phone</p>
                  <p className="text-base font-semibold text-gray-900">{profile.phone || "Not set"}</p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Address</p>
                  <p className="text-base font-semibold text-gray-900">{profile.address || "Not set"}</p>
                </div>
              </div>
            </div>

            {/* Edit Button */}
            <div className="px-6 pb-6">
              <button
                onClick={() => setEdit(true)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit Profile
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProfilePage;
