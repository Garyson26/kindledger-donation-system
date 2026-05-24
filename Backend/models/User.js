const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["user", "admin"], default: "user" },
  phone: { type: String },
  address: { type: String },
  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },
  resetPasswordCode: { type: String },
  resetPasswordExpires: { type: Date },
  loginOTP: { type: String },
  loginOTPExpires: { type: Date },
  loginOTPAttempts: { type: Number, default: 0 },
  resetPasswordAttempts: { type: Number, default: 0 }
}, { timestamps: true });

// Indexes for better query performance
userSchema.index({ email: 1 }, { unique: true }); // Unique email index
userSchema.index({ createdAt: 1, role: 1 }); // For data cleanup queries

module.exports = mongoose.model("User", userSchema);
