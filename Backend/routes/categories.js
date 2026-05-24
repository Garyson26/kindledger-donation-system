const express = require("express");
const router = express.Router();
const Category = require("../models/Category");
const adminAuth = require("../middleware/adminAuth");

// Add category with validation (admin only)
router.post("/", adminAuth, async (req, res) => {
  try {
    const { name, sortDescription, donationAmount, descriptions } = req.body;

    if (!name || !descriptions || !sortDescription || !donationAmount) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if category already exists
    const existing = await Category.findOne({ name });
    if (existing) {
      return res.status(400).json({ error: "Category already exists" });
    }

    // Get the highest displayOrder and add 1 for the new category
    const lastCategory = await Category.findOne().sort({ displayOrder: -1 });
    const nextDisplayOrder = lastCategory ? (lastCategory.displayOrder || 0) + 1 : 0;

    const category = new Category({
      name,
      sortDescription,
      donationAmount,
      descriptions: descriptions || [],
      displayOrder: nextDisplayOrder
    });
    await category.save();
    res.json({ message: "Category added successfully", category });
  } catch (err) {
    console.log('err', err)
    res.status(500).json({ error: err.message });
  }
});

// Get all categories with pagination
router.get("/", async (req, res) => {
  try {
    const { page, limit } = req.query;

    // If pagination params are provided, use pagination
    if (page && limit) {
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      const total = await Category.countDocuments();
      const categories = await Category.find()
        .sort({ displayOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum);

      res.json({
        categories,
        pagination: {
          total,
          page: pageNum,
          pages: Math.ceil(total / limitNum),
          limit: limitNum
        }
      });
    } else {
      // Return all categories without pagination (for dropdowns, etc.)
      const categories = await Category.find().sort({ displayOrder: 1, createdAt: -1 });
      res.json(categories);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder categories - MUST be before /:id routes (admin only)
router.put("/reorder", adminAuth, async (req, res) => {
  try {
    const { categories } = req.body; // Array of { id, displayOrder }

    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({ error: "Invalid categories data" });
    }

    // Update all categories with new display order
    const updatePromises = categories.map(({ id, displayOrder }) =>
      Category.findByIdAndUpdate(id, { displayOrder }, { new: true })
    );

    await Promise.all(updatePromises);

    res.json({ message: "Categories reordered successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update category (admin only)
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { name, donationAmount, sortDescription, descriptions } = req.body;

    const updateData = {
      name,
      sortDescription,
      donationAmount,
      descriptions: descriptions || []
    };

    const category = await Category.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category updated successfully", category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete category (admin only)
router.delete("/:id", adminAuth, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
