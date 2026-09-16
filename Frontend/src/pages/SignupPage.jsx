import React, { useState } from "react";
import { Link } from "react-router-dom";
import Input from "../components/Input";
import Button from "../components/Button";
import Toast from "../components/Toast";
import { validateSignup } from "../utils/validateForm";
import { authAPI } from "../utils/api";
import { useToast } from "../utils/useToast";
import "../styles/LoginPage.css";

function SignupPage({ onSignup }) {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [resendLoading, setResendLoading] = useState(false);
  const { toasts, showToast, hideToast } = useToast();

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validateSignup(form);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }
    setLoading(true);

    try {
      const { data, error, ok, status } = await authAPI.signup(form);
      if (ok && data.email) {
        setOtpSent(true);
        if (data.message.includes("resent")) {
          showToast("We found your account! OTP resent to your email.", "info", 4000);
        } else {
          showToast("OTP sent to your email! Please verify.", "success");
        }
      } else if (status === 400 && error.includes("already exists")) {
        showToast("This email is already registered. Please login instead.", "error", 4000);
        setTimeout(() => {
          window.location.href = "/login";
        }, 2000);
      } else {
        showToast(error || "Signup failed", "error");
      }
    } catch {
      showToast("An unexpected error occurred. Please try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    if (!otp || otp.length !== 6) {
      showToast("Please enter a valid 6-digit OTP", "error");
      return;
    }
    setLoading(true);

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/signup/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // SIGNUP-01: the password the signup was STARTED with. The server
        // requires it so that someone who merely received the code - because
        // anyone can start a signup for any address - cannot complete it. The
        // value was already in state; it was simply never sent.
        body: JSON.stringify({ email: form.email, otp, password: form.password }),
      });

      const data = await response.json();

      if (response.ok && data.token && data.user) {
        localStorage.setItem("token", data.token);
        showToast("Signup successful! Welcome!", "success");
        setTimeout(() => onSignup(data.user._id, data.user.role), 800);
      } else {
        showToast(data.error || "Invalid OTP. Please try again.", "error");
      }
    } catch {
      showToast("An unexpected error occurred. Please try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setResendLoading(true);
    
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/signup/resend-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email }),
      });

      const data = await response.json();

      if (response.ok) {
        showToast("OTP resent successfully!", "success");
      } else {
        showToast(data.error || "Failed to resend OTP", "error");
      }
    } catch {
      showToast("Failed to resend OTP. Please try again.", "error");
    } finally {
      setResendLoading(false);
    }
  };

  const handleBackToSignup = () => {
    setOtpSent(false);
    setOtp("");
  };

  return (
    <div className="box-mrg bg-gradient-to-br from-blue-50 via-white to-blue-50 flex items-center justify-center px-4 sm:px-6 lg:px-8">
      {/* Toast Messages */}
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => hideToast(toast.id)}
        />
      ))}

      <div className="max-w-md w-full">
        {/* Header */}
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img
              src="/images/logo.jpg"
              alt="For Ocean Foundation Logo"
              className="h-20 w-20 rounded-full shadow-lg ring-4 ring-blue-100"
            />
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Create Account
          </h1>
          <p className="text-gray-600 text-lg">
            Join For Ocean Foundation and make a difference
          </p>
        </div>

        {/* Signup Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 space-y-6 border border-gray-100">
          {!otpSent ? (
            /* Signup Form */
            <form className="space-y-6" onSubmit={handleSubmit}>
            {/* Name Input */}
            <div>
              <Input
                type="text"
                name="name"
                placeholder="Enter your full name"
                label="Full Name"
                value={form.name}
                onChange={handleChange}
                fullWidth
                disabled={loading}
                required
              />
            </div>

            {/* Email Input */}
            <div>
              <Input
                type="email"
                name="email"
                placeholder="Enter your email"
                label="Email Address"
                value={form.email}
                onChange={handleChange}
                fullWidth
                disabled={loading}
                required
              />
            </div>

            {/* Password Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  placeholder="Create a strong password"
                  value={form.password}
                  onChange={handleChange}
                  disabled={loading}
                  required
                  className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#05699e] focus:border-transparent outline-none transition-all duration-200"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors duration-200"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Password must be at least 6 characters long
              </p>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={loading}
                disabled={loading}
              >
                {loading ? "Creating Account..." : "Create Account"}
              </Button>
            </div>

            {/* Login Link */}
            <div className="text-center pt-4 border-t border-gray-200">
              <p className="text-gray-600 text-sm">
                Already have an account?{" "}
                <Link
                  to="/login"
                  className="font-medium text-[#05699e] hover:text-[#044d73] transition-colors duration-200"
                >
                  Sign in here
                </Link>
              </p>
            </div>
          </form>
          ) : (
            /* OTP Verification Form */
            <form className="space-y-6" onSubmit={handleOtpSubmit}>
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  Verify Your Email
                </h3>
                <p className="text-gray-600 text-sm">
                  We've sent a 6-digit OTP to<br />
                  <strong className="text-gray-900">{form.email}</strong>
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Enter OTP
                </label>
                <input
                  type="text"
                  value={otp}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
                    setOtp(value);
                  }}
                  placeholder="000000"
                  maxLength={6}
                  className="w-full px-4 py-3 text-center text-2xl font-bold tracking-widest border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#05699e] focus:border-transparent outline-none transition-all duration-200"
                  disabled={loading}
                />
              </div>

              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={loading}
                  disabled={loading || otp.length !== 6}
                >
                  {loading ? "Verifying..." : "Verify & Complete Signup"}
                </Button>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={handleBackToSignup}
                  className="text-sm text-gray-600 hover:text-gray-900 transition-colors duration-200"
                  disabled={loading}
                >
                  ← Back to Signup
                </button>
                <button
                  type="button"
                  onClick={handleResendOtp}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors duration-200 disabled:opacity-50"
                  disabled={loading || resendLoading}
                >
                  {resendLoading ? "Sending..." : "Resend OTP"}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer Links */}
        <div className="text-center">
          <p className="text-gray-500 text-sm">
            By creating an account, you agree to our{" "}
            <Link
              to="/terms"
              className="text-[#05699e] hover:text-[#044d73] font-medium transition-colors duration-200"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              to="/privacy"
              className="text-[#05699e] hover:text-[#044d73] font-medium transition-colors duration-200"
            >
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default SignupPage;
