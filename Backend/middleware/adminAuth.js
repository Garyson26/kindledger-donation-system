/**
 * =============================================================================
 * Require an admin  (SPEC-3 package 3.2)
 * =============================================================================
 * NO MONGOOSE. Same resolution path and the same SEC-05 enforcement as
 * authMiddleware - see that file's header for why a missing token version is
 * read as 0.
 *
 * THE ROLE COMES FROM THE STORE, NEVER FROM THE TOKEN. `decoded.role` is
 * present and is deliberately ignored: a token is a bearer credential the
 * client holds, and trusting a role claim in it would mean an admin demoted
 * five minutes ago stays an admin until their token expires. The lookup is what
 * makes "remove admin" take effect immediately, and it is the reason this
 * middleware reads the user at all rather than just verifying the signature.
 * =============================================================================
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/jwt");
const { refuse } = require("../utils/respond");
const { resolveAuthUser } = require("../services/userBridge");

const adminAuth = async (req, res, next) => {
  const token = req.headers["authorization"] || req.header("Authorization");
  if (!token) return refuse(res, 401, "No token provided");

  try {
    const raw = token.split && token.split(" ")[1] ? token.split(" ")[1] : token.replace("Bearer ", "");
    const decoded = jwt.verify(raw, JWT_SECRET);
    const userId = decoded.userId || decoded.id || decoded.user || null;
    if (!userId) return refuse(res, 401, "Invalid token payload");

    const user = await resolveAuthUser(userId);
    if (!user) return refuse(res, 404, "User not found");

    // SEC-05. A disabled admin is refused before the role is even considered:
    // "disabled" is a stronger statement than "not an admin", and the order
    // means a disabled admin cannot be told they merely lack a role.
    if (!user.isActive) return refuse(res, 403, "This account has been disabled");

    const presented = typeof decoded.tokenVersion === "number" ? decoded.tokenVersion : 0;
    if (presented !== user.tokenVersion) {
      return refuse(res, 401, "Session expired. Please sign in again.");
    }

    if (user.role !== "admin") return refuse(res, 403, "Access denied");

    req.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (err) {
    // SEC-19: detail to the log, not to the client.
    console.error("Admin auth JWT error:", err && err.message ? err.message : err);
    refuse(res, 401, "Invalid token");
  }
};

module.exports = adminAuth;
