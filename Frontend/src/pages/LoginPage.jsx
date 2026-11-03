import { useBranding } from "../branding/BrandingProvider";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import Input from "../components/Input";
import Button from "../components/Button";
import Toast from "../components/Toast";
import { validateLogin } from "../utils/validateForm";
import { authAPI } from "../utils/api";
import { useToast } from "../utils/useToast";
import "../styles/LoginPage.css";

function LoginPage({ onLogin }) {
  const { organisationName } = useBranding();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState("");
  const [resendLoading, setResendLoading] = useState(false);
  const { toasts, showToast, hideToast } = useToast();

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validateLogin(form);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }
    setLoading(true);

    try {
      const { data, error, ok, status } = await authAPI.login(form);

      if (ok && data.requiresOTP) {
        // OTP sent successfully
        setOtpSent(true);
        showToast("OTP sent to your email!", "success");
      } else if (status === 403 && data.needsSignupVerification) {
        // User needs to verify signup first - show helpful message
        showToast(error || "Please verify your email first. We've sent a new OTP.", "warning", 5000);
        // Redirect to signup page after 2 seconds
        setTimeout(() => {
          window.location.href = "/signup";
        }, 2000);
      } else if (ok && data.token && data.user) {
        // Direct login (shouldn't happen with OTP system)
        localStorage.setItem("token", data.token);
        onLogin(data.user._id, data.user.role);
      } else {
        showToast(error || "Login failed", "error");
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
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/login/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email, otp }),
      });

      const data = await response.json();

      if (response.ok && data.token && data.user) {
        localStorage.setItem("token", data.token);
        showToast("Login successful!", "success");
        onLogin(data.user._id, data.user.role);
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
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/login/resend-otp`, {
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

  const handleBackToLogin = () => {
    setOtpSent(false);
    setOtp("");
  };

  return (
    <div className="h-screen box-mrg bg-gradient-to-br from-blue-50 via-white to-blue-50 flex items-center justify-center sm:px-6 lg:px-8">
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

      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img
              src="/images/logo.jpg"
              alt={`${organisationName} logo`}
              className="h-20 w-20 rounded-full shadow-lg ring-4 ring-blue-100"
            />
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Welcome Back
          </h1>
          <p className="text-gray-600 text-lg">
            Sign in to your {organisationName} account
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 space-y-6 border border-gray-100">
          {!otpSent ? (
            /* Email & Password Form */
            <form className="space-y-6" onSubmit={handleSubmit}>
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
              />
            </div>

            {/* Password Input */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-sm font-medium text-[var(--kl-primary)] hover:text-[var(--kl-primary-dark)] transition-colors duration-200"
                >
                  Forgot Password?
                </Link>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  placeholder="Enter your password"
                  value={form.password}
                  onChange={handleChange}
                  disabled={loading}
                  className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent outline-none transition-all duration-200"
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
                {loading ? "Signing In..." : "Sign In"}
              </Button>
            </div>

            {/* Sign Up Link */}
            <div className="text-center pt-4 border-t border-gray-200">
              <p className="text-gray-600 text-sm">
                Don't have an account?{" "}
                <Link
                  to="/signup"
                  className="font-medium text-blue-600 hover:text-blue-700 transition-colors duration-200"
                >
                  Create one here
                </Link>
              </p>
            </div>
          </form>
          ) : (
            /* OTP Verification Form */
            <form className="space-y-6" onSubmit={handleOtpSubmit}>
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
                  <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
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
                  className="w-full px-4 py-3 text-center text-2xl font-bold tracking-widest border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--kl-primary)] focus:border-transparent outline-none transition-all duration-200"
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
                  {loading ? "Verifying..." : "Verify OTP"}
                </Button>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={handleBackToLogin}
                  className="text-sm text-gray-600 hover:text-gray-900 transition-colors duration-200"
                  disabled={loading}
                >
                  ← Back to Login
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
            By signing in, you agree to our{" "}
            <Link
              to="/terms"
              className="text-blue-600 hover:text-blue-700 font-medium transition-colors duration-200"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              to="/privacy"
              className="text-blue-600 hover:text-blue-700 font-medium transition-colors duration-200"
            >
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
