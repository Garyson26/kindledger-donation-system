const express = require("express");
// BUG-11: one refusal shape. See Backend/utils/respond.js.
const { refuse, failed } = require("../utils/respond");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const PendingSignup = require("../models/PendingSignup");
const authMiddleware = require("../middleware/authMiddleware");
const { JWT_SECRET } = require("../config/jwt");
const { sendVerificationEmail, sendLoginOTP, sendSignupOTP } = require("../config/email");

// Helper function to generate cryptographically secure 6-digit OTP (BE-HIGH-02)
const generateVerificationCode = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

// Rate limiter for auth endpoints (BE-HIGH-03)
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

// Signup - Step 1: Register user and send OTP
router.post("/signup", authLimiter, async (req, res) => {
  try {
    const { name, email, password, role, adminKey } = req.body;

    // Check if user already exists in main database (verified users)
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this email. Please login instead." });
    }

    // Check if there's a pending signup for this email
    let pendingSignup = await PendingSignup.findOne({ email });

    // Prevent open admin creation: only accept role='admin' when adminKey matches
    let assignedRole = 'user';
    if (role === 'admin') {
      if (process.env.ADMIN_CREATION_KEY && adminKey === process.env.ADMIN_CREATION_KEY) {
        assignedRole = 'admin';
      } else {
        return res.status(403).json({ error: 'Admin creation requires a valid adminKey' });
      }
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpiry = new Date();
    otpExpiry.setMinutes(otpExpiry.getMinutes() + 10); // 10 minutes expiry

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    if (pendingSignup) {
      // Update existing pending signup
      pendingSignup.name = name;
      pendingSignup.password = hashedPassword;
      pendingSignup.role = assignedRole;
      pendingSignup.signupOTP = otp;
      pendingSignup.signupOTPExpires = otpExpiry;
      await pendingSignup.save();

      // Send OTP email
      const emailResult = await sendSignupOTP(email, otp, name);
      
      if (!emailResult.success) {
        return res.status(500).json({ error: "Failed to send verification email. Please try again." });
      }

      return res.json({ 
        message: "OTP resent. Please check your email for verification.", 
        email: email
      });
    }

    // Create new pending signup
    pendingSignup = new PendingSignup({ 
      name, 
      email, 
      password: hashedPassword, 
      role: assignedRole,
      signupOTP: otp,
      signupOTPExpires: otpExpiry
    });
    await pendingSignup.save();

    // Send OTP email
    const emailResult = await sendSignupOTP(email, otp, name);
    
    if (!emailResult.success) {
      // Rollback: delete the pending signup if email fails
      await PendingSignup.findByIdAndDelete(pendingSignup._id);
      return res.status(500).json({ error: "Failed to send verification email. Please try again." });
    }

    res.json({ 
      message: "Registration initiated. Please check your email for OTP verification.", 
      email: email
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Signup - Step 2: Verify OTP and Create User
router.post("/signup/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    // Find pending signup
    const pendingSignup = await PendingSignup.findOne({ email });
    if (!pendingSignup) {
      return res.status(404).json({ error: "No pending signup found. Please signup again." });
    }

    // Check OTP
    if (!pendingSignup.signupOTP || pendingSignup.signupOTP !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Check expiry
    if (new Date() > pendingSignup.signupOTPExpires) {
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    // OTP is valid - Create actual user in database
    const newUser = new User({
      name: pendingSignup.name,
      email: pendingSignup.email,
      password: pendingSignup.password,
      role: pendingSignup.role,
      isVerified: true // User is verified now
    });
    await newUser.save();

    // Delete pending signup
    await PendingSignup.findByIdAndDelete(pendingSignup._id);

    // Generate token
    const token = jwt.sign({ userId: newUser._id, role: newUser.role }, JWT_SECRET, { expiresIn: "1h" });

    res.json({ 
      message: "Email verified successfully. Account created!", 
      token, 
      user: { _id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role } 
    });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Resend Signup OTP
router.post("/signup/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Find pending signup
    const pendingSignup = await PendingSignup.findOne({ email });
    if (!pendingSignup) {
      return res.status(404).json({ error: "No pending signup found. Please signup again." });
    }

    // Generate new OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpiry = new Date();
    otpExpiry.setMinutes(otpExpiry.getMinutes() + 10);

    pendingSignup.signupOTP = otp;
    pendingSignup.signupOTPExpires = otpExpiry;
    await pendingSignup.save();

    // Send OTP email
    const emailResult = await sendSignupOTP(email, otp, pendingSignup.name);
    
    if (!emailResult.success) {
      return res.status(500).json({ error: "Failed to send verification email. Please try again." });
    }

    res.json({ message: "OTP resent successfully" });
  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Login - Step 1: Verify credentials and send OTP
router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    // Check if there's a pending signup for this email (not yet verified)
    const pendingSignup = await PendingSignup.findOne({ email });
    if (pendingSignup) {
      // Verify password to ensure it's the right user
      const isMatch = await bcrypt.compare(password, pendingSignup.password);
      if (isMatch) {
        // Resend signup OTP
        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpExpiry = new Date();
        otpExpiry.setMinutes(otpExpiry.getMinutes() + 10);

        pendingSignup.signupOTP = otp;
        pendingSignup.signupOTPExpires = otpExpiry;
        await pendingSignup.save();

        // Send OTP email
        await sendSignupOTP(email, otp, pendingSignup.name);

        return res.status(403).json({ 
          error: "Your email is not verified yet. We've sent a new OTP to complete your signup.",
          needsSignupVerification: true,
          email: email
        });
      } else {
        return res.status(400).json({ error: "Invalid credentials" });
      }
    }

    // Check for verified user
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // For backward compatibility: auto-verify existing users
    // (users created before OTP system was implemented)
    if (!user.isVerified) {
      user.isVerified = true;
      await user.save();
    }

    // Generate 6-digit login OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpiry = new Date();
    otpExpiry.setMinutes(otpExpiry.getMinutes() + 10); // 10 minutes expiry

    // Save OTP to user
    user.loginOTP = otp;
    user.loginOTPExpires = otpExpiry;
    await user.save();

    // Send OTP email
    const emailResult = await sendLoginOTP(email, otp, user.name);
    
    if (!emailResult.success) {
      return res.status(500).json({ error: "Failed to send OTP email. Please try again." });
    }

    res.json({ 
      message: "OTP sent to your email", 
      email: email,
      requiresOTP: true 
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Login - Step 2: Verify OTP and complete login
router.post("/login/verify-otp", authLimiter, async (req, res) => {
  const { email, otp } = req.body;
  try {
    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // Enforce OTP attempt limit (BE-HIGH-02)
    if ((user.loginOTPAttempts || 0) >= 5) {
      user.loginOTP = undefined;
      user.loginOTPExpires = undefined;
      user.loginOTPAttempts = 0;
      await user.save();
      return res.status(429).json({ error: 'Too many attempts. Please request a new OTP.' });
    }

    // Check OTP
    if (!user.loginOTP || user.loginOTP !== otp) {
      user.loginOTPAttempts = (user.loginOTPAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // Check expiry
    if (new Date() > user.loginOTPExpires) {
      return res.status(400).json({ error: "OTP has expired. Please login again." });
    }

    // Clear OTP and attempts
    user.loginOTP = undefined;
    user.loginOTPExpires = undefined;
    user.loginOTPAttempts = 0;
    await user.save();

    // Generate token
    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: "1h" });
    
    res.json({ 
      message: "Login successful", 
      token, 
      user: { _id: user._id, name: user.name, email: user.email, role: user.role } 
    });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ error: "An error occurred. Please try again." });
  }
});

// Resend Login OTP
router.post("/login/resend-otp", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate new OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpExpiry = new Date();
    otpExpiry.setMinutes(otpExpiry.getMinutes() + 10);

    user.loginOTP = otp;
    user.loginOTPExpires = otpExpiry;
    await user.save();

    // Send OTP email
    const emailResult = await sendLoginOTP(email, otp, user.name);
    
    if (!emailResult.success) {
      return res.status(500).json({ error: "Failed to send OTP email. Please try again." });
    }

    res.json({ message: "OTP resent successfully" });
  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Request Password Reset (sends verification code to email)
// Generic response regardless of email existence to prevent user enumeration (BE-HIGH-06)
router.post("/forgot-password/request", authLimiter, async (req, res) => {
  const { email } = req.body;

  try {
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email });
    if (user) {
      // Generate 6-digit verification code
      const verificationCode = generateVerificationCode();

      // Set expiry to 15 minutes from now
      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 15);

      user.resetPasswordCode = verificationCode;
      user.resetPasswordExpires = expiryTime;
      user.resetPasswordAttempts = 0;
      await user.save();

      // Fire-and-forget — don't let email errors reveal user existence
      sendVerificationEmail(email, verificationCode, user.name).catch(err => {
        console.error("Forgot-password email error:", err.message);
      });
    }

    // Always return the same response (BE-HIGH-06)
    res.json({
      message: "If an account exists for this email, a verification code has been sent.",
      email: email
    });
  } catch (err) {
    console.error("Forgot password request error:", err);
    res.status(500).json({ error: "An error occurred. Please try again." });
  }
});

// Verify Code
// SEC-02: rate limited, and every wrong code is counted. Without both, the
// 6-digit code is brute-forceable inside its 15-minute window.
router.post("/forgot-password/verify", authLimiter, async (req, res) => {
  const { email, code } = req.body;

  try {
    if (!email || !code) {
      return res.status(400).json({ error: "Email and verification code are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if code exists and hasn't expired
    if (!user.resetPasswordCode || !user.resetPasswordExpires) {
      return res.status(400).json({ error: "No verification code found. Please request a new one." });
    }

    // SEC-02: enforce the attempt cap, mirroring loginOTPAttempts above.
    // resetPasswordAttempts already existed in the schema and was written but
    // never read, so the control was designed and left unwired.
    if ((user.resetPasswordAttempts || 0) >= 5) {
      user.resetPasswordCode = undefined;
      user.resetPasswordExpires = undefined;
      user.resetPasswordAttempts = 0;
      await user.save();
      return res.status(429).json({ error: "Too many attempts. Please request a new code." });
    }

    if (new Date() > user.resetPasswordExpires) {
      return res.status(400).json({ error: "Verification code has expired. Please request a new one." });
    }

    if (user.resetPasswordCode !== code) {
      user.resetPasswordAttempts = (user.resetPasswordAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ error: "Invalid verification code" });
    }

    // Code is valid. The attempt counter is deliberately NOT reset here: this
    // endpoint only checks the code, and /forgot-password/reset still has to
    // accept it. Clearing the count on a correct guess would hand an attacker
    // a fresh budget of 5 for every lucky hit.
    res.json({
      message: "Verification successful",
      verified: true
    });
  } catch (err) {
    console.error("Verify code error:", err);
    res.status(500).json({ error: "An error occurred. Please try again." });
  }
});

// Reset Password (after verification)
// SEC-02: this is the endpoint that actually changes the password, so it needs
// the limiter and the attempt cap more than /verify does - an attacker can
// skip /verify entirely and brute-force here.
router.post("/forgot-password/reset", authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (newPassword.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters long" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // SEC-02: enforce the attempt cap before checking the code, and void the
    // code once it is exhausted so a fresh request is required.
    if ((user.resetPasswordAttempts || 0) >= 5) {
      user.resetPasswordCode = undefined;
      user.resetPasswordExpires = undefined;
      user.resetPasswordAttempts = 0;
      await user.save();
      return res.status(429).json({ error: "Too many attempts. Please request a new code." });
    }

    // Verify code one more time
    if (!user.resetPasswordCode || user.resetPasswordCode !== code) {
      user.resetPasswordAttempts = (user.resetPasswordAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (new Date() > user.resetPasswordExpires) {
      return res.status(400).json({ error: "Verification code has expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset fields. The attempt counter is reset
    // only here, on a successful password change.
    user.password = hashedPassword;
    user.resetPasswordCode = undefined;
    user.resetPasswordExpires = undefined;
    user.resetPasswordAttempts = 0;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "An error occurred. Please try again." });
  }
});

// Change Password
router.post("/change-password", authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return refuse(res, 404, "User not found");

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return refuse(res, 400, "Invalid old password");

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();
    // `msg` is kept ONLY on this success response: ChangePassword.jsx:26
    // reads `data.msg`. Its error path already goes through the api
    // wrapper, which reads `error || message`, so refusals are safe to
    // change. Phase 5 drops this alias with the rest.
    res.json({ msg: "Password changed successfully", message: "Password changed successfully" });
  } catch (err) {
    // SEC-19: this was `msg: err.message`, returning the raw error text.
    failed(res, "Could not change the password", err, { tag: "auth" });
  }
});

// Get current user profile
router.get("/me", async (req, res) => {
  const token = req.headers["authorization"];
  if (!token) return refuse(res, 401, "No token provided");

  try {
    const decoded = jwt.verify(token.replace("Bearer ", ""), JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) return refuse(res, 404, "User not found");

    // SEC-09: was `console.log("User found:", user)`, which wrote the whole
    // user document - name, email, phone, address - to the application log on
    // every profile load.

    res.json({
      _id: user._id,
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || "",
      address: user.address || "",
      role: user.role || "user"
    });
  } catch (err) {
    console.error("JWT verification error:", err); // Debug log
    refuse(res, 401, "Invalid token");
  }
});

module.exports = router;
