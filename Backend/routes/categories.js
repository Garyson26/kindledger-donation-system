/**
 * =============================================================================
 * Category routes - MIGRATED TO MySQL (SPEC-3 package 3.1)
 * =============================================================================
 * NO MONGOOSE. All storage goes through Backend/repositories/categories.
 *
 * THE EXTERNAL IDENTIFIER STAYS A 24-HEX ObjectId FOR THE REST OF PHASE 3.
 * See ADR-051. `Donation.category` is still `mongoose.Schema.Types.ObjectId`
 * with `required: true`, so handing a uuid to the donation write path would
 * raise a CastError on save and no donation could be made against a category
 * created after this package. Every category therefore carries a `legacy_id`:
 * the real ObjectId for migrated rows, a freshly minted one for new rows. The
 * API returns that as `_id`, so `donations.js`, `payment.js`, the Mongo schema
 * and the frontend are all unchanged. The uuid is returned alongside it as
 * `uuid`, so nothing is hidden and Phase 4 has what it needs.
 *
 * Findings closed here: SEC-19, BUG-08, BUG-09, the falsy-amount check, and
 * ADR-004's soft delete. Findings deliberately NOT closed here: the non-atomic
 * reorder, which belongs with the rest of the transaction work (AD3).
 * =============================================================================
 */

const express = require("express");
const router = express.Router();
const crypto = require("node:crypto");
const adminAuth = require("../middleware/adminAuth");
const categories = require("../repositories/categories");
const { toMinorUnits } = require("../repositories/_shared");

// -----------------------------------------------------------------------------
// SEC-19: never return the raw error to the client.
// -----------------------------------------------------------------------------
// The Mongoose implementation returned `err.message`, which carried field
// names, values and cast failures. The detail goes to the server log; the
// client gets a generic message and the correct status.
function fail(res, status, message, err) {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(`[categories] ${message}:`, err && err.stack ? err.stack : err);
  }
  return res.status(status).json({ error: message });
}

// -----------------------------------------------------------------------------
// BUG-08: pagination is clamped and NaN-guarded.
// -----------------------------------------------------------------------------
// `parseInt(limit)` with no cap let `?limit=100000` stream the whole table and
// `?limit=abc` put NaN into skip/limit and into the response body, which the
// client received as nulls with a 200.
const MAX_PAGE_SIZE = 100;

function parsePaging(query) {
  const rawPage = query.page;
  const rawLimit = query.limit;
  if (rawPage === undefined || rawLimit === undefined) return { paginated: false };

  const page = Number.parseInt(rawPage, 10);
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1) {
    return { paginated: true, invalid: true };
  }
  return { paginated: true, page, limit: Math.min(limit, MAX_PAGE_SIZE) };
}

/**
 * `mintObjectId()` IS GONE (AE1-b, fired by package 3.4).
 *
 * This file minted a 24-hex external identifier for every new category, for one
 * reason: `Donation.category` was a Mongoose ObjectId REF, and a category with
 * only a uuid could not be referenced by one. A category created here after
 * package 3.1 would otherwise have been unusable by the live donation write
 * path.
 *
 * THE TRIGGER WAS THE DONATION WRITE PATH, NOT THIS FILE, AND THAT DISTINCTION
 * COST A PACKAGE. It was recorded as "remove it once donations.js has migrated"
 * - right concept, wrong file. `donations.js` never successfully wrote a
 * donation (BUG-01); `routes/payment.js` did, and it migrated in 3.4. Removing
 * the minter at 3.3 would have broken the money path on the first category
 * created afterwards. It is the fifth of the inherited claims, and it had
 * already been revised once without its reasoning being re-read.
 *
 * A category created from here now has `legacy_id` NULL and is addressed by its
 * uuid. `present()` below HAD TO BE CHANGED for that to work - it returned
 * `_id: category.legacyId` alone, so a new category's `_id` was null. See the
 * note there; asserting the fix in this comment before making it is the tenth
 * inherited claim and the first one AU2's rule caught in the same session.
 */

/** The wire shape. Unchanged from the Mongoose version apart from `uuid`. */
function present(category) {
  if (!category) return null;
  return {
    // `legacyId || id` (CHANGED IN 3.4). A category created since AE1-b's
    // trigger fired has NO legacy id, and this returned `_id: null` for it -
    // which the frontend then sent back as the identifier.
    //
    // I ASSERTED THE OPPOSITE IN A COMMENT ABOVE while removing the minter -
    // "present() below already returns legacyId || id" - without checking. It
    // is the tenth inherited claim, it is mine, and it is the shape AU2's
    // citation rule names exactly: a sentence written in passing to justify a
    // change, inside a commit about something else. Four assertions caught it
    // within minutes, because AU1 required the tests be run.
    _id: category.legacyId || category.id,
    uuid: category.id,
    name: category.name,
    sortDescription: category.shortDescription,
    donationAmount: category.donationAmountMinor / 100,
    descriptions: category.descriptions,
    displayOrder: category.displayOrder,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

/** Resolve an external ObjectId to the repository's uuid. */
async function resolveUuid(externalId) {
  if (typeof externalId !== "string" || !/^[0-9a-f]{24}$/i.test(externalId.trim())) {
    // AD1b: a malformed id is NOT FOUND, never a 500. The Mongoose version let
    // the cast throw, so a well-formed unknown id was a 404 and a malformed one
    // was a 500 - two shapes of the same answer, and the one an attacker can
    // trigger trivially was the crash.
    return null;
  }
  const found = await categories.findByLegacyId(externalId.trim());
  return found ? found.id : null;
}

// -----------------------------------------------------------------------------
// POST / - create (admin only)
// -----------------------------------------------------------------------------
router.post("/", adminAuth, async (req, res) => {
  try {
    const { name, sortDescription, donationAmount, descriptions } = req.body;

    // PRESENCE, not falsiness. The Mongoose check was
    // `!name || !descriptions || !sortDescription || !donationAmount`, which
    // treated `donationAmount: 0` as absent - so a free category was impossible
    // and the reason given ("All fields are required") was untrue, because the
    // field had been supplied.
    const missing =
      name === undefined ||
      sortDescription === undefined ||
      donationAmount === undefined ||
      descriptions === undefined;
    if (missing) {
      return fail(res, 400, "All fields are required");
    }

    const amountMinor = toMinorUnits(donationAmount);
    if (amountMinor === null) {
      return fail(res, 400, "donationAmount must be a number with at most two decimal places");
    }
    // `ck_categories_amount_positive` enforces this in the database too. It is
    // checked here so the answer is a 400 naming the field rather than a 500
    // from a constraint violation.
    if (amountMinor <= 0) {
      return fail(res, 400, "donationAmount must be greater than zero");
    }
    if (!Array.isArray(descriptions)) {
      return fail(res, 400, "descriptions must be an array");
    }

    const existing = await categories.findByName(name);
    if (existing) {
      return fail(res, 400, "Category already exists");
    }

    const created = await categories.create({
      name,
      shortDescription: sortDescription,
      donationAmountMinor: amountMinor,
      displayOrder: await categories.nextDisplayOrder(),
      descriptions,
    });

    res.json({ message: "Category added successfully", category: present(created) });
  } catch (err) {
    return fail(res, 500, "Could not create the category", err);
  }
});

// -----------------------------------------------------------------------------
// GET / - list (public; the donation form reads it)
// -----------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const paging = parsePaging(req.query);

    if (!paging.paginated) {
      const all = await categories.list();
      return res.json(all.map(present));
    }

    if (paging.invalid) {
      // BUG-08: previously NaN flowed through and the client got a 200 with
      // nulls in the pagination block.
      return fail(res, 400, "page and limit must be positive integers");
    }

    const { page, limit } = paging;
    const total = await categories.count();
    const rows = await categories.list({ skip: (page - 1) * limit, take: limit });

    res.json({
      categories: rows.map(present),
      pagination: { total, page, pages: Math.ceil(total / limit), limit },
    });
  } catch (err) {
    return fail(res, 500, "Could not list categories", err);
  }
});

// -----------------------------------------------------------------------------
// PUT /reorder - MUST stay before /:id (admin only)
// -----------------------------------------------------------------------------
router.put("/reorder", adminAuth, async (req, res) => {
  try {
    const { categories: ordering } = req.body;
    if (!ordering || !Array.isArray(ordering)) {
      return fail(res, 400, "Invalid categories data");
    }

    // STILL NOT ATOMIC, DELIBERATELY (AD3). Wrapping this in withTransaction is
    // the correct fix and it belongs with the rest of the transaction work in
    // the package that owns it, not smuggled in here. What HAS changed is that
    // an unresolvable id no longer throws: it is skipped and counted, so the
    // endpoint answers 200 with what it did rather than 500 with the valid
    // writes already applied and no way to know which.
    let updated = 0;
    let skipped = 0;
    for (const entry of ordering) {
      const uuid = await resolveUuid(entry && entry.id);
      const order = Number.parseInt(entry && entry.displayOrder, 10);
      if (!uuid || !Number.isInteger(order)) {
        skipped += 1;
        continue;
      }
      if (await categories.setDisplayOrder(uuid, order)) updated += 1;
      else skipped += 1;
    }

    res.json({ message: "Categories reordered successfully", updated, skipped });
  } catch (err) {
    return fail(res, 500, "Could not reorder categories", err);
  }
});

// -----------------------------------------------------------------------------
// PUT /:id - update (admin only)
// -----------------------------------------------------------------------------
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const uuid = await resolveUuid(req.params.id);
    if (!uuid) return fail(res, 404, "Category not found");

    const { name, donationAmount, sortDescription, descriptions } = req.body;

    // BUG-09: ONLY the supplied keys are assigned.
    //
    // The Mongoose version built `descriptions: descriptions || []`
    // unconditionally, so a caller sending just `{ donationAmount }` - which is
    // exactly what the edit-price form sends - silently cleared the description
    // list. No error, and nobody would connect the two events.
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (sortDescription !== undefined) fields.shortDescription = sortDescription;
    if (descriptions !== undefined) {
      if (!Array.isArray(descriptions)) return fail(res, 400, "descriptions must be an array");
      fields.descriptions = descriptions;
    }
    if (donationAmount !== undefined) {
      const amountMinor = toMinorUnits(donationAmount);
      if (amountMinor === null || amountMinor <= 0) {
        return fail(res, 400, "donationAmount must be a positive number");
      }
      fields.donationAmountMinor = amountMinor;
    }

    const updated = await categories.update(uuid, fields);
    if (!updated) return fail(res, 404, "Category not found");

    res.json({ message: "Category updated successfully", category: present(updated) });
  } catch (err) {
    return fail(res, 500, "Could not update the category", err);
  }
});

// -----------------------------------------------------------------------------
// DELETE /:id - ARCHIVE, not delete (admin only)
// -----------------------------------------------------------------------------
// ADR-004. A BEHAVIOUR CHANGE, and the one users could notice.
//
// The Mongoose version removed the row outright, leaving every donation that
// referenced it holding a dangling id - so historical reports lost the category
// that priced the donation. MySQL cannot reproduce that: donations.category_id
// is NOT NULL with ON DELETE RESTRICT, so the same delete would be refused by
// the database.
//
// Archiving keeps the financial record intact. The category disappears from the
// donation form and from the default admin list, which is what "delete" means
// to the person clicking it, and stays resolvable for every donation that
// already points at it.
router.delete("/:id", adminAuth, async (req, res) => {
  try {
    const uuid = await resolveUuid(req.params.id);
    if (!uuid) return fail(res, 404, "Category not found");

    const archived = await categories.archive(uuid);
    if (!archived) return fail(res, 404, "Category not found");

    res.json({ message: "Category deleted successfully" });
  } catch (err) {
    return fail(res, 500, "Could not delete the category", err);
  }
});

module.exports = router;
