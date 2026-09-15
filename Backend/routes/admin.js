const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Donation = require("../models/Donation");
const Category = require("../models/Category");
// TEMPORARY (ADR-050, deleted in package 3.6). `Category` now lives in MySQL;
// this file is not migrated until a later package, so category reads go through
// the bridge, which tries MySQL first and falls back to MongoDB with a warning.
const categoryBridge = require("../services/categoryBridge");

const adminAuth = require("../middleware/adminAuth");
const bcrypt = require("bcryptjs");
// services/dataCleanupService.js is DELETED (package 3.3). It targeted MongoDB,
// and services/scheduler.js implements the same three retention rules against
// MySQL with a dry-run mode and counts that come back to the caller.
const scheduler = require("../services/scheduler");
const { failed } = require("../utils/respond");

// Protect all admin routes
router.use(adminAuth);

// Escape user input for use in MongoDB regex (BE-HIGH-08)
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get("/stats", async (req, res) => {
  const users = await User.countDocuments();
  const donations = await Donation.countDocuments();
  // Via the bridge (ADR-050). Note this now counts ACTIVE categories only,
  // because ADR-004 made deletion a soft delete - an archived category is gone
  // as far as an admin is concerned, which is what this tile reports.
  const categories = await categoryBridge.countCategories();
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
 * Run the retention cleanup. BUG-10, all three defects.
 *
 * WAS: one authenticated POST with an empty body started an irreversible bulk
 * delete of donations and accounts. It returned 200 immediately and deleted in
 * the BACKGROUND - `triggerManualCleanup().catch(...)` was never awaited - so
 * the caller was told "started" and never learned the outcome, and the response
 * said to go and read the server logs. Both underlying functions returned 0
 * from their catch blocks, which made a partial delete and a clean no-op
 * indistinguishable to every caller INCLUDING that log line. The one operation
 * in this system that destroys donor records had the weakest feedback of any
 * endpoint in it.
 *
 * NOW:
 *
 *   1. THE DRY RUN IS THE DEFAULT. A real delete requires `?confirm=delete`
 *      explicitly. There was a GET /cleanup/preview, but nothing required it to
 *      be called first and nothing tied a trigger to a preview anyone had read.
 *   2. IT IS AWAITED, and the counts come back in the response. A caller learns
 *      what happened from the answer to their own request.
 *   3. A FAILURE IS A FAILURE. No catch returns 0. If the purge throws, this
 *      answers 500 and says so, because "deleted: 0" must mean nothing needed
 *      deleting and never "something went wrong on the way".
 */
router.post("/cleanup/trigger", async (req, res) => {
  const dryRun = req.query.confirm !== "delete";
  try {
    const donationsResult = await scheduler.purgeOldDonations({ dryRun });
    const usersResult = await scheduler.purgeInactiveUsers({ dryRun });

    res.json({
      dryRun,
      donations: donationsResult,
      users: usersResult,
      message: dryRun
        ? "DRY RUN - nothing was deleted. Re-send with ?confirm=delete to execute."
        : `Deleted ${donationsResult.deleted} donation(s) and ${usersResult.deleted} inactive account(s).`,
    });
  } catch (err) {
    return failed(res, "Cleanup failed - rows may have been partially deleted", err, {
      tag: "admin",
    });
  }
});

/**
 * What the cleanup WOULD delete.
 *
 * The preview and the trigger now run THE SAME CODE with `dryRun` flipped,
 * which is the only way the preview can be trusted to describe the delete. The
 * old pair reimplemented the retention rules separately - the preview counted
 * old users with a loop over `countDocuments` per user, the trigger did its own
 * version - so the two could disagree about what was about to be destroyed and
 * nobody would find out until afterwards.
 *
 * It also reports IMPLAUSIBLE DATES (AG1a), which are excluded from the purge
 * rather than deleted. A row dated 1970 sits inside a ten-year window; the
 * floor keeps it, and this is where an admin learns it exists.
 */
router.get("/cleanup/preview", async (req, res) => {
  try {
    const donationsResult = await scheduler.purgeOldDonations({ dryRun: true });
    const usersResult = await scheduler.purgeInactiveUsers({ dryRun: true });

    res.json({
      preview: {
        donations: donationsResult.candidates,
        users: usersResult.candidates,
        implausibleDates: donationsResult.implausible,
        cutoffDate: donationsResult.cutoff,
        plausibleFloor: donationsResult.floor,
      },
      message:
        `${donationsResult.candidates} donation(s) and ${usersResult.candidates} ` +
        "inactive account(s) would be deleted",
      note:
        "Preview only - nothing has been deleted. POST /admin/cleanup/trigger?confirm=delete " +
        "executes it; without that parameter the trigger is a dry run too.",
    });
  } catch (err) {
    return failed(res, "Could not generate the cleanup preview", err, { tag: "admin" });
  }
});

module.exports = router;

