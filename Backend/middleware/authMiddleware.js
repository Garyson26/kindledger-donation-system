/**
 * =============================================================================
 * Authenticate a request  (SPEC-3 package 3.2)
 * =============================================================================
 * NO MONGOOSE. The user is resolved through services/userBridge, which reads
 * MySQL first and falls back to MongoDB for accounts not yet migrated - loudly,
 * because an authorisation decision made from the store we are migrating away
 * from is the single most interesting event in the system during this package
 * (AJ1b).
 *
 * SEC-05 IS ENFORCED HERE, and this is where it was missing. `isActive` existed
 * on the model and `admin.js` toggled it, but NO route and NO middleware ever
 * read it - so "disable user" had no effect at all, and the admin who clicked
 * it believed otherwise. `tokenVersion` did not exist anywhere, so a password
 * change or a reset left every issued token valid for its full hour.
 *
 * WHY A MISSING VERSION CLAIM IS TREATED AS 0, rather than refused: tokens
 * issued before this package carry no `tokenVersion`, and a user still in
 * MongoDB has no `token_version` column to compare against. Reading both as 0
 * means existing sessions keep working until they expire. Refusing them would
 * log out every signed-in donor at deploy, which is a worse outcome than a
 * one-hour window in which a pre-deploy token survives a password change.
 * =============================================================================
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/jwt");
const { refuse } = require("../utils/respond");
const { resolveAuthUser } = require("../services/userBridge");

// Attach a normalized `req.user` with `id`, `name`, and `role`.
const authMiddleware = async (req, res, next) => {
  const token = req.header("Authorization") || req.headers["authorization"];
  if (!token) return refuse(res, 401, "No token, authorization denied");

  try {
    const raw = token.split && token.split(" ")[1] ? token.split(" ")[1] : token.replace("Bearer ", "");
    const decoded = jwt.verify(raw, JWT_SECRET);

    const userId = decoded.userId || decoded.id || decoded.user || null;
    if (!userId) return refuse(res, 401, "Invalid token payload");

    const user = await resolveAuthUser(userId);
    if (!user) return refuse(res, 404, "User not found");

    // SEC-05, half one: a disabled account is not authenticated.
    if (!user.isActive) {
      return refuse(res, 403, "This account has been disabled");
    }

    // SEC-05, half two: revocation. `setPassword` and `setActive(false)`
    // increment token_version in the data layer, so a call site cannot forget.
    // See the header for why an absent claim is 0 rather than a refusal.
    const presented = typeof decoded.tokenVersion === "number" ? decoded.tokenVersion : 0;
    if (presented !== user.tokenVersion) {
      return refuse(res, 401, "Session expired. Please sign in again.");
    }

    req.user = {
      // EXTERNAL id (ObjectId). Routes compare it against client-supplied ids.
      id: user.id,
      // MySQL uuid, for repository lookups. NULL while the account is still in
      // MongoDB - a handler needing the repository must treat that as absent.
      uuid: user.uuid,
      name: user.name,
      role: user.role || decoded.role || "user",
    };

    next();
  } catch (err) {
    // SEC-19: the detail goes to the log, never to the client.
    console.error("Auth middleware JWT error:", err && err.message ? err.message : err);
    refuse(res, 401, "Invalid token");
  }
};

module.exports = authMiddleware;
