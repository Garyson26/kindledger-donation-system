import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { validateDonation } from "../utils/validateForm";
import { categoriesAPI, paymentAPI } from "../utils/api";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";
import { API_BASE_URL } from "../config/constants";

function DonationForm() {
  const location = useLocation();
  const navigate = useNavigate();
  const { toasts, showToast, hideToast } = useToast();
  const [form, setForm] = useState({ category: "", quantity: 1 });
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userInfo, setUserInfo] = useState({ userId: '', name: '', email: '', phone: '' });
  const [processing, setProcessing] = useState(false);
  const [additionalAmount, setAdditionalAmount] = useState(0);
  const [guestInfo, setGuestInfo] = useState({ name: '', email: '', phone: '' });

  useEffect(() => {
    // Check if user is logged in
    const token = localStorage.getItem("token");
    setIsAuthenticated(!!token);

    // Fetch user info if logged in
    if (token) {
      fetch(`${API_BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(async res => {
          // Handle 401 Unauthorized - invalid/expired token
          if (res.status === 401) {
            console.warn('Invalid or expired token. Redirecting to login...');
            localStorage.removeItem("token");
            localStorage.removeItem("user");
            localStorage.removeItem("userId");
            localStorage.removeItem("userRole");
            window.location.href = "/login";
            throw new Error("Unauthorized");
          }

          if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
          }

          return res.json();
        })
        .then(data => {
          if (data.name || data.email) {
            setUserInfo({
              userId: data._id || '',
              name: data.name || '',
              email: data.email || '',
              phone: data.phone || ''
            });
          }
        })
        .catch(err => {
          if (err.message === 'Unauthorized') return; // Already handled
          console.error("Error fetching user info:", err);
        });
    }

    const fetchCategories = async () => {
      const { data, ok } = await categoriesAPI.getAll();
      if (ok) {
        setCategories(data);

        // Pre-select category from navigation state
        if (location.state?.category) {
          const preSelectedCategory = location.state.category;
          setForm(prev => ({ ...prev, category: preSelectedCategory._id }));
          setSelectedCategory(preSelectedCategory);
        }
      } else {
        setCategories([]);
      }
    };
    fetchCategories();
  }, [location.state]);

  const handleChange = (e) => {
    const val = e.target.name === "quantity" ? Number(e.target.value) : e.target.value;
    setForm({ ...form, [e.target.name]: val });

    // Update selected category when dropdown changes
    if (e.target.name === "category") {
      const cat = categories.find(c => c._id === val);
      setSelectedCategory(cat);
    }
  };

  const handleGuestInfoChange = (e) => {
    setGuestInfo({ ...guestInfo, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validateDonation(form, categories);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }

    // Check if category has donation amount
    if (!selectedCategory?.donationAmount) {
      showToast("Selected category does not have a donation amount set", "error");
      return;
    }

    // Validate guest user information if not authenticated
    if (!isAuthenticated) {
      if (!guestInfo.name || !guestInfo.email || !guestInfo.phone) {
        showToast("Please fill in your name, email, and phone number", "error");
        return;
      }
      // Basic email validation
      if (!guestInfo.email.includes("@")) {
        showToast("Please enter a valid email address", "error");
        return;
      }
      // Basic phone validation
      if (guestInfo.phone.length < 10) {
        showToast("Please enter a valid phone number", "error");
        return;
      }
    }

    setProcessing(true);

    try {
      // Calculate total amount (base amount from category + additional amount)
      const baseAmount = selectedCategory.donationAmount * form.quantity;
      const totalAmount = baseAmount + parseFloat(additionalAmount || 0);

      // Get user info for payment
      let firstname, email, phone;

      if (isAuthenticated) {
        firstname = userInfo.name || "Guest";
        email = userInfo.email;
        phone = userInfo.phone;
      } else {
        // Use guest info from form fields
        firstname = guestInfo.name;
        email = guestInfo.email;
        phone = guestInfo.phone;
      }

      // Initiate payment with PayU
      const paymentData = {
        amount: totalAmount,
        baseAmount: baseAmount,
        extraAmount: parseFloat(additionalAmount || 0),
        firstname: firstname,
        email: email,
        phone: phone,
        productinfo: `Donation - ${selectedCategory.name}`,
        category: form.category,
        quantity: form.quantity
      };

      // Add userId if user is authenticated
      if (isAuthenticated && userInfo.userId) {
        paymentData.userId = userInfo.userId;
      }

      const { data, ok, error } = await paymentAPI.initiatePayment(paymentData);

      if (!ok) {
        showToast(error || "Failed to initiate payment", "error");
        setProcessing(false);
        return;
      }

      // Create a form and submit to PayU
      const payuForm = document.createElement('form');
      payuForm.method = 'POST';
      payuForm.action = data.payuUrl;

      // Add all PayU parameters as hidden fields
      Object.keys(data.paymentData).forEach(key => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = data.paymentData[key];
        payuForm.appendChild(input);
      });

      document.body.appendChild(payuForm);
      payuForm.submit();

    } catch (err) {
      console.error("Payment initiation error:", err);
      showToast("Failed to initiate payment", "error");
      setProcessing(false);
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

      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">Make a Donation</h1>
          <p className="text-gray-600 text-center">Your contribution makes a difference!</p>
        </div>

        {/* Guest/Login Info Banner */}
        {!isAuthenticated && (
          <div className="mb-6 bg-[#05699e]/10 rounded-lg border border-[#05699e]/30 p-6">
            <div className="flex items-start gap-4">
              <svg className="w-5 h-5 flex-shrink-0 mt-1 text-[#05699e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <h3 className="font-semibold text-lg text-gray-900 mb-2">Donating as Guest</h3>
                <p className="text-gray-600 mb-4">
                  You can donate without an account, but you won't be able to track your donation history.
                </p>
                <div className="flex gap-3 flex-wrap">
                  <button
                    onClick={() => navigate("/login", { state: { from: "/donate", category: selectedCategory } })}
                    className="px-4 py-2 bg-[#05699e] hover:bg-[#044d73] text-white font-medium rounded-lg transition-colors duration-200"
                  >
                    Login
                  </button>
                  <button
                    onClick={() => navigate("/signup", { state: { from: "/donate", category: selectedCategory } })}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors duration-200"
                  >
                    Sign Up
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Logged in user info */}
        {isAuthenticated && (
          <div className="mb-6 bg-green-50 rounded-lg border border-green-200 p-4 flex items-center gap-3">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="font-medium text-gray-900">
              You're logged in! Your donation will be saved to your history.
            </p>
          </div>
        )}

        {/* Selected Category Info */}
        {selectedCategory && (
          <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">{selectedCategory.name}</h3>
                {selectedCategory.sortDescription && (
                  <p className="text-gray-600 mb-3">{selectedCategory.sortDescription}</p>
                )}
                {selectedCategory.donationAmount && (
                  <div className="inline-flex items-center bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-semibold border border-blue-600">
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    ₹{selectedCategory.donationAmount.toLocaleString('en-IN')} per donation
                  </div>
                )}
              </div>
              <button
                onClick={() => navigate("/categories")}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Donation Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="space-y-5">
            {/* Category Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category <span className="text-red-600">*</span>
              </label>
              <select
                name="category"
                value={form.category}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              >
                <option value="">Select a category</option>
                {categories.map(c => (
                  <option key={c._id} value={c._id}>
                    {c.name} {c.donationAmount ? `- ₹${c.donationAmount.toLocaleString('en-IN')}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Quantity */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quantity <span className="text-red-600">*</span>
              </label>
              <input
                type="number"
                name="quantity"
                min="1"
                value={form.quantity}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            {/* Guest User Information - Only shown when not authenticated */}
            {!isAuthenticated && (
              <div className="bg-amber-50 rounded-lg p-6 border border-amber-200">
                <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Your Contact Information
                </h3>
                <p className="text-sm text-gray-600 mb-4">
                  Please provide your details for payment and receipt
                </p>

                <div className="space-y-4">
                  {/* Guest Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Full Name <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={guestInfo.name}
                      onChange={handleGuestInfoChange}
                      placeholder="Enter your full name"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      required={!isAuthenticated}
                    />
                  </div>

                  {/* Guest Email */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email Address <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="email"
                      name="email"
                      value={guestInfo.email}
                      onChange={handleGuestInfoChange}
                      placeholder="your.email@example.com"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      required={!isAuthenticated}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      We'll send payment receipt to this email
                    </p>
                  </div>

                  {/* Guest Phone */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Number <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="tel"
                      name="phone"
                      value={guestInfo.phone}
                      onChange={handleGuestInfoChange}
                      placeholder="10-digit mobile number"
                      pattern="[0-9]{10}"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      required={!isAuthenticated}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Required for payment verification
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Additional Amount (Optional) */}
            {selectedCategory?.donationAmount && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Add Extra Amount (Optional)
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-500 font-semibold">₹</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={additionalAmount}
                    onChange={(e) => setAdditionalAmount(parseFloat(e.target.value) || 0)}
                    placeholder="0"
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  Want to contribute more? Add any amount you wish to donate additionally.
                </p>

                {/* Quick Amount Buttons */}
                <div className="flex gap-2 mt-3 flex-wrap">
                  <span className="text-xs text-gray-600 font-medium w-full mb-1">Quick add:</span>
                  {[1000, 10000, 30000, 50000, 100000].map(amount => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => setAdditionalAmount(parseFloat(additionalAmount || 0) + amount)}
                      className="px-3 py-1.5 bg-green-100 hover:bg-green-200 text-green-700 font-medium rounded-lg text-sm transition-colors duration-200"
                    >
                      +₹{amount.toLocaleString('en-IN')}
                    </button>
                  ))}
                  {additionalAmount > 0 && (
                    <button
                      type="button"
                      onClick={() => setAdditionalAmount(0)}
                      className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 font-medium rounded-lg text-sm transition-colors duration-200"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Total Amount Display */}
            {selectedCategory?.donationAmount && (
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-gray-700 font-medium">Base Amount:</span>
                  <span className="text-xl font-bold text-gray-900">
                    ₹{(selectedCategory.donationAmount * form.quantity).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                {additionalAmount > 0 && (
                  <div className="flex justify-between items-center mb-2 pb-2 border-b border-blue-300">
                    <span className="text-gray-700 font-medium">Additional Amount:</span>
                    <span className="text-xl font-bold text-green-600">
                      +₹{parseFloat(additionalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-gray-900 font-bold text-lg">Total Donation Amount:</span>
                  <span className="text-3xl font-bold text-[#05699e]">
                    ₹{(selectedCategory.donationAmount * form.quantity + parseFloat(additionalAmount || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-2">
                  {form.quantity} × ₹{selectedCategory.donationAmount.toLocaleString('en-IN')}
                  {additionalAmount > 0 && ` + ₹${parseFloat(additionalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} extra`}
                  {' '}= ₹{(selectedCategory.donationAmount * form.quantity + parseFloat(additionalAmount || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex gap-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => navigate("/categories")}
                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors duration-200"
              >
                Back to Categories
              </button>
              <button
                type="submit"
                disabled={processing}
                className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors duration-200 ${processing ? 'opacity-75 cursor-not-allowed' : ''}`}
              >
                {processing ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    Processing...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    Proceed to Payment
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Help Text */}
        <div className="mt-6 text-center">
          <p className="text-sm text-gray-600">
            Your donation will be reviewed by our admin team. You'll receive a confirmation once approved.
          </p>
        </div>
      </div>
    </div>
  );
}

export default DonationForm;
