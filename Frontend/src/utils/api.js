import { API_BASE_URL, getHeaders } from '../config/constants';

// Base API URL from config
const API_URL = `${API_BASE_URL}/api`;

/**
 * Main API request function
 * @param {string} endpoint - API endpoint (e.g., '/auth/login')
 * @param {Object} options - Fetch options
 * @param {string} options.method - HTTP method (GET, POST, PUT, DELETE)
 * @param {Object} options.body - Request body (will be stringified)
 * @param {Object} options.headers - Additional headers
 * @param {boolean} options.auth - Whether to include auth token
 * @returns {Promise<{data: any, error: string|null, ok: boolean, status: number}>}
 */
export const apiRequest = async (endpoint, options = {}) => {
  const {
    method = "GET",
    body = null,
    headers = {},
    auth = false,
  } = options;

  const config = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  // Add authorization header if auth is true
  if (auth) {
    const token = localStorage.getItem("token");
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
  }

  // Add body if present
  if (body) {
    config.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(`${API_URL}${endpoint}`, config);

    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    // Handle 401 Unauthorized - Invalid/Expired Token
    if (res.status === 401) {
      console.warn('Invalid or expired token detected. Redirecting to login...');
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("userId");
      // userRole is no longer stored in localStorage
      window.location.href = "/login";
      return {
        data: null,
        error: "Session expired. Please log in again.",
        ok: false,
        status: 401,
      };
    }

    return {
      data,
      error: !res.ok ? (data.error || data.message || "Request failed") : null,
      ok: res.ok,
      status: res.status,
    };
  } catch {
    return {
      data: null,
      error: "Network error. Please try again.",
      ok: false,
      status: 0,
    };
  }
};

// Auth API calls
export const authAPI = {
  login: (credentials) =>
    apiRequest("/auth/login", {
      method: "POST",
      body: credentials,
    }),

  signup: (userData) =>
    apiRequest("/auth/signup", {
      method: "POST",
      body: userData,
    }),

  changePassword: (passwordData) =>
    apiRequest("/auth/change-password", {
      method: "POST",
      body: passwordData,
      auth: true,
    }),

  // Forgot Password - Request verification code
  forgotPasswordRequest: (email) =>
    apiRequest("/auth/forgot-password/request", {
      method: "POST",
      body: { email },
    }),

  // Forgot Password - Verify code
  forgotPasswordVerify: (email, code) =>
    apiRequest("/auth/forgot-password/verify", {
      method: "POST",
      body: { email, code },
    }),

  // Forgot Password - Reset password
  forgotPasswordReset: (email, code, newPassword) =>
    apiRequest("/auth/forgot-password/reset", {
      method: "POST",
      body: { email, code, newPassword },
    }),
};

// Categories API calls
export const categoriesAPI = {
  getAll: (queryParams = '') =>
    apiRequest(`/categories${queryParams ? '?' + queryParams : ''}`),

  create: (categoryData) =>
    apiRequest("/categories", {
      method: "POST",
      body: categoryData,
      auth: true,
    }),

  update: (id, categoryData) =>
    apiRequest(`/categories/${id}`, {
      method: "PUT",
      body: categoryData,
      auth: true,
    }),

  delete: (id) =>
    apiRequest(`/categories/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  reorder: (categories) =>
    apiRequest("/categories/reorder", {
      method: "PUT",
      body: { categories },
      auth: true,
    }),
};

// Donations API calls
export const donationsAPI = {
  getAll: () => apiRequest("/donations"),

  getById: (id) => apiRequest(`/donations/${id}`),

  getByUser: (userId, queryParams = '') =>
    apiRequest(`/donations/user/${userId}${queryParams ? '?' + queryParams : ''}`, {
      auth: true,
    }),

  create: (donationData) =>
    apiRequest("/donations", {
      method: "POST",
      body: donationData,
      auth: true,
    }),

  update: (id, donationData) =>
    apiRequest(`/donations/${id}`, {
      method: "PUT",
      body: donationData,
      auth: true,
    }),

  delete: (id) =>
    apiRequest(`/donations/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  updateStatus: (id, status) =>
    apiRequest(`/donations/${id}`, {
      method: "PATCH",
      body: { status },
      auth: true,
    }),
};

// Admin API calls
export const adminAPI = {
  getStats: () =>
    apiRequest("/admin/stats", {
      auth: true,
    }),

  getUsers: (queryParams = '') =>
    apiRequest(`/admin/users${queryParams ? '?' + queryParams : ''}`, {
      auth: true,
    }),

  createUser: (userData) =>
    apiRequest("/admin/users", {
      method: "POST",
      body: userData,
      auth: true,
    }),

  updateUser: (id, userData) =>
    apiRequest(`/admin/users/${id}`, {
      method: "PUT",
      body: userData,
      auth: true,
    }),

  toggleUserStatus: (id) =>
    apiRequest(`/admin/users/${id}/toggle-status`, {
      method: "PATCH",
      auth: true,
    }),

  changeUserPassword: (id, newPassword) =>
    apiRequest(`/admin/users/${id}/change-password`, {
      method: "PATCH",
      body: { newPassword },
      auth: true,
    }),

  deleteUser: (id) =>
    apiRequest(`/admin/users/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  // SPEC-5 5.2. The ADMIN view, which carries updatedBy/updatedAt; the public
  // `GET /api/branding` deliberately does not, and is fetched without auth.
  getBranding: () =>
    apiRequest("/admin/branding", {
      auth: true,
    }),

  updateBranding: (settings) =>
    apiRequest("/admin/branding", {
      method: "PUT",
      body: settings,
      auth: true,
    }),
};

// Users API calls
export const usersAPI = {
  getProfile: (id) =>
    apiRequest(`/users/${id}`, {
      auth: true,
    }),

  updateProfile: (id, userData) =>
    apiRequest(`/users/${id}`, {
      method: "PUT",
      body: userData,
      auth: true,
    }),
};

// Payment API calls
export const paymentAPI = {
  initiatePayment: (paymentData) =>
    apiRequest("/payment/initiate", {
      method: "POST",
      body: paymentData,
    }),

  checkStatus: (txnid) =>
    apiRequest(`/payment/status/${txnid}`),
};

export default apiRequest;

