/**
 * =============================================================================
 * Admin - MIGRATED TO MySQL (AS7, completing package 3.5's user half)
 * =============================================================================
 * NO MONGOOSE. Every user operation and both donation counts go through the
 * repositories.
 *
 * WHY THIS FILE MOVED EARLY. It was package 3.5, two packages away, and package
 * 3.2 moved users to MySQL while this file kept writing MongoDB. Every admin
 * revocation - disable, delete, password change - reported success and did
 * nothing, for three packages, because authentication no longer read the store
 * these handlers wrote (ADMIN-01). A control that reports success without
 * acting is worse than one that visibly fails, because nobody returns to
 * verify.
 *
 * THE FAILURE WAS INVERTED RELATIVE TO THE RISK. Accounts that exist only in
 * MySQL - anything created since 3.2 - got a loud `404`. Accounts present in
 * BOTH stores, which is every ETL-migrated account and therefore every real
 * user after cutover, got the silent `200`. Loud for the accounts that did not
 * matter, silent for the ones that would.
 *
 * WHAT IS DELIBERATELY NOT CHANGED HERE is listed at the foot of the file.
 * =============================================================================
 */

const express = require("express");
const router = express.Router();

const { users, donations } = require("../repositories");
// TEMPORARY (ADR-050, deleted in package 3.6). The category count still goes
// through the bridge: categories are MySQL, but a category created before the
// 3.1 cutover may still be MongoDB-only, and the bridge is what covers that.
const categoryBridge = require("../services/categoryBridge");
const scheduler = require("../services/scheduler");

const adminAuth = require("../middleware/adminAuth");
const { refuse, failed } = require("../utils/respond");
// SEC-10: ONE password policy, in one module. This file used to carry a sixth
// copy whose check said 10 and whose message said 6.
const { passwordProblem } = require("../utils/password");

// Protect all admin routes
router.use(adminAuth);

/** BUG-08. The repository enforces it too; stated here for the 400. */
const MAX_PAGE_SIZE = users.MAX_PAGE_SIZE;

/**
 * The wire shape for a user.
 *
 * `_id` is the external identifier (ADR-051), and the hash is not omitted here
 * - `repositories/users` never selects it at all. The Mongoose version did
 * `user.toObject()` then `delete obj.password`, which fetched the hash across
 * the wire in order to throw it away.
 */
function present(u) {
  if (!u) return null;
  return {
    _id: u.legacyId || u.id,
    uuid: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    phone: u.phone,
    address: u.address,
    isActive: u.isActive,
    isVerified: u.isVerified,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/**
 * Paging, with a ceiling (BUG-08).
 *
 * The Mongoose version used `parseInt(limit)` verbatim: `limit=100000` loaded a
 * hundred thousand accounts, and `limit=abc` produced NaN, which reached the
 * query and came back as `"limit": null` inside a 200.
 */
function parsePaging(query) {
  const page = Number.parseInt(query.page ?? "1", 10);
  const limit = Number.parseInt(query.limit ?? "10", 10);
  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1) {
    return { invalid: true };
  }
  return { page, limit: Math.min(limit, MAX_PAGE_SIZE) };
}

function endOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

const startOfDay = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The dashboard tiles.
 *
 * D-X2: the donation counts read MongoDB until AS7. The `donations` tile agreed
 * with MySQL right up until something wrote - the ETL had copied one to the
 * other - so it was correct in every test and wrong only under real traffic.
 *
 * BUG-03 closes here, and it was not what the map said. The map recorded the
 * "approved" tile as "always 0"; measured, it returned 1 when the true figure
 * was 2. `countDocuments({status: "approved"})` matched the LOWERCASE subset,
 * so it counted whatever fraction `PATCH /:id/status` had written and missed
 * everything the payment callbacks wrote as `Approved`. IT MEASURED CASING, NOT
 * APPROVAL - and a tile showing 0 is visibly broken while a tile showing 1 of 2
 * is believed. MySQL stores one canonical casing, so the count is now simply
 * the count.
 */
router.get("/stats", async (req, res) => {
  try {
    const [userCount, donationCount, categoryCount, approvedCount] = await Promise.all([
      users.count(),
      donations.count(),
      // Via the bridge (ADR-050). Counts ACTIVE categories only, because
      // ADR-004 made deletion a soft delete - an archived category is gone as
      // far as an admin is concerned, which is what this tile reports.
      categoryBridge.countCategories(),
      donations.count({ status: "Approved" }),
    ]);
    res.json({
      users: userCount,
      donations: donationCount,
      categories: categoryCount,
      approved: approvedCount,
    });
  } catch (err) {
    // The Mongoose version had NO try/catch at all: a database blip rejected
    // the promise and the request hung until the client timed out.
    return failed(res, "Failed to load dashboard statistics", err, { tag: "admin" });
  }
});

// View all users with filters and pagination
/**
 * The user list.
 *
 * ADMIN-01: this read MongoDB, so an account created through the API since
 * package 3.2 - one that can actually log in - did not appear in the admin list
 * at all.
 *
 * BE-HIGH-08 SURVIVES THE STORE SWAP RATHER THAN BEING RETIRED BY IT. The
 * finding was `$regex` executing the caller's metacharacters; `LIKE` has `%`
 * and `_`, and a parameterised query does not neutralise them. The escaping
 * lives in the repository, where the query is built.
 */
router.get("/users", async (req, res) => {
  try {
    const paging = parsePaging(req.query);
    if (paging.invalid) {
      return refuse(res, 400, "page and limit must be positive integers");
    }

    const { search, role, status, joinDateFrom, joinDateTo } = req.query;

    // Named scalars, never a filter object assembled from req.query.
    const { rows, total } = await users.list(
      {
        search,
        role,
        status,
        from: joinDateFrom ? startOfDay(joinDateFrom) : undefined,
        to: joinDateTo ? endOfDay(joinDateTo) : undefined,
      },
      paging
    );

    res.json({
      users: rows.map(present),
      pagination: {
        total,
        page: paging.page,
        pages: Math.ceil(total / paging.limit),
        limit: paging.limit,
      },
    });
  } catch (err) {
    // The Mongoose version logged the query and the filter on every request -
    // an admin search term and the emails it matched, into the application log
    // (SEC-09). Both console.log calls are gone with it.
    return failed(res, "Failed to list users", err, { tag: "admin" });
  }
});

/**
 * Create a user.
 *
 * ADMIN-01, the clearest case: this wrote MongoDB, so the account the admin was
 * told had been created COULD NOT LOG IN. auth.js reads MySQL and there was no
 * row there.
 *
 * SEC-18 closes by construction - `users.create` hashes at `BCRYPT_COST` (12),
 * so there is no cost parameter here to get wrong. SEC-21 closes by setting
 * `isVerified` explicitly rather than leaving the default and relying on
 * auth.js to quietly repair it at first login.
 *
 * SEC-08 IS NOT APPLICABLE HERE, and that is a decision rather than an
 * oversight. The finding is account enumeration; this endpoint is behind
 * `adminAuth`, and the same caller can list every account with a GET. A generic
 * response would withhold from an admin something they can read one request
 * later, at the cost of telling them nothing about why their request failed.
 * The mechanism is present; the outcome it prevents is not.
 */
router.post("/users", async (req, res) => {
  try {
    const { name, email, password, role, phone, address } = req.body || {};

    if (!name || !email || !password) {
      return refuse(res, 400, "Name, email, and password are required");
    }
    const problem = passwordProblem(password);
    if (problem) return refuse(res, 400, problem);

    if (await users.findByEmail(email)) {
      return refuse(res, 400, "User with this email already exists");
    }

    const created = await users.create({
      name,
      email,
      password,
      role: role || "user",
      phone: phone || "",
      address: address || "",
      isActive: true,
      // SEC-21. An account an admin created is verified by the act of an admin
      // creating it; leaving it false left auth.js to flip it on first login,
      // which made `isVerified` a field nothing could ever refuse.
      isVerified: true,
    });

    res.status(201).json({ message: "User created successfully", user: present(created) });
  } catch (err) {
    return failed(res, "Failed to create user", err, { tag: "admin" });
  }
});

/** Update profile fields. Never isActive, isVerified, password or tokenVersion. */
router.put("/users/:id", async (req, res) => {
  try {
    const { name, email, role, phone, address } = req.body || {};

    // BE-MED-06: an admin may not demote themselves.
    if (role && role !== "admin" && req.user.id === req.params.id) {
      return refuse(res, 400, "Cannot demote your own account");
    }

    if (email !== undefined) {
      const clash = await users.findByEmail(email);
      const target = await users.findByExternalId(req.params.id);
      if (clash && target && clash.id !== target.id) {
        // The Mongoose version had no check: the write hit the unique index and
        // returned a 500 carrying the index name (SEC-19).
        return refuse(res, 400, "User with this email already exists");
      }
    }

    const updated = await users.adminUpdate(req.params.id, {
      name,
      email,
      role,
      phone,
      address,
    });
    if (!updated) return refuse(res, 404, "User not found");

    res.json({ message: "User updated successfully", user: present(updated) });
  } catch (err) {
    return failed(res, "Failed to update user", err, { tag: "admin" });
  }
});

/**
 * Enable or disable an account.
 *
 * ADMIN-01's headline case. This answered `200 "User disabled successfully"`
 * and set `isActive` in MongoDB; `authMiddleware` enforces the MySQL value, so
 * THE DISABLED ACCOUNT KEPT AUTHENTICATING. The admin was told it was disabled,
 * the record said disabled, and access was never revoked.
 *
 * `users.setActive` also increments `token_version` when disabling, so live
 * sessions die with the account instead of surviving for up to an hour. That is
 * in the data layer rather than here precisely so a call site cannot forget it.
 */
router.patch("/users/:id/toggle-status", async (req, res) => {
  try {
    const target = await users.findByExternalId(req.params.id);
    if (!target) return refuse(res, 404, "User not found");

    // BE-MED-06's reasoning, extended: an admin who disables their own account
    // locks themselves out mid-request. The Mongoose version allowed it.
    if (req.user.id === req.params.id && target.isActive) {
      return refuse(res, 400, "Cannot disable your own account");
    }

    const updated = await users.setActive(target.id, !target.isActive);
    res.json({
      message: `User ${updated.isActive ? "enabled" : "disabled"} successfully`,
      user: present(updated),
    });
  } catch (err) {
    return failed(res, "Failed to change account status", err, { tag: "admin" });
  }
});

/**
 * Set a user's password.
 *
 * ADMIN-01 again, and SEC-18b with it. This wrote the hash to MongoDB while
 * login verified against MySQL, so THE OLD PASSWORD STILL WORKED AND THE NEW
 * ONE DID NOT - after a `200 "Password changed successfully"`.
 *
 * `users.setPassword` hashes at cost 12 and increments `token_version`, so an
 * admin resetting a compromised account's password now actually revokes its
 * sessions. It did not before, which is the worst possible moment for that
 * control to be missing.
 *
 * SEC-10: the length rule comes from `utils/password`. The rule here used to be
 * `length < 10` behind a message that said 6.
 */
router.patch("/users/:id/change-password", async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) return refuse(res, 400, problem);

    const target = await users.findByExternalId(req.params.id);
    if (!target) return refuse(res, 404, "User not found");

    const updated = await users.setPassword(target.id, newPassword);
    res.json({ message: "Password changed successfully", user: present(updated) });
  } catch (err) {
    return failed(res, "Failed to change password", err, { tag: "admin" });
  }
});

/**
 * Delete a user.
 *
 * ADMIN-01: this deleted the MongoDB row and answered `200 "User deleted
 * successfully"` while the MySQL account survived AND KEPT AUTHENTICATING.
 *
 * Both BE-MED-06 guards are preserved deliberately - they were correct, and a
 * migration is the easiest place to drop a guard nobody is testing. The
 * donations of a deleted donor survive with `user_id` NULL (ADR-003), so the
 * record stays attributable through `donor_name` and `donor_email`.
 */
router.delete("/users/:id", async (req, res) => {
  try {
    if (req.user.id === req.params.id) {
      return refuse(res, 400, "Cannot delete your own account");
    }

    const target = await users.findByExternalId(req.params.id);
    if (!target) return refuse(res, 404, "User not found");

    if (target.role === "admin" && (await users.countAdmins()) <= 1) {
      return refuse(res, 400, "Cannot delete the last admin account");
    }

    const deleted = await users.deleteByExternalId(req.params.id);
    if (!deleted) return refuse(res, 404, "User not found");

    res.json({ message: "User deleted successfully" });
  } catch (err) {
    return failed(res, "Failed to delete user", err, { tag: "admin" });
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
    // AS2: A REFUSAL IS NOT A FAILURE. "MySQL is not authoritative for this
    // entity yet, nothing was touched" and "the delete crashed partway" are
    // opposite facts about the data, and answering 500 to the first would send
    // an admin looking for damage that does not exist.
    if (err && err.code === "ERR_NOT_AUTHORITATIVE") {
      return refuse(res, 409, `Cleanup refused: ${err.message}`, {
        deleted: 0,
        entity: err.entity,
        authoritativeStore: err.state,
      });
    }
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


/**
 * -----------------------------------------------------------------------------
 * WHAT AS7 DELIBERATELY DID NOT CHANGE
 * -----------------------------------------------------------------------------
 * Stated rather than left to be inferred from the diff, because a migration is
 * the easiest place for a deferral to become an omission.
 *
 * 1. SEC-08 on `POST /users`. NOT APPLICABLE rather than deferred - see the
 *    handler. The endpoint is behind `adminAuth`, and the same caller can list
 *    every account with a GET, so a generic response withholds nothing from an
 *    attacker and withholds a reason from an admin.
 *
 * 2. BUG-04's dead Vercel cron declaration. `Backend/vercel.json` still points
 *    a cron at `POST /api/admin/cleanup/trigger`, which sits behind `adminAuth`
 *    and has therefore received a 401 every night since it was written. The
 *    endpoint is migrated; REMOVING THE CRON DECLARATION IS A DEPLOYMENT
 *    CHANGE, not a route change, and it belongs with the Vercel teardown.
 *
 * 3. The `users` count on `/stats` counts EVERY account including admins and
 *    disabled ones, exactly as it did before. That is pre-existing behaviour
 *    and nobody has said which number the tile is supposed to show; changing it
 *    silently alongside a store swap is how a dashboard starts lying.
 *
 * 4. `isVerified` still gates nothing (AJ3's restatement of SEC-21). This file
 *    now sets it TRUE explicitly at creation, which is the half SEC-21 asked
 *    for. Whether the flag should REFUSE anything is a product decision, and
 *    making a dead field load-bearing is not a migration's job.
 */
