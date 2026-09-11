const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/jwt");
const User = require("../models/User");
// BUG-11: one refusal shape. Every reason below was previously under `msg`,
// which the frontend does not read - so all four reached the user as
// "Request failed".
const { refuse } = require("../utils/respond");

// Attach a normalized `req.user` with `id`, `name`, and `role`.
const authMiddleware = async (req, res, next) => {
  const token = req.header("Authorization") || req.headers["authorization"];
  if (!token) return refuse(res, 401, "No token, authorization denied");

  try {
    const raw = token.split && token.split(" ")[1] ? token.split(" ")[1] : token.replace("Bearer ", "");
    const decoded = jwt.verify(raw, JWT_SECRET);

    // Ensure we have userId in token
    const userId = decoded.userId || decoded.id || decoded.user || null;
    if (!userId) return refuse(res, 401, "Invalid token payload");

    // Fetch user to attach name and role (keeps middleware idempotent)
    const user = await User.findById(userId).select("name role");
    if (!user) return refuse(res, 404, "User not found");

    req.user = {
      id: user._id.toString(),
      name: user.name,
      role: user.role || decoded.role || "user"
    };

    next();
  } catch (err) {
    console.error("Auth middleware JWT error:", err);
    refuse(res, 401, "Invalid token");
  }
};

module.exports = authMiddleware;
