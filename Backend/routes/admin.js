const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Donation = require("../models/Donation");
const Category = require("../models/Category");
const adminAuth = require("../middleware/adminAuth");
const bcrypt = require("bcryptjs");
const { triggerManualCleanup, cleanupOldDonations, cleanupInactiveUsers } = require("../services/dataCleanupService");

// Protect all admin routes
router.use(adminAuth);

// Escape user input for use in MongoDB regex (BE-HIGH-08)
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get("/stats", async (req, res) => {
  const users = await User.countDocuments();
  const donations = await Donation.countDocuments();
  const categories = await Category.countDocuments();
  const approved = await Donation.countDocuments({ status: "approved" });
  res.json({ users, donations, categories, approved });
});

// View all users with filters and pagination
router.get("/users", async (req, res) => {
  try {
    const {
      search,
      role,
      status,
      joinDateFrom,
      joinDateTo,
      page = 1,
      limit = 10
    } = req.query;

    console.log('GET /admin/users - Query params:', req.query);

    // Build filter query
    const filter = {};

    // Search filter (name, email, or phone) — escaped to prevent ReDoS (BE-HIGH-08)
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
        { phone: { $regex: safe, $options: 'i' } }
      ];
    }

    // Role filter
    if (role) {
      filter.role = role;
    }

    // Status filter (active/disabled)
    if (status) {
      filter.isActive = status === 'active';
    }

    // Join date range filter
    if (joinDateFrom || joinDateTo) {
      filter.createdAt = {};
      if (joinDateFrom) {
        filter.createdAt.$gte = new Date(joinDateFrom);
      }
      if (joinDateTo) {
        // Set to end of day
        const endDate = new Date(joinDateTo);
        endDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endDate;
      }
    }

    console.log('MongoDB filter:', JSON.stringify(filter, null, 2));

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const total = await User.countDocuments(filter);

    // Fetch users with pagination
    const users = await User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    console.log('Found users:', users.length, 'of', total);

    // Return paginated response
    res.json({
      users,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum
      }
    });
  } catch (err) {
    console.error('Error in GET /admin/users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new user (Admin)
router.post("/users", async (req, res) => {
  try {
    const { name, email, password, role, phone, address } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: role || "user",
      phone: phone || "",
      address: address || "",
      isActive: true
    });

    await user.save();

    // Return user without password
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({ message: "User created successfully", user: userResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user (Admin)
router.put("/users/:id", async (req, res) => {
  try {
    const { name, email, role, phone, address } = req.body;

    // Prevent admin from demoting themselves (BE-MED-06)
    if (role && role !== 'admin' && req.user.id === req.params.id) {
      return res.status(400).json({ error: "Cannot demote your own account" });
    }

    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (email !== undefined) updateFields.email = email;
    if (role !== undefined) updateFields.role = role;
    if (phone !== undefined) updateFields.phone = phone;
    if (address !== undefined) updateFields.address = address;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "User updated successfully", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle user active status (Disable/Enable)
router.patch("/users/:id/toggle-status", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Toggle isActive status
    user.isActive = !user.isActive;
    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;

    res.json({
      message: `User ${user.isActive ? 'enabled' : 'disabled'} successfully`,
      user: userResponse
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change user password (Admin)
router.patch("/users/:id/change-password", async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 10) {
      return res.status(400).json({ error: "Password must be at least 6 characters long" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { password: hashedPassword } },
      { new: true }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "Password changed successfully", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user (Admin)
router.delete("/users/:id", async (req, res) => {
  try {
    // Prevent self-deletion (BE-MED-06)
    if (req.user.id === req.params.id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    // Prevent deleting the last admin (BE-MED-06)
    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    if (targetUser.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: "Cannot delete the last admin account" });
      }
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Data Cleanup Endpoints
// ==========================================

/**
 * Trigger manual cleanup of old records
 * Removes all data older than 10 years
 */
router.post("/cleanup/trigger", async (req, res) => {
  try {
    console.log('[Admin API] Manual cleanup triggered by admin');
    
    // Run cleanup in background and return immediately
    triggerManualCleanup().catch(err => {
      console.error('[Admin API] Background cleanup error:', err);
    });

    res.json({ 
      message: "Data cleanup started in background. Check server logs for details.",
      status: "processing"
    });
  } catch (err) {
    console.error('[Admin API] Error triggering cleanup:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get statistics on how many records would be deleted
 * Without actually deleting them (dry run)
 */
router.get("/cleanup/preview", async (req, res) => {
  try {
    const tenYearsAgo = new Date();
    tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);

    // Count old donations
    const oldDonationsCount = await Donation.countDocuments({
      createdAt: { $lt: tenYearsAgo }
    });

    // Count inactive users (no donations, older than 10 years)
    const oldUsers = await User.find({
      createdAt: { $lt: tenYearsAgo },
      role: 'user'
    });

    let inactiveUsersCount = 0;
    for (const user of oldUsers) {
      const donationCount = await Donation.countDocuments({ userId: user._id });
      if (donationCount === 0) {
        inactiveUsersCount++;
      }
    }

    res.json({
      preview: {
        donations: oldDonationsCount,
        users: inactiveUsersCount,
        cutoffDate: tenYearsAgo
      },
      message: `${oldDonationsCount} donation(s) and ${inactiveUsersCount} inactive user(s) would be deleted`,
      note: "This is a preview only. No data has been deleted. Use POST /admin/cleanup/trigger to execute cleanup."
    });
  } catch (err) {
    console.error('[Admin API] Error generating cleanup preview:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
