const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/jwt");
const User = require("../models/User");
// BUG-11: one refusal shape.
const { refuse } = require("../utils/respond");

const adminAuth = async (req, res, next) => {
  const token = req.headers["authorization"] || req.header("Authorization");
  if (!token) return refuse(res, 401, "No token provided");
  try {
    const raw = token.split && token.split(" ")[1] ? token.split(" ")[1] : token.replace("Bearer ", "");
    const decoded = jwt.verify(raw, JWT_SECRET);
    const userId = decoded.userId || decoded.id || decoded.user || null;
    if (!userId) return refuse(res, 401, "Invalid token payload");

    const user = await User.findById(userId).select("name role");
    if (!user) return refuse(res, 404, "User not found");
    if (user.role !== "admin") return refuse(res, 403, "Access denied");

    req.user = { id: user._id.toString(), name: user.name, role: user.role };
    next();
  } catch (err) {
    console.error("Admin auth JWT error:", err);
    refuse(res, 401, "Invalid token");
  }
};

module.exports = adminAuth;
