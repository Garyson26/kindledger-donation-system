/**
 * =============================================================================
 * ETL pre-flight (Phase 4a) - REPORT ONLY. IT NEVER CORRECTS ANYTHING.
 * =============================================================================
 * SPEC-1A section 8's reports, plus the two that later packages added.
 *
 * THE RULE THAT GOVERNS EVERY CHECK HERE: report and stop. Never silently
 * correct. A value that cannot be right is EVIDENCE about the old system, and
 * a migration that quietly repairs it destroys the only record that the defect
 * existed - along with any chance of knowing how many donors it affected.
 *
 * Two of these reports are the ONLY surviving record of a finding's blast
 * radius:
 *
 *   * MIXED-CASE STATUS (BUG-02). MySQL does NOT reject `'approved'` - the
 *     `_ci` collation canonicalises it to `'Approved'` on insert, silently
 *     (ADR-018, found by a schema test that asserted the opposite and was
 *     wrong). So AFTER the load there is no way to tell which rows were
 *     written by the broken admin endpoint. This count is the record.
 *   * FLOAT-TO-PAISE ROUNDING. Once `amount` is an integer in minor units the
 *     original float is gone. If rounding moved a value, this is where it is
 *     recorded.
 *
 * A run with unresolved findings REFUSES TO LOAD without an explicit override.
 * =============================================================================
 */

'use strict';

const mongoose = require('mongoose');

// The plausible date floor, shared with the retention purge (AG1a).
const { PLAUSIBLE_FLOOR } = require('../services/scheduler');

/**
 * Convert a major-unit amount to integer minor units, reporting any rounding.
 *
 * Deliberately NOT `repositories/_shared.toMinorUnits`: that one REFUSES
 * anything it cannot represent exactly, which is right for a live request and
 * wrong here. The ETL must be able to say "this value rounded, by this much",
 * which means it has to do the conversion and compare rather than decline it.
 */
function toMinorWithDelta(value) {
  if (value === null || value === undefined) return { minor: null, delta: 0, ok: false };
  const n = Number(value);
  if (!Number.isFinite(n)) return { minor: null, delta: 0, ok: false };
  const exact = n * 100;
  const minor = Math.round(exact);
  // The residual after rounding, expressed in minor units. Non-zero means the
  // stored value is not the value the donor was charged.
  const delta = Math.abs(exact - minor);
  return { minor, delta, ok: true };
}

/** A finding. `blocking` decides whether the load may proceed without an override. */
function finding(check, severity, detail, blocking = true) {
  return { check, severity, detail, blocking };
}

// -----------------------------------------------------------------------------
// 1. Strict SQL mode, ON THE ETL'S OWN CONNECTION (ADR-022)
// -----------------------------------------------------------------------------
// The API checks strict mode at boot. THAT DOES NOT COVER THIS CONNECTION.
// `sql_mode` is a session variable: a connection opened with different defaults,
// through a different pool, or via a proxy that resets session state, can be
// permissive while the application's connection is strict.
//
// It matters more here than anywhere else in the project. Without
// STRICT_TRANS_TABLES, an over-long VARCHAR is TRUNCATED with a warning instead
// of rejected, and an out-of-range number is CLAMPED. On the largest single
// write in this system's life, that is silent data corruption at scale - and it
// would look like a clean run.
async function checkStrictMode(prisma) {
  const rows = await prisma.$queryRawUnsafe('SELECT @@SESSION.sql_mode AS mode');
  const mode = String((rows && rows[0] && rows[0].mode) || '');
  const strict = /STRICT_TRANS_TABLES|STRICT_ALL_TABLES/.test(mode);
  return strict
    ? []
    : [
        finding(
          'strict-sql-mode',
          'FATAL',
          `The ETL's own connection has sql_mode='${mode}', which is NOT strict. ` +
            'Over-long values would be truncated and out-of-range numbers clamped, ' +
            'silently, on the largest write this system will ever perform. ' +
            'Refusing to continue (ADR-022).'
        ),
      ];
}

// -----------------------------------------------------------------------------
// 2. Case-variant duplicate emails
// -----------------------------------------------------------------------------
// MySQL's `utf8mb4_0900_as_ci` makes `users.email` UNIQUE case-insensitively.
// MongoDB's index is case-SENSITIVE, so `Ann@x.com` and `ann@x.com` are two
// accounts there and one row here. The second insert fails.
//
// It is not the ETL's business to decide which account wins: they may have
// different passwords, different donations and different people behind them.
async function checkDuplicateEmails(User) {
  const rows = await User.aggregate([
    { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  return rows.map((r) =>
    finding(
      'case-variant-emails',
      'BLOCKING',
      `${r.count} accounts collapse to '${r._id}' under the case-insensitive unique ` +
        `index: ${r.ids.map(String).join(', ')}. A human must decide which survives; ` +
        'the ETL will not choose.'
    )
  );
}

// -----------------------------------------------------------------------------
// 3. Mixed-case status values (BUG-02) - THE BLAST-RADIUS RECORD
// -----------------------------------------------------------------------------
async function checkMixedCaseStatus(Donation) {
  const out = [];
  for (const field of ['status', 'paymentStatus']) {
    const rows = await Donation.aggregate([
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const canonical =
      field === 'status'
        ? ['Pending', 'Approved', 'Rejected']
        : ['Pending', 'Paid', 'Failed', 'Cancelled'];

    for (const r of rows) {
      const v = r._id;
      if (v === null || v === undefined) continue;
      if (canonical.includes(v)) continue;
      const canonicalMatch = canonical.find((c) => c.toLowerCase() === String(v).toLowerCase());
      out.push(
        finding(
          'mixed-case-status',
          canonicalMatch ? 'RECORD' : 'BLOCKING',
          canonicalMatch
            ? `${r.count} donation(s) have ${field}='${v}', which MySQL will silently ` +
              `canonicalise to '${canonicalMatch}'. THIS COUNT IS THE ONLY RECORD of ` +
              "BUG-02's blast radius - after the load the two are indistinguishable."
            : `${r.count} donation(s) have ${field}='${v}', which is not a member of the ` +
              'ENUM in any casing. MySQL will REJECT these rows.',
          // A canonicalisable value is recorded, not blocking: the load is
          // correct, we simply lose the ability to count it afterwards.
          !canonicalMatch
        )
      );
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// 4. Float-to-paise rounding deltas
// -----------------------------------------------------------------------------
async function checkRounding(Donation) {
  const out = [];
  const cursor = Donation.find({}, { amount: 1, baseAmount: 1, extraAmount: 1 }).cursor();
  let affected = 0;
  let worst = 0;
  let example = null;
  for await (const d of cursor) {
    for (const field of ['amount', 'baseAmount', 'extraAmount']) {
      const v = d[field];
      if (v === null || v === undefined) continue;
      const { delta, ok } = toMinorWithDelta(v);
      if (!ok) continue;
      // A float that is not exactly representable in paise. 1e-9 absorbs the
      // representation error in the multiplication itself.
      if (delta > 1e-9) {
        affected += 1;
        if (delta > worst) {
          worst = delta;
          example = `${d._id} ${field}=${v}`;
        }
      }
    }
  }
  if (affected > 0) {
    out.push(
      finding(
        'float-rounding',
        'RECORD',
        `${affected} amount value(s) do not convert exactly to paise. Worst residual ` +
          `${worst.toFixed(6)} minor units (${example}). After the load the original ` +
          'float is gone, so this report is the only record that rounding occurred.',
        false
      )
    );
  }
  return out;
}

// -----------------------------------------------------------------------------
// 5. amount != base + extra
// -----------------------------------------------------------------------------
// The schema deliberately has NO CHECK asserting this (SPEC-1A section 5.5):
// historical rows predate server-side amount calculation and need not satisfy
// it. So it has to be reported here or not at all.
async function checkAmountConsistency(Donation) {
  const out = [];
  const cursor = Donation.find(
    { baseAmount: { $ne: null } },
    { amount: 1, baseAmount: 1, extraAmount: 1 }
  ).cursor();
  let mismatched = 0;
  let example = null;
  for await (const d of cursor) {
    const a = toMinorWithDelta(d.amount).minor;
    const b = toMinorWithDelta(d.baseAmount).minor;
    const e = toMinorWithDelta(d.extraAmount || 0).minor;
    if (a === null || b === null) continue;
    if (a !== b + e) {
      mismatched += 1;
      if (!example) example = `${d._id}: amount=${d.amount} base=${d.baseAmount} extra=${d.extraAmount || 0}`;
    }
  }
  if (mismatched > 0) {
    out.push(
      finding(
        'amount-consistency',
        'RECORD',
        `${mismatched} donation(s) where amount != base + extra. First: ${example}. ` +
          'Migrated verbatim - the schema has no CHECK for this on purpose, because ' +
          'rows predating server-side amount calculation need not satisfy it.',
        false
      )
    );
  }
  return out;
}

// -----------------------------------------------------------------------------
// 6. Orphaned category references
// -----------------------------------------------------------------------------
// `donations.category_id` is NOT NULL with ON DELETE RESTRICT, so a donation
// whose category was hard-deleted (the pre-ADR-004 behaviour) CANNOT be loaded.
// This is the single most likely blocking finding on real data.
async function checkOrphanedCategories(Donation, Category) {
  const ids = await Donation.distinct('category');
  const out = [];
  const missing = [];
  for (const id of ids) {
    if (!id) {
      missing.push('(null)');
      continue;
    }
    const exists = await Category.exists({ _id: id });
    if (!exists) missing.push(String(id));
  }
  if (missing.length > 0) {
    const counts = await Promise.all(
      missing
        .filter((m) => m !== '(null)')
        .map(async (m) => ({ id: m, n: await Donation.countDocuments({ category: m }) }))
    );
    const nullCount = missing.includes('(null)')
      ? await Donation.countDocuments({ category: null })
      : 0;
    out.push(
      finding(
        'orphaned-category',
        'BLOCKING',
        `${missing.length} category reference(s) do not resolve: ` +
          counts.map((c) => `${c.id} (${c.n} donation(s))`).join(', ') +
          (nullCount ? `, plus ${nullCount} donation(s) with no category at all` : '') +
          '. donations.category_id is NOT NULL with ON DELETE RESTRICT, so these ' +
          'rows cannot be loaded. A human must decide: recreate the category, or ' +
          'reassign. The ETL will not invent one.'
      )
    );
  }
  return out;
}

// -----------------------------------------------------------------------------
// 7. Implausible dates (AG1a / ADR-054)
// -----------------------------------------------------------------------------
async function checkDates(Donation) {
  const now = new Date();
  const bad = await Donation.countDocuments({
    $or: [{ date: { $lt: PLAUSIBLE_FLOOR } }, { date: { $gt: now } }, { date: null }],
  });
  if (bad === 0) return [];
  return [
    finding(
      'implausible-dates',
      'BLOCKING',
      `${bad} donation(s) have a date before ${PLAUSIBLE_FLOOR.toISOString()}, in the ` +
        'future, or absent. Loaded as-is they would fall inside the ten-year retention ' +
        'window and be deleted by the first cleanup run after cutover (BUG-10). ' +
        'Reported, never corrected - an impossible date is evidence of a defect, and ' +
        'guessing the real one destroys it.'
    ),
  ];
}

/**
 * Run every check. Returns findings; NEVER changes anything.
 */
async function runPreflight({ prisma, models }) {
  const { User, Category, Donation } = models;
  const findings = [];

  findings.push(...(await checkStrictMode(prisma)));
  findings.push(...(await checkDuplicateEmails(User)));
  findings.push(...(await checkMixedCaseStatus(Donation)));
  findings.push(...(await checkRounding(Donation)));
  findings.push(...(await checkAmountConsistency(Donation)));
  findings.push(...(await checkOrphanedCategories(Donation, Category)));
  findings.push(...(await checkDates(Donation)));

  return {
    findings,
    blocking: findings.filter((f) => f.blocking),
    fatal: findings.filter((f) => f.severity === 'FATAL'),
  };
}

function formatReport(result) {
  const lines = [];
  lines.push('');
  lines.push('ETL pre-flight (Phase 4a) - REPORT ONLY, nothing has been changed');
  lines.push('-'.repeat(74));
  if (result.findings.length === 0) {
    lines.push('  clean - no findings');
  }
  for (const f of result.findings) {
    lines.push(`  [${f.severity}] ${f.check}`);
    for (const chunk of String(f.detail).match(/.{1,68}(\s|$)/g) || []) {
      lines.push(`      ${chunk.trim()}`);
    }
  }
  lines.push('-'.repeat(74));
  const b = result.blocking.length;
  lines.push(
    b === 0
      ? '  No blocking findings. The load may proceed.'
      : `  ${b} BLOCKING finding(s). The load will refuse without --i-have-reviewed-the-preflight.`
  );
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  runPreflight,
  formatReport,
  toMinorWithDelta,
  PLAUSIBLE_FLOOR,
  // Exported individually so the tests can fire each one in isolation.
  checkStrictMode,
  checkDuplicateEmails,
  checkMixedCaseStatus,
  checkRounding,
  checkAmountConsistency,
  checkOrphanedCategories,
  checkDates,
};
