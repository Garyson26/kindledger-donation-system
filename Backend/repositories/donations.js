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
  user: { select: { uuid: true, name: true, email: true } },
  category: { select: { uuid: true, name: true, shortDescription: true, donationAmountMinor: true } },
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
      user: row.user ? { id: row.user.uuid, name: row.user.name, email: row.user.email } : null,
    },
    category: row.category
      ? {
          id: row.category.uuid,
          name: row.category.name,
          shortDescription: row.category.shortDescription,
          donationAmountMinor: fromBigInt(row.category.donationAmountMinor),
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
 * `categoryId` and `userId` are external uuids. They are resolved to internal
 * keys here, which is the only place that translation happens.
 */
async function create(input, tx) {
  const db = client(tx);

  const category = await db.category.findUnique({
    where: { uuid: input.categoryId },
    select: { id: true },
  });
  if (!category) {
    throw new Error(`Unknown category ${input.categoryId}`);
  }

  let userKey = null;
  if (input.userId) {
    const user = await db.user.findUnique({ where: { uuid: input.userId }, select: { id: true } });
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

/** Rows older than `cutoff`. Backs the retention purge (BUG-04). */
async function countOlderThan(cutoff, tx) {
  return client(tx).donation.count({ where: { createdAt: { lt: new Date(cutoff) } } });
}

async function deleteOlderThan(cutoff, tx) {
  const res = await client(tx).donation.deleteMany({
    where: { createdAt: { lt: new Date(cutoff) } },
  });
  return res.count;
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
  deleteByDonorEmailPrefix,
  normalise,
};
