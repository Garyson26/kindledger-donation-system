/**
 * =============================================================================
 * The ETL load (Phase 4a) - LOCAL ONLY IN THIS PACKAGE
 * =============================================================================
 * Transforms MongoDB documents into MySQL rows, in foreign-key dependency
 * order, preserving the ObjectId in `legacy_id` so the two stores stay
 * cross-referenceable while both exist.
 *
 * ORDER IS NOT A PREFERENCE, IT IS THE FK GRAPH (ADR-055):
 *
 *   categories, users        neither references anything
 *     -> category_descriptions   references categories
 *     -> donations               references BOTH
 *        -> donation_payment_details   references donations
 *
 * NO `INSERT IGNORE`, NO `UPDATE IGNORE`, ANYWHERE (ADR-022 / ADR-013). They
 * downgrade a CHECK violation, an ENUM mismatch and a duplicate key to a
 * WARNING and SKIP THE ROW. On a migration that means bad data is silently
 * dropped and the run reports success - the failure mode that makes a migration
 * unverifiable. Every write here fails loudly.
 *
 * IDEMPOTENT BY `legacy_id`, NOT BY IGNORE. Five route packages will run this
 * repeatedly against a partially loaded database. Each entity checks whether
 * its `legacy_id` is already present and skips it, which is a decision the ETL
 * makes and reports - not an error the database swallows.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT MIGRATED, stated here rather than merely absent
 * -----------------------------------------------------------------------------
 * `pending_signups`. SPEC-1A section 5.2: these are 24-hour-lived rows holding
 * an unverified signup attempt. Carrying them across a cutover migrates a
 * half-finished registration whose OTP has almost certainly expired, and the
 * user simply signs up again. The table exists in MySQL and is populated by the
 * application from cutover onwards.
 *
 * LIVE OTP AND RESET-CODE STATE. MongoDB stores `loginOTP`, `signupOTP` and
 * `resetPasswordCode` in PLAINTEXT (SEC-13); MySQL stores only sha256 hashes.
 * The ETL could hash them on the way across - and deliberately does not. These
 * codes live for 10 to 15 minutes, so at any cutover almost none is valid; and
 * carrying a plaintext secret through a migration script, into its logs and its
 * error messages, to preserve a value that expires before anyone could use it
 * is a bad trade. Anyone mid-reset at cutover requests a new code.
 * `reset_code_attempts` IS carried, because that is a security counter and
 * resetting it would hand an in-progress attacker a fresh budget (ADR-034).
 * =============================================================================
 */

'use strict';

const crypto = require('node:crypto');
const { toMinorWithDelta, PLAUSIBLE_FLOOR } = require('./preflight');

const CANONICAL_STATUS = ['Pending', 'Approved', 'Rejected'];
const CANONICAL_PAYMENT = ['Pending', 'Paid', 'Failed', 'Cancelled'];

/**
 * Canonicalise a status, REPORTING the change rather than performing it
 * silently.
 *
 * MySQL would do this itself - `_ci` collation canonicalises `'approved'` to
 * `'Approved'` on insert without a word (ADR-018). Doing it here instead means
 * the run can COUNT it. An unrecognised value is returned untouched so the
 * insert fails loudly rather than being coerced into something plausible.
 */
function canonicalStatus(value, allowed, stats, field) {
  if (value === null || value === undefined) return null;
  if (allowed.includes(value)) return value;
  const match = allowed.find((a) => a.toLowerCase() === String(value).toLowerCase());
  if (match) {
    stats.canonicalised[field] = (stats.canonicalised[field] || 0) + 1;
    return match;
  }
  return value; // let the ENUM reject it
}

function requireMinor(value, label, fallback = null) {
  const { minor, ok } = toMinorWithDelta(value);
  if (!ok || minor === null) {
    if (fallback !== null) return fallback;
    throw new Error(`${label}: cannot convert ${JSON.stringify(value)} to minor units`);
  }
  if (minor < 0) throw new Error(`${label}: negative amount ${value}`);
  return minor;
}

function plausibleDate(value, label, stats) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime()) || d < PLAUSIBLE_FLOOR || d > new Date()) {
    // Never guessed, never substituted. The pre-flight blocks on these; if the
    // operator overrode it, the row still fails here rather than being loaded
    // with an invented date.
    throw new Error(
      `${label}: implausible date ${JSON.stringify(value)}. The pre-flight reported ` +
        'this; it is not corrected here on purpose (ADR-054).'
    );
  }
  stats.dates = (stats.dates || 0) + 1;
  return d;
}

// -----------------------------------------------------------------------------
// Entities, in FK order
// -----------------------------------------------------------------------------

async function migrateCategories({ prisma, models, stats }) {
  const docs = await models.Category.find({}).lean();
  for (const doc of docs) {
    const legacyId = String(doc._id);
    const existing = await prisma.category.findUnique({ where: { legacyId } });
    if (existing) {
      stats.skipped.categories += 1;
      continue;
    }

    const created = await prisma.category.create({
      data: {
        uuid: crypto.randomUUID(),
        legacyId,
        name: doc.name,
        shortDescription: doc.sortDescription,
        donationAmountMinor: BigInt(requireMinor(doc.donationAmount, `category ${legacyId}`)),
        displayOrder: doc.displayOrder || 0,
        // Explicit, never left to DEFAULT CURRENT_TIMESTAMP. ADR-054: an ETL
        // that stamps the import time makes the retention purge a no-op for a
        // decade, silently.
        createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : new Date(),
      },
    });

    // category_descriptions: the Mongo array, normalised and positioned.
    const descriptions = Array.isArray(doc.descriptions) ? doc.descriptions : [];
    if (descriptions.length > 0) {
      await prisma.categoryDescription.createMany({
        data: descriptions.map((text, position) => ({
          categoryId: created.id,
          position,
          text: String(text),
        })),
      });
      stats.loaded.categoryDescriptions += descriptions.length;
    }
    stats.loaded.categories += 1;
  }
}

async function migrateUsers({ prisma, models, stats }) {
  const docs = await models.User.find({}).lean();
  for (const doc of docs) {
    const legacyId = String(doc._id);
    if (await prisma.user.findUnique({ where: { legacyId } })) {
      stats.skipped.users += 1;
      continue;
    }
    await prisma.user.create({
      data: {
        uuid: crypto.randomUUID(),
        legacyId,
        name: doc.name,
        // Lowercased to match the case-insensitive unique index. The pre-flight
        // has already refused the run if two accounts collapse to one address.
        email: String(doc.email).trim().toLowerCase(),
        // Carried verbatim - a bcrypt hash is portable and re-hashing is
        // impossible without the plaintext. SEC-18's cost-12 upgrade happens on
        // each user's next successful login, not here.
        passwordHash: doc.password,
        role: doc.role === 'admin' ? 'admin' : 'user',
        phone: doc.phone || null,
        address: doc.address || null,
        isActive: doc.isActive !== false,
        isVerified: Boolean(doc.isVerified),
        // Everyone starts at version 0; no token issued before cutover carries
        // a version claim, and the middleware reads an absent claim as 0.
        tokenVersion: 0,
        // Live OTP and reset codes are NOT carried - see the file header.
        // The ATTEMPT COUNTER is, because clearing it would hand an in-progress
        // attacker a fresh budget (ADR-034).
        resetCodeAttempts: doc.resetPasswordAttempts || 0,
        loginOtpAttempts: doc.loginOTPAttempts || 0,
        createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : new Date(),
      },
    });
    stats.loaded.users += 1;
  }
}

async function migrateDonations({ prisma, models, stats }) {
  const docs = await models.Donation.find({}).lean();
  for (const doc of docs) {
    const legacyId = String(doc._id);
    if (await prisma.donation.findUnique({ where: { legacyId } })) {
      stats.skipped.donations += 1;
      continue;
    }

    // FK remap by legacy_id. Never by position, never by name.
    const category = doc.category
      ? await prisma.category.findUnique({ where: { legacyId: String(doc.category) } })
      : null;
    if (!category) {
      throw new Error(
        `donation ${legacyId}: category ${doc.category} does not resolve. The ` +
          'pre-flight reports this as orphaned-category; it is not invented here.'
      );
    }

    const user = doc.userId
      ? await prisma.user.findUnique({ where: { legacyId: String(doc.userId) } })
      : null;
    if (doc.userId && !user) {
      throw new Error(
        `donation ${legacyId}: user ${doc.userId} does not resolve. A donation by a ` +
          'deleted user should carry userId null, not a dangling reference.'
      );
    }

    const base = requireMinor(doc.baseAmount ?? doc.amount, `donation ${legacyId} base`);
    const extra = requireMinor(doc.extraAmount ?? 0, `donation ${legacyId} extra`, 0);
    const amount = requireMinor(doc.amount, `donation ${legacyId} amount`);

    const created = await prisma.donation.create({
      data: {
        uuid: crypto.randomUUID(),
        legacyId,
        // A FRESH uuid, not the old TXN<epoch><rand> (SPEC-1A section 4.1).
        // The old scheme is guessable, and SEC-06 turns a guessable transaction
        // id into donor PII disclosure. The old value is not preserved anywhere
        // because preserving it would preserve the weakness.
        transactionRef: crypto.randomUUID(),
        donorName: doc.donorName,
        donorEmail: doc.donorEmail,
        donorPhone: doc.donorPhone || null,
        userId: user ? user.id : null,
        categoryId: category.id,
        item: doc.item || null,
        quantity: doc.quantity || 1,
        baseAmountMinor: BigInt(base),
        extraAmountMinor: BigInt(extra),
        amountMinor: BigInt(amount),
        currency: 'INR',
        status: canonicalStatus(doc.status, CANONICAL_STATUS, stats, 'status') || 'Pending',
        paymentStatus:
          canonicalStatus(doc.paymentStatus, CANONICAL_PAYMENT, stats, 'paymentStatus') ||
          'Pending',
        failureReason: doc.failureReason || null,
        errorMessage: doc.errorMessage || null,
        donatedAt: plausibleDate(doc.date, `donation ${legacyId}`, stats),
        createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : new Date(),
      },
    });
    stats.loaded.donations += 1;

    // donation_payment_details - the embedded subdocument, normalised.
    const pd = doc.paymentDetails;
    if (pd && (pd.mihpayid || pd.mode || pd.bank_ref_num || pd.status)) {
      await prisma.donationPaymentDetail.create({
        data: {
          donationId: created.id,
          mihpayid: pd.mihpayid || null,
          amountMinor: pd.amount !== undefined && pd.amount !== null
            ? BigInt(requireMinor(pd.amount, `donation ${legacyId} paid amount`))
            : null,
          mode: pd.mode || null,
          bankRefNum: pd.bank_ref_num || pd.bankRefNum || null,
          // Verbatim. ADR-025 records that this will be NULL for the entire
          // pre-cutover paid population, because the old handlers never wrote
          // it - that is expected, not a defect in this transform.
          gatewayStatus: pd.status || null,
          errorMessage: pd.error_Message || pd.errorMessage || null,
          paidAt: pd.paidAt ? new Date(pd.paidAt) : null,
        },
      });
      stats.loaded.paymentDetails += 1;
    }
  }
}

/**
 * Run the load. Assumes the pre-flight has been run and either passed or been
 * explicitly overridden.
 */
async function runMigration({ prisma, models }) {
  const stats = {
    loaded: { categories: 0, categoryDescriptions: 0, users: 0, donations: 0, paymentDetails: 0 },
    skipped: { categories: 0, users: 0, donations: 0 },
    canonicalised: {},
    notMigrated: {
      // Stated, not merely absent. See the file header.
      pendingSignups: await models.PendingSignup.countDocuments(),
      reason: 'SPEC-1A section 5.2: 24-hour-lived unverified signup attempts.',
    },
  };

  // FK order. Not a preference (ADR-055).
  await migrateCategories({ prisma, models, stats });
  await migrateUsers({ prisma, models, stats });
  await migrateDonations({ prisma, models, stats });

  return stats;
}

module.exports = { runMigration, canonicalStatus, requireMinor, plausibleDate };
