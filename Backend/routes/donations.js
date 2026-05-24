const express = require("express");
const router = express.Router();
const Donation = require("../models/Donation");
const adminAuth = require("../middleware/adminAuth");
const authMiddleware = require("../middleware/authMiddleware");

// Optional auth middleware - allows both authenticated and guest users
const optionalAuth = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) {
    // No token, continue as guest
    return next();
  }

  // Token exists, try to authenticate
  authMiddleware(req, res, next);
};

// Create Donation (with optional authentication)
router.post("/", optionalAuth, async (req, res) => {
  try {
    const { item, category, quantity } = req.body;

    if (!item || !category) {
      return res.status(400).json({ error: "Item and category are required" });
    }

    const donationData = {
      donorName: req.user?.name || "Guest Donor",
      item,
      category,
      quantity: quantity || 1
    };

    // Only add userId if user is authenticated
    if (req.user && req.user.id) {
      donationData.userId = req.user.id;
    }

    const donation = new Donation(donationData);

    await donation.save();
    res.json({
      message: req.user ? "Donation added successfully" : "Donation submitted successfully. Thank you for your contribution!",
      donation
    });
  } catch (err) {
    console.error("Create donation error:", err);
    // Mongoose validation errors
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message).join(', ');
      return res.status(400).json({ error: `Donation validation failed: ${messages}` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get All Donations with dynamic filtering and pagination (admin only)
router.get("/", adminAuth, async (req, res) => {
  try {
    const {
      userType,        // 'all', 'registered', 'guest'
      paymentStatus,   // 'all', 'Paid', 'Pending', 'Failed', 'Cancelled'
      searchQuery,     // search in name or email
      dateFrom,        // YYYY-MM-DD
      dateTo,          // YYYY-MM-DD
      page = 1,        // Page number (default: 1)
      limit = 10       // Items per page (default: 10)
    } = req.query;

    // Build dynamic filter object
    let filter = {};

    // User Type Filter
    if (userType && userType !== 'all') {
      if (userType === 'registered') {
        filter.userId = { $ne: null };
      } else if (userType === 'guest') {
        filter.userId = null;
      }
    }

    // Payment Status Filter
    if (paymentStatus && paymentStatus !== 'all') {
      filter.paymentStatus = paymentStatus;
    }

    // Date Range Filter
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) {
        filter.date.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999); // End of day
        filter.date.$lte = toDate;
      }
    }

    // Add search filter directly into MongoDB query (BE-MED-01)
    if (searchQuery && searchQuery.trim()) {
      const safe = searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { donorName: { $regex: safe, $options: 'i' } },
        { donorEmail: { $regex: safe, $options: 'i' } },
      ];
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // MongoDB-side count and pagination — no full-collection load (BE-MED-01)
    const total = await Donation.countDocuments(filter);
    const donations = await Donation.find(filter)
      .populate("category")
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    // Return paginated response
    res.json({
      donations,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch donations" });
  }
});

// Get Filter Options - Returns unique values for filters (admin only)
// Uses aggregation to avoid loading entire collection (BE-MED-01)
router.get("/filter-options", adminAuth, async (req, res) => {
  try {
    const [statusAgg, dateAgg, countAgg] = await Promise.all([
      Donation.distinct("paymentStatus"),
      Donation.aggregate([
        { $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } }
      ]),
      Donation.aggregate([
        { $group: { _id: "$paymentStatus", count: { $sum: 1 } } }
      ]),
    ]);

    const registeredCount = await Donation.countDocuments({ userId: { $ne: null } });
    const guestCount = await Donation.countDocuments({ userId: null });
    const total = registeredCount + guestCount;

    const userTypes = [];
    if (registeredCount > 0) userTypes.push('registered');
    if (guestCount > 0) userTypes.push('guest');

    const byStatus = {};
    countAgg.forEach(({ _id, count }) => { if (_id) byStatus[_id] = count; });

    const dateRange = dateAgg[0] || { min: null, max: null };

    res.json({
      paymentStatuses: statusAgg.filter(Boolean),
      userTypes,
      dateRange: {
        min: dateRange.min ? new Date(dateRange.min).toISOString().split('T')[0] : null,
        max: dateRange.max ? new Date(dateRange.max).toISOString().split('T')[0] : null,
      },
      counts: { total, registered: registeredCount, guest: guestCount, byStatus },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch filter options" });
  }
});

// Get Donations by User with filtering and pagination
router.get("/user/:userId", authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    const {
      category,    // Category ID filter
      dateFrom,    // YYYY-MM-DD
      dateTo,      // YYYY-MM-DD
      page = 1,    // Page number (default: 1)
      limit = 10   // Items per page (default: 10)
    } = req.query;

    // Build filter object
    let filter = { userId: req.params.userId };

    // Category Filter
    if (category && category !== 'all') {
      filter.category = category;
    }

    // Date Range Filter
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) {
        filter.date.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999); // End of day
        filter.date.$lte = toDate;
      }
    }

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const total = await Donation.countDocuments(filter);

    // Execute query with filters, pagination, and sort by createdAt descending
    const donations = await Donation.find(filter)
      .populate("category")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      donations,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Donation Status (admin only)
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const donation = await Donation.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    res.json({ message: "Donation updated", donation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get Single Donation Details (auth required; owner or admin)
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const donation = await Donation.findById(req.params.id)
      .populate("category", "name description price")
      .populate("userId", "name email");

    if (!donation) {
      return res.status(404).json({ error: "Donation not found" });
    }

    const ownerId = donation.userId?._id?.toString() || null;
    const isOwner = ownerId && ownerId === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(donation);
  } catch (err) {
    console.error("Error fetching donation details:", err);
    res.status(500).json({ error: "Failed to fetch donation" });
  }
});

// Admin: Approve/Reject donation
router.patch("/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body; 
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }
  try {
    const donation = await Donation.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!donation) return res.status(404).json({ message: "Donation not found" });
    res.json(donation);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Get Donation Statistics for Charts
router.get("/stats/charts", adminAuth, async (req, res) => {
  try {
    const {
      period,      // 'monthly', 'yearly', 'custom'
      dateFrom,    // For custom range
      dateTo,      // For custom range
      year,        // For yearly view
      month        // For monthly view (format: YYYY-MM)
    } = req.query;

    let startDate, endDate;
    const now = new Date();

    // Determine date range based on period
    if (period === 'monthly') {
      // Current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (period === 'yearly') {
      // Current year or specified year
      const targetYear = year ? parseInt(year) : now.getFullYear();
      startDate = new Date(targetYear, 0, 1);
      endDate = new Date(targetYear, 11, 31, 23, 59, 59, 999);
    } else if (period === 'custom' && dateFrom && dateTo) {
      startDate = new Date(dateFrom);
      endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Default to current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    // Get donations within date range
    const donations = await Donation.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate("category").sort({ date: -1 });

    // Calculate statistics
    const stats = {
      totalDonations: donations.length,
      totalAmount: donations.reduce((sum, d) => sum + (d.amount || 0), 0),
      paidAmount: donations.filter(d => d.paymentStatus === 'Paid').reduce((sum, d) => sum + (d.amount || 0), 0),
      pendingAmount: donations.filter(d => d.paymentStatus === 'Pending').reduce((sum, d) => sum + (d.amount || 0), 0),
      registeredUsers: donations.filter(d => d.userId).length,
      guestUsers: donations.filter(d => !d.userId).length,
      byStatus: {},
      byCategory: {},
      timeline: []
    };

    // Group by payment status
    donations.forEach(d => {
      const status = d.paymentStatus || 'Unknown';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    });

    // Group by category
    donations.forEach(d => {
      const categoryName = d.category?.name || 'Uncategorized';
      if (!stats.byCategory[categoryName]) {
        stats.byCategory[categoryName] = {
          count: 0,
          amount: 0
        };
      }
      stats.byCategory[categoryName].count += 1;
      stats.byCategory[categoryName].amount += (d.amount || 0);
    });

    // Create timeline data based on period
    if (period === 'yearly' || (period === 'custom' && dateTo && dateFrom)) {
      // Group by month
      const monthlyData = {};
      donations.forEach(d => {
        const monthKey = new Date(d.date).toISOString().slice(0, 7); // YYYY-MM
        if (!monthlyData[monthKey]) {
          monthlyData[monthKey] = {
            count: 0,
            amount: 0,
            paid: 0
          };
        }
        monthlyData[monthKey].count += 1;
        monthlyData[monthKey].amount += (d.amount || 0);
        if (d.paymentStatus === 'Paid') {
          monthlyData[monthKey].paid += (d.amount || 0);
        }
      });

      // Convert to array and sort
      stats.timeline = Object.keys(monthlyData).sort().map(month => ({
        period: month,
        count: monthlyData[month].count,
        amount: monthlyData[month].amount,
        paidAmount: monthlyData[month].paid
      }));
    } else if (period === 'monthly') {
      // Group by day
      const dailyData = {};
      donations.forEach(d => {
        const dayKey = new Date(d.date).toISOString().slice(0, 10); // YYYY-MM-DD
        if (!dailyData[dayKey]) {
          dailyData[dayKey] = {
            count: 0,
            amount: 0,
            paid: 0
          };
        }
        dailyData[dayKey].count += 1;
        dailyData[dayKey].amount += (d.amount || 0);
        if (d.paymentStatus === 'Paid') {
          dailyData[dayKey].paid += (d.amount || 0);
        }
      });

      // Convert to array and sort
      stats.timeline = Object.keys(dailyData).sort().map(day => ({
        period: day,
        count: dailyData[day].count,
        amount: dailyData[day].amount,
        paidAmount: dailyData[day].paid
      }));
    }

    res.json({
      stats,
      dateRange: {
        from: startDate.toISOString(),
        to: endDate.toISOString()
      },
      period
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
