/**
 * =============================================================================
 * Donations - MIGRATED TO MySQL (SPEC-3 package 3.3)
 * =============================================================================
 * No Mongoose. No `categoryBridge`: a migrated donation carries its category
 * through the join, so the four bridge call sites this file used to hold are
 * gone rather than rewired. That is what ADR-050's exit condition counts down.
 *
 * READ THIS FIRST IF YOU ARE LOOKING FOR A MISSING DONATION. Donations are
 * WRITTEN by `routes/payment.js`, which migrates in package 3.4. Until it does,
 * a donation created through `/api/payment/initiate` lands in MongoDB and is
 * invisible to every endpoint in this file. That is ADR-056 applied to
 * donations and it is why 3.3 does not stand alone - see the remediation map.
 *
 * Identifiers: ADR-051 keeps the 24-hex ObjectId as the EXTERNAL id for the
 * rest of Phase 3, so `_id` on the wire is `legacy_id`, falling back to the
 * uuid for rows created after the migration. `present()` is the one place that
 * decision is expressed.
 * =============================================================================
 */

const express = require("express");
const router = express.Router();

const { donations } = require("../repositories");
// BUG-11: one refusal shape. See Backend/utils/respond.js.
const { refuse, failed } = require("../utils/respond");
const { idShape } = require("../services/legacyBridge");
const adminAuth = require("../middleware/adminAuth");
const authMiddleware = require("../middleware/authMiddleware");

/** BUG-08. The same ceiling the repository enforces; stated here for the 400. */
const MAX_PAGE_SIZE = donations.MAX_PAGE_SIZE;

// -----------------------------------------------------------------------------
// The wire shape
// -----------------------------------------------------------------------------
/**
 * Translate a repository record to what the client has always received.
 *
 * AE4: this is built from what the endpoints ACTUALLY returned, pinned by the
 * characterisation suite, not from what the old queries appeared to ask for.
 * `populate("category", "name description price")` requested two fields that
 * are not on the Category schema and therefore only ever returned `name`.
 *
 * Money crosses here and nowhere else. The repository speaks integer minor
 * units (ADR-010); the wire has always carried rupees as a number, so the
 * division is done once, at the boundary, rather than in nine handlers.
 */
function present(d) {
  if (!d) return null;
  const externalId = d.legacyId || d.id;
  return {
    _id: externalId,
    uuid: d.id,
    donorName: d.donorName,
    donorEmail: d.donorEmail,
    donorPhone: d.donorPhone,
    item: d.item,
    quantity: d.quantity,
    amount: d.amountMinor / 100,
    baseAmount: d.baseAmountMinor / 100,
    extraAmount: d.extraAmountMinor / 100,
    currency: d.currency,
    status: d.status,
    paymentStatus: d.paymentStatus,
    // The old column was `transactionId`. Renamed in the schema to
    // `transaction_ref` because SEC-06 replaced the guessable TXN<epoch><rand>
    // scheme with a uuid; the WIRE name is kept so no client has to change.
    transactionId: d.transactionRef,
    failureReason: d.failureReason,
    errorMessage: d.errorMessage,
    date: d.donatedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    // Populated to name and email ONLY, and never the hash. Pinned by AE4.
    userId: d.donor.user
      ? {
          _id: d.donor.user.legacyId || d.donor.user.id,
          name: d.donor.user.name,
          email: d.donor.user.email,
        }
      : null,
    category: d.category
      ? {
          _id: d.category.legacyId || d.category.id,
          id: d.category.legacyId || d.category.id,
          name: d.category.name,
          sortDescription: d.category.shortDescription,
          donationAmount: d.category.donationAmountMinor / 100,
          descriptions: d.category.descriptions || [],
        }
      : null,
    paymentDetails: d.paymentDetails
      ? {
          mihpayid: d.paymentDetails.mihpayid,
          amount: d.paymentDetails.amountMinor === null ? null : d.paymentDetails.amountMinor / 100,
          mode: d.paymentDetails.mode,
          bank_ref_num: d.paymentDetails.bankRefNum,
          status: d.paymentDetails.gatewayStatus,
          error_Message: d.paymentDetails.errorMessage,
          paymentDate: d.paymentDetails.paidAt,
        }
      : null,
  };
}

/**
 * Resolve an external donation id, WITHOUT letting a malformed one reach the
 * database.
 *
 * AD1b. The old code passed `req.params.id` straight to `findById`, so
 * `not-an-objectid` produced a Mongoose CastError and a 500 - SEC-19 on
 * `PUT /:id`, where the cast error was returned verbatim, and a plain 500 on
 * `GET /:id`. Checking the shape first turns both into a 404: a syntactically
 * impossible id names nothing, which is what "not found" means.
 */
async function resolveDonation(externalId) {
  const shape = idShape(externalId);
  if (shape === "objectid") return donations.findByLegacyId(String(externalId).trim());
  if (shape === "uuid") return donations.findById(String(externalId).trim());
  return null;
}

/**
 * Paging, with a ceiling.
 *
 * BUG-08. Previously `parseInt(limit)` was used verbatim: `limit=100000` loaded
 * a hundred thousand rows, and `limit=abc` produced NaN, which flowed into the
 * query and came back as `"limit": null` in a 200 response. A caller could not
 * tell a page of zero results from a request the server had failed to parse.
 */
function parsePaging(query) {
  const page = Number.parseInt(query.page ?? "1", 10);
  const limit = Number.parseInt(query.limit ?? "10", 10);
  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1) {
    return { invalid: true };
  }
  return { page, limit: Math.min(limit, MAX_PAGE_SIZE) };
}

/** `YYYY-MM-DD` plus end-of-day, as the old handlers did by hand in four places. */
function endOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// =============================================================================
// GET / - the admin list
// =============================================================================
router.get("/", adminAuth, async (req, res) => {
  try {
    const paging = parsePaging(req.query);
    if (paging.invalid) {
      return refuse(res, 400, "page and limit must be positive integers");
    }

    const { userType, paymentStatus, searchQuery, dateFrom, dateTo } = req.query;

    // NAMED SCALARS, NOT A FILTER OBJECT. The old handler assembled a Mongo
    // query object from req.query and handed it to Donation.find(), which is
    // the SEC-03 shape one layer up - a caller controlling the STRUCTURE of a
    // query rather than its values. The repository builds the structure.
    const { rows, total } = await donations.list(
      {
        userType,
        paymentStatus,
        search: searchQuery,
        from: dateFrom ? startOfDay(dateFrom) : undefined,
        to: dateTo ? endOfDay(dateTo) : undefined,
      },
      paging
    );

    res.json({
      donations: rows.map(present),
      pagination: {
        total,
        page: paging.page,
        pages: Math.ceil(total / paging.limit),
        limit: paging.limit,
      },
    });
  } catch (err) {
    return failed(res, "Failed to fetch donations", err);
  }
});

// =============================================================================
// GET /filter-options
// =============================================================================
router.get("/filter-options", adminAuth, async (req, res) => {
  try {
    // ADR-041. These report what is PRESENT IN THE DATA, never the ENUM's
    // member list. Returning the enum would silently change the admin filter
    // from "statuses you have" to "statuses that are possible", and the filter
    // would stop being able to show that nothing has been Cancelled all year.
    const [paymentStatuses, byStatus, presence, range] = await Promise.all([
      donations.listPaymentStatusesInUse(),
      donations.countsByPaymentStatus(),
      donations.countsByUserPresence(),
      donations.dateRange(),
    ]);

    const userTypes = [];
    if (presence.registered > 0) userTypes.push("registered");
    if (presence.guest > 0) userTypes.push("guest");

    res.json({
      paymentStatuses,
      userTypes,
      dateRange: {
        min: range.min ? range.min.slice(0, 10) : null,
        max: range.max ? range.max.slice(0, 10) : null,
      },
      counts: {
        total: presence.registered + presence.guest,
        registered: presence.registered,
        guest: presence.guest,
        byStatus,
      },
    });
  } catch (err) {
    return failed(res, "Failed to fetch filter options", err);
  }
});

// =============================================================================
// GET /stats/charts
// =============================================================================
router.get("/stats/charts", adminAuth, async (req, res) => {
  try {
    const { period, dateFrom, dateTo, year } = req.query;

    let startDate;
    let endDate;
    const now = new Date();

    if (period === "yearly") {
      const targetYear = year ? Number.parseInt(year, 10) : now.getFullYear();
      if (!Number.isInteger(targetYear)) {
        return refuse(res, 400, "year must be an integer");
      }
      startDate = new Date(targetYear, 0, 1);
      endDate = new Date(targetYear, 11, 31, 23, 59, 59, 999);
    } else if (period === "custom" && dateFrom && dateTo) {
      startDate = startOfDay(dateFrom);
      endDate = endOfDay(dateTo);
      if (!startDate || !endDate) {
        return refuse(res, 400, "dateFrom and dateTo must be valid dates");
      }
    } else {
      // 'monthly', absent, and anything unrecognised all land here. Pinned:
      // an unknown period is the current month, NOT an error.
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const rows = await donations.listForStats(startDate, endDate);

    const stats = {
      totalDonations: rows.length,
      totalAmount: rows.reduce((sum, d) => sum + d.amountMinor, 0) / 100,
      paidAmount:
        rows.filter((d) => d.paymentStatus === "Paid").reduce((s, d) => s + d.amountMinor, 0) / 100,
      pendingAmount:
        rows.filter((d) => d.paymentStatus === "Pending").reduce((s, d) => s + d.amountMinor, 0) /
        100,
      registeredUsers: rows.filter((d) => d.isRegistered).length,
      guestUsers: rows.filter((d) => !d.isRegistered).length,
      byStatus: {},
      byCategory: {},
      timeline: [],
    };

    for (const d of rows) {
      const status = d.paymentStatus || "Unknown";
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    }

    // Keyed by category NAME. `category_id` is NOT NULL with ON DELETE
    // RESTRICT, so "Uncategorized" is now unreachable rather than merely
    // unusual - but the fallback is kept because removing it would make a
    // future schema change fail silently instead of visibly.
    for (const d of rows) {
      const name = d.categoryName || "Uncategorized";
      if (!stats.byCategory[name]) stats.byCategory[name] = { count: 0, amount: 0 };
      stats.byCategory[name].count += 1;
      stats.byCategory[name].amount += d.amountMinor / 100;
    }

    const bucket = (d, width) => d.donatedAt.slice(0, width);
    const grouped = (width) => {
      const acc = {};
      for (const d of rows) {
        const key = bucket(d, width);
        if (!acc[key]) acc[key] = { count: 0, amount: 0, paid: 0 };
        acc[key].count += 1;
        acc[key].amount += d.amountMinor / 100;
        if (d.paymentStatus === "Paid") acc[key].paid += d.amountMinor / 100;
      }
      return Object.keys(acc)
        .sort()
        .map((k) => ({
          period: k,
          count: acc[k].count,
          amount: acc[k].amount,
          paidAmount: acc[k].paid,
        }));
    };

    if (period === "yearly" || (period === "custom" && dateFrom && dateTo)) {
      stats.timeline = grouped(7); // YYYY-MM
    } else if (period === "monthly") {
      stats.timeline = grouped(10); // YYYY-MM-DD
    }

    res.json({
      stats,
      dateRange: { from: startDate.toISOString(), to: endDate.toISOString() },
      period,
    });
  } catch (err) {
    return failed(res, "Failed to build donation statistics", err);
  }
});

// =============================================================================
// GET /user/:userId
// =============================================================================
router.get("/user/:userId", authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId && req.user.role !== "admin") {
      return refuse(res, 403, "Access denied");
    }

    const paging = parsePaging(req.query);
    if (paging.invalid) {
      return refuse(res, 400, "page and limit must be positive integers");
    }

    const { category, dateFrom, dateTo } = req.query;

    const { rows, total } = await donations.list(
      {
        userId: req.params.userId,
        categoryId: category && category !== "all" ? category : undefined,
        from: dateFrom ? startOfDay(dateFrom) : undefined,
        to: dateTo ? endOfDay(dateTo) : undefined,
      },
      paging
    );

    res.json({
      donations: rows.map(present),
      pagination: {
        total,
        page: paging.page,
        limit: paging.limit,
        pages: Math.ceil(total / paging.limit),
      },
    });
  } catch (err) {
    return failed(res, "Failed to fetch donations", err);
  }
});

// =============================================================================
// PUT /:id - admin status update
// =============================================================================
/**
 * SEC-16 and BUG-12, both closed here.
 *
 * SEC-16: `findByIdAndUpdate` does not run validators, so `{status:"banana"}`
 * landed in the column and every status filter missed the row afterwards. The
 * repository canonicalises against the enum and refuses anything else.
 *
 * BUG-12: there was no not-found branch at all. A missing donation answered
 * **200** with `{message:"Donation updated", donation:null}` - the status said
 * success and the message said updated, for a donation that does not exist -
 * while `PATCH /:id/status`, doing the same job on the same resource, returned
 * a correct 404. They now agree.
 */
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const existing = await resolveDonation(req.params.id);
    if (!existing) return refuse(res, 404, "Donation not found");

    const result = await donations.setStatus(existing.id, req.body.status);
    if (!result.ok && result.reason === "invalid-status") {
      return refuse(
        res,
        400,
        `status must be one of ${donations.DONATION_STATUSES.join(", ")}`
      );
    }
    if (!result.ok) return refuse(res, 404, "Donation not found");

    res.json({ message: "Donation updated", donation: present(result.donation) });
  } catch (err) {
    // SEC-19: the old handler returned err.message, which is how a caller
    // learned the collection was Mongo and the id was cast.
    return failed(res, "Failed to update donation", err);
  }
});

// =============================================================================
// PATCH /:id/status - admin approve/reject
// =============================================================================
/**
 * BUG-02 closed. This endpoint accepted ONLY lowercase `approved`/`rejected`
 * and wrote them unvalidated, while the payment callbacks wrote `Approved` -
 * so the collection held both casings and `admin.js`'s dashboard tile, counting
 * `status:"approved"`, read zero forever (BUG-03).
 *
 * Casing is decided in the repository, once, so the two writers cannot disagree
 * again. Both casings are accepted here; exactly one is stored.
 */
router.patch("/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body || {};
  const canonical = donations.canonicalStatus(status, ["Approved", "Rejected"]);
  if (!canonical) return refuse(res, 400, "Invalid status");

  try {
    const existing = await resolveDonation(req.params.id);
    if (!existing) return refuse(res, 404, "Donation not found");

    const result = await donations.setStatus(existing.id, canonical);
    if (!result.ok) return refuse(res, 404, "Donation not found");

    res.json(present(result.donation));
  } catch (err) {
    return failed(res, "Server error", err);
  }
});

// =============================================================================
// GET /:id - owner or admin
// =============================================================================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const donation = await resolveDonation(req.params.id);
    if (!donation) return refuse(res, 404, "Donation not found");

    // AG4, RECORDED NOT FIXED: for a guest donation `userId` is null, so
    // `isOwner` can never be true and the person who made it cannot retrieve
    // it - only an admin can. That is arguably right, since there is no
    // authenticated identity to match and matching on donor email would let
    // anyone read any guest donation by guessing an address. It is currently an
    // accident of the data model rather than a decision, which is the point.
    const ownerExternal = donation.donor.user
      ? donation.donor.user.legacyId || donation.donor.user.id
      : null;
    const isOwner =
      ownerExternal !== null &&
      (ownerExternal === req.user.id || donation.donor.user.id === req.user.uuid);
    if (!isOwner && req.user.role !== "admin") {
      return refuse(res, 403, "Access denied");
    }

    res.json(present(donation));
  } catch (err) {
    return failed(res, "Failed to fetch donation", err);
  }
});

/**
 * -----------------------------------------------------------------------------
 * BUG-01: `POST /api/donations` IS REMOVED. Decided, not deferred.
 * -----------------------------------------------------------------------------
 * The handler built a document from `item`, `category` and `quantity` while the
 * schema required `donorEmail` and `amount`, so every request in the endpoint's
 * life failed validation with a 400. It has never once succeeded.
 *
 * The map asked for a decision: supply the fields, or delete it. Deleting it.
 *
 * 1. NOTHING CAN DEPEND ON IT. An endpoint that has always refused has no
 *    client relying on success, and there is no caller in the frontend - the
 *    `DONATIONS.CREATE` constant is declared and never referenced.
 * 2. MAKING IT WORK WOULD BE THE WORSE CHANGE. It sat behind `optionalAuth`, so
 *    completing it would create an unauthenticated path that writes donation
 *    records bypassing payment initiation entirely - arbitrary amounts, no
 *    gateway, marked however the caller liked. Every real donation goes through
 *    `/api/payment/initiate`.
 *
 * BUG-06 goes with it. `optionalAuth` 401'd a guest holding an expired token
 * instead of falling through to guest, and this endpoint was its only user, so
 * the helper is deleted too rather than left as a fixed-but-unreachable
 * fragment. If an endpoint later needs optional authentication, it needs the
 * fall-through - that is recorded in the map, not preserved as dead code here.
 */

module.exports = router;
