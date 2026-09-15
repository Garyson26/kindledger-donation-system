/**
 * =============================================================================
 * Donation repository (SPEC-2 section 4)
 * =============================================================================
 * Shaped to the test suites' store seam so Phase 3's test migration is a
 * handful of function bodies rather than 23 rewritten tests.
 *
 * Money in and out is INTEGER MINOR UNITS. Identifiers in and out are the
 * external `uuid`, never the internal BIGINT.
 * =============================================================================
 */

'use strict';

const { client, newUuid, fromBigInt, iso } = require('./_shared');

// What every read returns. Kept in one place so field naming is translated once
// (SPEC-2 section 4.2) rather than in every route in Phase 3.
const SELECT = {
  uuid: true,
  legacyId: true,
  transactionRef: true,
  donorName: true,
  donorEmail: true,
  donorPhone: true,
  item: true,
  quantity: true,
  baseAmountMinor: true,
  extraAmountMinor: true,
  amountMinor: true,
  currency: true,
  status: true,
  paymentStatus: true,
  failureReason: true,
  errorMessage: true,
  donatedAt: true,
  createdAt: true,
  updatedAt: true,
  // `legacyId` on both relations because ADR-051 keeps the 24-hex ObjectId as
  // the EXTERNAL identifier for the rest of Phase 3, and the wire shape quotes
  // it as `_id`. Without it, package 3.3 would have silently changed the id the
  // frontend reads for the donor and the category.
  user: { select: { uuid: true, legacyId: true, name: true, email: true } },
  category: {
    select: {
      uuid: true,
      legacyId: true,
      name: true,
      shortDescription: true,
      donationAmountMinor: true,
      descriptions: { select: { text: true, position: true }, orderBy: { position: 'asc' } },
    },
  },
  paymentDetails: true,
};

/**
 * Plain normalised object. No Prisma instance ever reaches a caller.
 *
 * ON THE `donor` SHAPE - SPEC-2 section 4.4, first item.
 * Mongoose `populate()` yields null both for a guest donation and for a
 * donation whose user was deleted, and route code cannot tell those apart. A
 * SQL join over a nullable FK with ON DELETE SET NULL has the same two cases,
 * so the ambiguity does not disappear by itself - it has to be resolved here.
 *
 * `isGuest` is true when the donation never had a user. That is inferred from
 * user_id being null, which after ON DELETE SET NULL is ALSO what a deleted
 * account looks like. The two are genuinely indistinguishable in the schema, so
 * this reports the honest thing - "no user is attached" - rather than guessing.
 * donorName and donorEmail are always populated on the row (ADR-003), so the
 * donation remains attributable either way.
 *
 * `category` cannot be null: category_id is NOT NULL with ON DELETE RESTRICT,
 * so a missing category is impossible rather than merely unusual. Route code in
 * Phase 3 must not branch on it.
 */
function normalise(row) {
  if (!row) return null;
  const pd = row.paymentDetails || null;
  return {
    id: row.uuid,
    legacyId: row.legacyId,
    transactionRef: row.transactionRef,
    donorName: row.donorName,
    donorEmail: row.donorEmail,
    donorPhone: row.donorPhone,
    item: row.item,
    quantity: row.quantity,
    baseAmountMinor: fromBigInt(row.baseAmountMinor),
    extraAmountMinor: fromBigInt(row.extraAmountMinor),
    amountMinor: fromBigInt(row.amountMinor),
    currency: row.currency,
    status: row.status,
    paymentStatus: row.paymentStatus,
    failureReason: row.failureReason ?? null,
    errorMessage: row.errorMessage ?? null,
    donatedAt: iso(row.donatedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    donor: {
      isGuest: !row.user,
      user: row.user
        ? {
            id: row.user.uuid,
            legacyId: row.user.legacyId,
            name: row.user.name,
            email: row.user.email,
          }
        : null,
    },
    category: row.category
      ? {
          id: row.category.uuid,
          legacyId: row.category.legacyId,
          name: row.category.name,
          shortDescription: row.category.shortDescription,
          donationAmountMinor: fromBigInt(row.category.donationAmountMinor),
          descriptions: (row.category.descriptions || []).map((d) => d.text),
        }
      : null,
    paymentDetails: pd
      ? {
          mihpayid: pd.mihpayid ?? null,
          amountMinor: fromBigInt(pd.amountMinor),
          mode: pd.mode ?? null,
          bankRefNum: pd.bankRefNum ?? null,
          gatewayStatus: pd.gatewayStatus ?? null,
          errorMessage: pd.errorMessage ?? null,
          paidAt: iso(pd.paidAt),
        }
      : null,
  };
}

/**
 * Create a donation.
 *
 * `categoryId` and `userId` are EXTERNAL identifiers, in either form. They are
 * resolved to internal keys here, which is the only place that translation
 * happens.
 *
 * BOTH FORMS ARE ACCEPTED ON PURPOSE (package 3.3). This originally matched on
 * `uuid` alone, which is what the identifier policy will settle on - but
 * ADR-051 keeps the 24-hex ObjectId as the external identifier for the REST OF
 * PHASE 3, so the ids the routes and clients actually exchange are legacy ids.
 * Accepting only the uuid made `create` unreachable from a real caller, and
 * `payment.js` would have hit the same wall in 3.4. Narrowing this back to
 * `uuid` is part of retiring the ObjectId, not part of this package.
 */
async function create(input, tx) {
  const db = client(tx);

  const category = await db.category.findFirst({
    where: { OR: [{ uuid: String(input.categoryId) }, { legacyId: String(input.categoryId) }] },
    select: { id: true },
  });
  if (!category) {
    throw new Error(`Unknown category ${input.categoryId}`);
  }

  let userKey = null;
  if (input.userId) {
    const user = await db.user.findFirst({
      where: { OR: [{ uuid: String(input.userId) }, { legacyId: String(input.userId) }] },
      select: { id: true },
    });
    if (!user) throw new Error(`Unknown user ${input.userId}`);
    userKey = user.id;
  }

  const row = await db.donation.create({
    data: {
      uuid: input.uuid || newUuid(),
      legacyId: input.legacyId ?? null,
      transactionRef: input.transactionRef || newUuid(),
      donorName: input.donorName,
      donorEmail: input.donorEmail,
      donorPhone: input.donorPhone ?? null,
      userId: userKey,
      categoryId: category.id,
      item: input.item ?? null,
      quantity: input.quantity ?? 1,
      baseAmountMinor: BigInt(input.baseAmountMinor),
      extraAmountMinor: BigInt(input.extraAmountMinor ?? 0),
      amountMinor: BigInt(input.amountMinor),
      currency: input.currency || 'INR',
      status: input.status || 'Pending',
      paymentStatus: input.paymentStatus || 'Pending',
      ...(input.donatedAt ? { donatedAt: new Date(input.donatedAt) } : {}),
      // The Phase 4 ETL must preserve the original row timestamps rather than
      // stamping every migrated donation with the import time - otherwise the
      // retention window resets at cutover and the purge becomes a no-op for
      // another decade. Accepted here so the ETL has no reason to reach past
      // this layer. Also what lets AG1a's floor be tested.
      ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
    },
    select: SELECT,
  });

  return normalise(row);
}

async function findById(id, tx) {
  const row = await client(tx).donation.findUnique({ where: { uuid: id }, select: SELECT });
  return normalise(row);
}

async function findByTransactionRef(ref, tx) {
  const row = await client(tx).donation.findUnique({
    where: { transactionRef: ref },
    select: SELECT,
  });
  return normalise(row);
}

/** For the Phase 4 ETL and for resolving a receipt that quotes an old ObjectId. */
async function findByLegacyId(legacyId, tx) {
  const row = await client(tx).donation.findUnique({ where: { legacyId }, select: SELECT });
  return normalise(row);
}

/**
 * Field-level update of the donation and its payment details.
 *
 * Deliberately NOT a whole-row replace. ADR-024 recorded that assigning a fresh
 * paymentDetails object made Mongoose replace the subdocument, so whichever of
 * /success and /webhook arrived second destroyed what the other had written.
 * `upsert` with a partial `update` is the equivalent guarantee here: absent keys
 * are left alone.
 */
async function updatePayment(id, fields, tx) {
  const db = client(tx);
  const target = await db.donation.findUnique({ where: { uuid: id }, select: { id: true } });
  if (!target) return null;

  const donationScalars = {};
  if (fields.status !== undefined) donationScalars.status = fields.status;
  if (fields.paymentStatus !== undefined) donationScalars.paymentStatus = fields.paymentStatus;
  if (fields.transactionRef !== undefined) donationScalars.transactionRef = fields.transactionRef;
  if (fields.failureReason !== undefined) donationScalars.failureReason = fields.failureReason;
  if (fields.errorMessage !== undefined) donationScalars.errorMessage = fields.errorMessage;

  const detail = {};
  if (fields.mihpayid !== undefined) detail.mihpayid = fields.mihpayid;
  if (fields.amountMinor !== undefined) {
    detail.amountMinor = fields.amountMinor === null ? null : BigInt(fields.amountMinor);
  }
  if (fields.mode !== undefined) detail.mode = fields.mode;
  if (fields.bankRefNum !== undefined) detail.bankRefNum = fields.bankRefNum;
  if (fields.gatewayStatus !== undefined) detail.gatewayStatus = fields.gatewayStatus;
  if (fields.detailErrorMessage !== undefined) detail.errorMessage = fields.detailErrorMessage;
  if (fields.paidAt !== undefined) {
    detail.paidAt = fields.paidAt === null ? null : new Date(fields.paidAt);
  }

  if (Object.keys(donationScalars).length > 0) {
    await db.donation.update({ where: { id: target.id }, data: donationScalars });
  }

  if (Object.keys(detail).length > 0) {
    await db.donationPaymentDetail.upsert({
      where: { donationId: target.id },
      create: { donationId: target.id, ...detail },
      update: detail,
    });
  }

  return findById(id, tx);
}

/**
 * Distinct payment statuses PRESENT IN THE DATA - SPEC-2 section 4.4, second
 * item, and this is the decision that is easy to get wrong later.
 *
 * The obvious implementation is to return the ENUM's member list, which is a
 * compile-time constant and needs no query. DO NOT DO THAT. It silently changes
 * the admin filter dropdown from "statuses that exist in your data" to
 * "statuses that are theoretically possible", which is a visible behaviour
 * change in the admin UI and makes the filter useless for spotting that, say,
 * nothing has been Cancelled all year.
 *
 * Mongoose's distinct() had the data semantics. They are preserved here on
 * purpose. See ADR-041.
 */
async function listPaymentStatusesInUse(tx) {
  const rows = await client(tx).donation.findMany({
    distinct: ['paymentStatus'],
    select: { paymentStatus: true },
    orderBy: { paymentStatus: 'asc' },
  });
  return rows.map((r) => r.paymentStatus);
}

/** Same reasoning as above, for the donation status field. */
async function listStatusesInUse(tx) {
  const rows = await client(tx).donation.findMany({
    distinct: ['status'],
    select: { status: true },
    orderBy: { status: 'asc' },
  });
  return rows.map((r) => r.status);
}

/**
 * Rows inside the retention window. Backs the purge (BUG-04).
 *
 * THE WINDOW IS BOUNDED AT BOTH ENDS (AG1a). `{ lt: cutoff }` alone treats
 * "impossibly old" as "old", and that is not theoretical: the Phase 4 ETL
 * carries dates from MongoDB, where the Mongoose schema never enforced them
 * (SPEC-1A section 8). A row arriving with a zero epoch, a mis-parsed string or
 * a 1970 default lands INSIDE the ten-year window, and the first admin to click
 * cleanup after cutover destroys it - a donation record lost to a date bug
 * nobody would connect to an admin endpoint.
 *
 * `floor` is the earliest date that can plausibly be a real donation. Rows
 * below it are NOT deleted; they are counted and reported, because an
 * implausible date is evidence of a migration defect and deleting the evidence
 * is the worst available response.
 *
 * THE COLUMN IS `donatedAt`, CHANGED FROM `createdAt` (AH2, ADR-054).
 *
 * The legacy dataCleanupService keyed on `createdAt` - when the ROW WAS
 * WRITTEN - and this inherited that. It is wrong on both counts.
 *
 * 1. A ten-year retention policy on donation records means ten years from the
 *    DONATION, not from the insert. For rows created through the application
 *    those are minutes apart and the distinction never shows; for migrated
 *    rows they can differ by years. `donated_at` is also the column every
 *    report and admin filter already uses.
 * 2. It removes a failure mode rather than mitigating one. `created_at` is
 *    `DEFAULT CURRENT_TIMESTAMP(3)`, so an ETL that does not set it explicitly
 *    stamps every migrated donation with the import date - and the purge then
 *    finds nothing until 2036. SILENTLY, because "no rows older than ten
 *    years" is exactly what a healthy system reports. A control that cannot be
 *    observed failing is worse than one that fails loudly, and keying on
 *    `donated_at` means the ETL cannot produce that state at all.
 */
async function countOlderThan(cutoff, floor, tx) {
  return client(tx).donation.count({
    where: { donatedAt: { lt: new Date(cutoff), gte: new Date(floor) } },
  });
}

async function deleteOlderThan(cutoff, floor, tx) {
  const res = await client(tx).donation.deleteMany({
    where: { donatedAt: { lt: new Date(cutoff), gte: new Date(floor) } },
  });
  return res.count;
}

/** Rows dated before the plausible floor, or in the future. NEVER deleted. */
async function countImplausibleDates(floor, now, tx) {
  return client(tx).donation.count({
    where: {
      OR: [{ donatedAt: { lt: new Date(floor) } }, { donatedAt: { gt: new Date(now) } }],
    },
  });
}

// =============================================================================
// The listing and reporting surface (package 3.3)
// =============================================================================

/** BUG-08. Same ceiling as `routes/categories.js`, deliberately one number. */
const MAX_PAGE_SIZE = 100;

const DONATION_STATUSES = ['Pending', 'Approved', 'Rejected'];
const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Cancelled'];

/**
 * Canonicalise a status, or return null.
 *
 * BUG-02. `PATCH /:id/status` accepted ONLY `approved`/`rejected` while the
 * payment callbacks wrote `Approved`, so the collection held both casings and
 * every status filter missed half its rows. Casing is decided HERE, once, so
 * the two writers cannot disagree again.
 *
 * Note that MySQL would canonicalise `'approved'` to `'Approved'` by itself
 * under `utf8mb4_0900_as_ci` (ADR-018). Doing it explicitly means the caller
 * can tell a recognised status from an unrecognised one, which is what lets
 * SEC-16 answer 400 instead of writing junk.
 */
function canonicalStatus(value, allowed) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v) || null;
}

/**
 * Make a search term a LITERAL.
 *
 * BE-HIGH-08 was about `$regex` executing the user's metacharacters; the fix
 * was to escape them. Moving to SQL does NOT retire that finding, it RENAMES
 * it: `LIKE` has its own metacharacters, `%` and `_`, and Prisma's `contains`
 * binds the value as a parameter without neutralising them. A parameterised
 * query stops SQL injection; it does not stop `%` from meaning "anything".
 *
 * So a search for `%` would return every donor - the same over-match the regex
 * fix removed, arriving through a different door. MySQL treats backslash as the
 * default LIKE escape character, so escaping here restores "a search term is
 * text, not a pattern".
 *
 * This depends on `NO_BACKSLASH_ESCAPES` being absent from `sql_mode`, which
 * the schema gate already pins. It is asserted by behaviour in the route suite
 * rather than trusted.
 */
function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Resolve an external user identifier to the internal key.
 *
 * Accepts either form on purpose. `req.user.uuid` is the MySQL key and
 * `req.params.userId` is still the 24-hex ObjectId that ADR-051 keeps as the
 * external identifier for the rest of Phase 3, and both reach this function
 * from the same route.
 */
async function resolveUserKey(externalId, tx) {
  if (typeof externalId !== 'string' || !externalId.trim()) return undefined;
  const value = externalId.trim();
  const row = await client(tx).user.findFirst({
    where: { OR: [{ uuid: value }, { legacyId: value }] },
    select: { id: true },
  });
  return row ? row.id : null;
}

/**
 * Build a Prisma `where` from NAMED SCALAR FILTERS.
 *
 * THE INTERFACE IS THE POINT, not the implementation. The Mongoose version
 * assembled a filter OBJECT in the route from `req.query` and handed it to
 * `Donation.find()` - which is the same shape SEC-03 exploits, one layer up: a
 * caller controlling the structure of a query rather than its values. This
 * function takes scalars and builds the structure itself, so a route cannot
 * pass one through even by accident.
 *
 * Returns `{ impossible: true }` for a filter no row can satisfy - an
 * unrecognised paymentStatus, or a userId that resolves to nothing. That is the
 * MongoDB behaviour preserved (an unknown status simply matched nothing) and it
 * is also the honest answer: an empty page, not an error, and not a silently
 * ignored filter showing the caller every row instead.
 */
async function buildWhere(filters = {}, tx) {
  const where = {};

  if (filters.userType === 'registered') where.userId = { not: null };
  else if (filters.userType === 'guest') where.userId = null;

  if (filters.paymentStatus && filters.paymentStatus !== 'all') {
    const canonical = canonicalStatus(filters.paymentStatus, PAYMENT_STATUSES);
    if (!canonical) return { impossible: true };
    where.paymentStatus = canonical;
  }

  if (filters.status && filters.status !== 'all') {
    const canonical = canonicalStatus(filters.status, DONATION_STATUSES);
    if (!canonical) return { impossible: true };
    where.status = canonical;
  }

  if (filters.userId) {
    const key = await resolveUserKey(filters.userId, tx);
    if (!key) return { impossible: true };
    where.userId = key;
  }

  if (filters.categoryId) {
    const value = String(filters.categoryId).trim();
    const category = await client(tx).category.findFirst({
      where: { OR: [{ uuid: value }, { legacyId: value }] },
      select: { id: true },
    });
    if (!category) return { impossible: true };
    where.categoryId = category.id;
  }

  if (filters.from || filters.to) {
    where.donatedAt = {};
    if (filters.from) where.donatedAt.gte = new Date(filters.from);
    if (filters.to) where.donatedAt.lte = new Date(filters.to);
  }

  if (filters.search && String(filters.search).trim()) {
    const term = escapeLike(String(filters.search).trim());
    where.OR = [{ donorName: { contains: term } }, { donorEmail: { contains: term } }];
  }

  return { where };
}

/**
 * A filtered, paginated page of donations.
 *
 * Returns the total alongside the rows because the count has to use the SAME
 * `where`, and building it twice in a route is how those two drift apart.
 */
async function list(filters = {}, paging = {}, tx) {
  const built = await buildWhere(filters, tx);
  if (built.impossible) return { rows: [], total: 0 };

  const db = client(tx);
  const take = Math.min(Math.max(1, paging.limit || 10), MAX_PAGE_SIZE);
  const skip = Math.max(0, ((paging.page || 1) - 1) * take);

  const [total, rows] = await Promise.all([
    db.donation.count({ where: built.where }),
    db.donation.findMany({
      where: built.where,
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);

  return { rows: rows.map(normalise), total };
}

/** The same filters, count only. */
async function count(filters = {}, tx) {
  const built = await buildWhere(filters, tx);
  if (built.impossible) return 0;
  return client(tx).donation.count({ where: built.where });
}

/** Earliest and latest donation dates, or nulls when there are no rows. */
async function dateRange(tx) {
  const agg = await client(tx).donation.aggregate({
    _min: { donatedAt: true },
    _max: { donatedAt: true },
  });
  return { min: iso(agg._min.donatedAt), max: iso(agg._max.donatedAt) };
}

/**
 * Row counts per payment status, for statuses PRESENT IN THE DATA.
 *
 * Same reasoning as `listPaymentStatusesInUse` and ADR-041: a status nobody has
 * used must be absent, not zero. A `groupBy` reports only the groups that
 * exist, which is exactly the Mongo `$group` semantics.
 */
async function countsByPaymentStatus(tx) {
  const groups = await client(tx).donation.groupBy({
    by: ['paymentStatus'],
    _count: { _all: true },
  });
  const out = {};
  for (const g of groups) out[g.paymentStatus] = g._count._all;
  return out;
}

/** How many donations have a user attached, and how many do not. */
async function countsByUserPresence(tx) {
  const db = client(tx);
  const [registered, guest] = await Promise.all([
    db.donation.count({ where: { userId: { not: null } } }),
    db.donation.count({ where: { userId: null } }),
  ]);
  return { registered, guest };
}

/**
 * Set the donation status, canonically.
 *
 * SEC-16: the Mongoose version used `findByIdAndUpdate`, which does not run
 * validators, so any string landed in the field. Here the value is
 * canonicalised first and an unrecognised one never reaches the database.
 *
 * BUG-12: returns null for a donation that does not exist, so the caller can
 * answer 404. The old `PUT /:id` had no not-found branch at all and reported
 * "Donation updated" with `donation: null`.
 */
async function setStatus(id, status, tx) {
  const canonical = canonicalStatus(status, DONATION_STATUSES);
  if (!canonical) return { ok: false, reason: 'invalid-status' };

  const db = client(tx);
  const target = await db.donation.findUnique({ where: { uuid: id }, select: { id: true } });
  if (!target) return { ok: false, reason: 'not-found' };

  await db.donation.update({ where: { id: target.id }, data: { status: canonical } });
  return { ok: true, donation: await findById(id, tx) };
}

/**
 * The projection `GET /stats/charts` needs, and NOTHING ELSE.
 *
 * The Mongoose version loaded every donation in the range as a full document,
 * resolved each category through the bridge, and reduced in JavaScript. The
 * reduction stays in JavaScript - the grouping rules are fiddly and preserving
 * them exactly matters more than pushing them into SQL - but the READ is now
 * five columns and a joined name instead of whole records. Same output, a
 * fraction of the bytes.
 *
 * Still unbounded by row count: a custom range of several years loads every row
 * in it. That is the pre-existing behaviour and it is left alone here rather
 * than changed silently alongside the store swap.
 */
async function listForStats(from, to, tx) {
  const rows = await client(tx).donation.findMany({
    where: { donatedAt: { gte: new Date(from), lte: new Date(to) } },
    select: {
      donatedAt: true,
      amountMinor: true,
      paymentStatus: true,
      userId: true,
      category: { select: { name: true } },
    },
    orderBy: { donatedAt: 'desc' },
  });
  return rows.map((r) => ({
    donatedAt: iso(r.donatedAt),
    amountMinor: fromBigInt(r.amountMinor),
    paymentStatus: r.paymentStatus,
    isRegistered: r.userId !== null,
    categoryName: r.category ? r.category.name : null,
  }));
}

/** Test and ETL support: remove rows by donor-email prefix. Never used at runtime. */
async function deleteByDonorEmailPrefix(prefix, tx) {
  const res = await client(tx).donation.deleteMany({
    where: { donorEmail: { startsWith: prefix } },
  });
  return res.count;
}

module.exports = {
  create,
  findById,
  findByTransactionRef,
  findByLegacyId,
  updatePayment,
  listPaymentStatusesInUse,
  listStatusesInUse,
  countOlderThan,
  deleteOlderThan,
  countImplausibleDates,
  deleteByDonorEmailPrefix,
  normalise,

  // The listing and reporting surface (package 3.3).
  list,
  count,
  dateRange,
  countsByPaymentStatus,
  countsByUserPresence,
  setStatus,
  listForStats,

  // Exported so the route can tell "unrecognised status" from "no such
  // donation" WITHOUT re-stating the enum members. Two copies of an enum is how
  // BUG-02 happened.
  canonicalStatus,
  DONATION_STATUSES,
  PAYMENT_STATUSES,
  MAX_PAGE_SIZE,
};
