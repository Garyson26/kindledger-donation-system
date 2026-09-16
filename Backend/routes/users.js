/**
 * =============================================================================
 * User profile  (SPEC-3 package 3.2)
 * =============================================================================
 * NO MONGOOSE. Storage goes through repositories/users.
 *
 * IT NOW USES authMiddleware INSTEAD OF VERIFYING THE JWT ITSELF. The previous
 * version duplicated the verification inline, which meant every check added to
 * the middleware silently did not apply here - and SEC-05's `isActive`
 * enforcement is exactly such a check. A disabled user could have kept editing
 * their profile indefinitely while every other route refused them.
 *
 * SEC-09: four `console.log` calls are gone. They wrote the request body, the
 * user id, the changed fields and the ENTIRE updated user document - name,
 * email, phone, address - to the application log on every profile save.
 * =============================================================================
 */

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { refuse, failed } = require("../utils/respond");
const users = require("../repositories/users");

/**
 * PUT /api/users/profile
 *
 * The assignable fields are an ALLOWLIST held in the repository, so `role`,
 * `isActive` and `isVerified` cannot be set by a caller editing their own
 * profile. That was already true here by virtue of the three-field loop; it is
 * now true in one place instead of two.
 */
router.put("/profile", authMiddleware, async (req, res) => {
  try {
    // A user still in MongoDB has no uuid, so there is no row to update. The
    // ETL is the mechanism (ADR-056); answering 404 is honest about that
    // rather than failing obscurely.
    if (!req.user.uuid) return refuse(res, 404, "User not found");

    const updated = await users.updateProfile(req.user.uuid, {
      name: req.body.name,
      phone: req.body.phone,
      address: req.body.address,
    });

    if (!updated) return refuse(res, 404, "User not found");

    // `normalise` never returns a hash or any OTP column, so this cannot leak
    // one - the old `.select("-password")` was a denylist, and a denylist is
    // wrong the first time a column is added.
    res.json(updated);
  } catch (err) {
    failed(res, "Could not update the profile", err, { tag: "users" });
  }
});

module.exports = router;
