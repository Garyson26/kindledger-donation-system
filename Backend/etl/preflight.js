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
 * A RUN WITH ANY BLOCKING FINDING REFUSES TO LOAD. There is no override; see
 * `finding()` below and ETL-01.
 * =============================================================================
 */

'use strict';

const mongoose = require('mongoose');

// The plausible date floor, shared with the retention purge (AG1a).
const { PLAUSIBLE_FLOOR } = require('../services/scheduler');
// AS2: the single declaration of which store is authoritative per entity.
const migrationState = require('../config/migrationState');

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

/**
 * A finding.
 *
 * `blocking` stops the load. There is NO override flag - ETL-01, and the reason
 * is recorded at length in `cli.js`: every blocking finding is one the loader
 * also refuses, so an override could never load the rows it was overriding. It
 * could only turn a clean refusal into a partial load.
 *
 * `refusedAtLoad` records which findings THE LOAD would also refuse. That is
 * what the refusal message uses to tell an operator that fixing the source data
 * is the only path.
 *
 * -----------------------------------------------------------------------------
 * IT WAS CALLED `refusedAtLoad`, AND THE NAME WAS A LIE ABOUT THE MECHANISM (BD1)
 * -----------------------------------------------------------------------------
 * The flag is true about the SYSTEM and false about the LOADER. **Two of the
 * five refusals do not come from any check in `migrate.js` at all** - they come
 * from the SCHEMA:
 *
 *   | finding                 | what actually refuses it                        |
 *   |-------------------------|-------------------------------------------------|
 *   | strict-sql-mode         | NOTHING. Acknowledged below - see the allowlist |
 *   | case-variant-emails     | **SCHEMA**: `uq_users_email` under               |
 *   |                         | `utf8mb4_0900_as_ci`, which is case-INsensitive |
 *   | mixed-case-status       | **SCHEMA**: the `ENUM` plus STRICT_TRANS_TABLES |
 *   | orphaned-category       | `migrate.js` - an explicit throw                |
 *   | implausible-dates       | `migrate.js` - an explicit throw                |
 *
 * The old name invited exactly the reasoning that produced the original error:
 * read "refusedAtLoad", look in `migrate.js`, find nothing, conclude the flag is
 * wrong. That is how `mixed-case-status` came to be marked false while its own
 * detail text said MySQL would reject the rows.
 *
 * **A property owned by the schema and named after the loader is invisible to
 * anyone changing the schema.** Relaxing the email collation, or dropping
 * `uq_users_email`, silently removes an ETL safety property - and nothing in
 * `migrate.js` would change. `db/schema.sql` now carries that warning where the
 * mistake gets made (AI4), and `test/etl.test.js` asserts the refusals by their
 * SHAPE - `P2002` / `Duplicate entry` - rather than by a message of ours, so the
 * check fails if the schema stops providing them.
 *
 * -----------------------------------------------------------------------------
 * IT IS NOW ENFORCED AT CONSTRUCTION TIME (BB4), AND THE DAY HAD ALREADY COME
 * -----------------------------------------------------------------------------
 * This flag used to be described as "the thing to check if a BLOCKING-but-
 * loadable finding is ever added". A day that has to be noticed by someone
 * re-reading a comment is a day that does not announce itself - so the check is
 * now the constructor, and adding such a finding THROWS.
 *
 * **Writing the check found that the day had already arrived, twice:**
 *
 *   - `mixed-case-status` (non-canonicalisable) was blocking with the flag
 *     FALSE, and that was simply WRONG: MySQL rejects an out-of-set ENUM under
 *     strict mode, so the load does refuse it. The flag that existed to
 *     announce the day was itself mis-set on the finding.
 *   - `strict-sql-mode` is GENUINELY blocking-but-loadable. The loader does not
 *     throw on a permissive `sql_mode`; it silently truncates. There is nothing
 *     to override, because the remedy is to fix the connection and not the data.
 *
 * So the allowlist below is an ALLOWLIST OF ACKNOWLEDGED CASES, each with the
 * reason an override would be meaningless for it. A new blocking-but-loadable
 * finding fails loudly until somebody writes that reason down - which is the
 * day announcing itself, instead of waiting to be noticed.
 */
const BLOCKING_BUT_LOADABLE = new Map([
  [
    'strict-sql-mode',
    'The loader does not refuse a permissive sql_mode - it truncates and clamps ' +
      'silently, which is the whole danger. An override is meaningless because ' +
      'the remedy is the CONNECTION, not the source data.',
  ],
]);

function finding(check, severity, detail, blocking = true, refusedAtLoad = false) {
  if (blocking && !refusedAtLoad && !BLOCKING_BUT_LOADABLE.has(check)) {
    throw new Error(
      `PREFLIGHT INVARIANT: '${check}' is BLOCKING but declares refusedAtLoad=false. ` +
        'Either the load does refuse it - by a throw in migrate.js OR by a SCHEMA ' +
        'constraint, both count (set refusedAtLoad=true) - or this is a genuinely ' +
        'blocking-but-loadable finding, in which case add it to ' +
        'BLOCKING_BUT_LOADABLE with the reason an override would be meaningless ' +
        'for it. ETL-01 is what this protects: an override that can only turn a ' +
        'clean refusal into a partial load.'
    );
  }
  return { check, severity, detail, blocking, refusedAtLoad };
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
        'the ETL will not choose.',
      true,
      // The second insert hits uq_users_email and throws mid-load (ETL-01).
      true
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
          !canonicalMatch,
          // AND THE LOADER REFUSES IT TOO (BB4). A value that is not a member of
          // the ENUM in any casing is REJECTED by MySQL under STRICT_TRANS_TABLES
          // - the detail above says so in words. The flag said otherwise, and it
          // was the flag whose job was to notice exactly this discrepancy.
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
          'reassign. The ETL will not invent one.',
        true,
        // migrate.js throws on a category reference that does not resolve (ETL-01).
        true
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
        'guessing the real one destroys it.',
      true,
      // migrate.js's plausibleDate() throws rather than inventing a date (ETL-01).
      true
    ),
  ];
}

// -----------------------------------------------------------------------------
// 7. Is the DECLARATION ahead of the DATA? (AS2)
// -----------------------------------------------------------------------------
/**
 * For every entity `config/migrationState.js` declares MySQL-authoritative and
 * the ETL carries across, compare row counts between the two stores.
 *
 * MySQL being declared authoritative means the routes READ IT AND NOTHING ELSE.
 * If MongoDB still holds rows MySQL has never seen, those rows are not stale -
 * THEY ARE GONE, as far as every reader is concerned. That is ADR-056's failure
 * exactly, and it is invisible from either side alone: MySQL looks healthy and
 * MongoDB looks untouched. The ETL is the only component that sees both, which
 * is why the check lives here rather than in a route or a boot probe.
 *
 * Counts rather than an id-by-id comparison, deliberately. It is O(1) against
 * both stores, it catches the case that matters - the new store is missing rows
 * - and the alternative walks every document to sharpen a number that already
 * says "run the load".
 */
async function checkDeclarationAgainstData(prisma, models) {
  const out = [];
  const table = { category: 'category', user: 'user', donation: 'donation' };

  for (const entity of migrationState.declaredAheadCandidates()) {
    const model = models[migrationState.stateFor(entity).model];
    const delegate = prisma[table[entity]];
    if (!model || !delegate) continue;

    const inMongo = await model.countDocuments();
    const migrated = await delegate.count({ where: { legacyId: { not: null } } });
    if (inMongo <= migrated) continue;

    out.push(
      finding(
        'declaration-ahead-of-data',
        'RECORD',
        `config/migrationState.js declares '${entity}' MySQL-authoritative, but ` +
          `MongoDB holds ${inMongo} row(s) and MySQL has ${migrated} migrated ` +
          `one(s) - ${inMongo - migrated} row(s) that every reader now treats as ` +
          'NON-EXISTENT rather than stale (ADR-056). RUNNING THIS LOAD IS THE ' +
          'REMEDY; if it persists afterwards, the declaration is wrong and the ' +
          'entity has not migrated.',
        // NOT BLOCKING, and getting this wrong once is worth recording. The
        // first version was BLOCKING - which deadlocked: a blocking finding
        // stops the load, and running the load is what fixes this finding. A
        // gate that prevents its own remedy is ETL-01's shape exactly ("an
        // option that can only make things worse"), reproduced in the check
        // written to honour it. Caught by running it rather than by reading it.
        false,
        false
      )
    );
  }
  return out;
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
  findings.push(...(await checkDeclarationAgainstData(prisma, models)));

  return {
    findings,
    blocking: findings.filter((f) => f.blocking),
    fatal: findings.filter((f) => f.severity === 'FATAL'),
    // ETL-01. Findings the LOADER will also refuse, so the override cannot help
    // and must not be offered - see finding().
    refusedByLoader: findings.filter((f) => f.refusedAtLoad),
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
  const r = (result.refusedByLoader || []).length;
  if (b === 0) {
    lines.push('  No blocking findings. The load may proceed.');
  } else {
    lines.push(`  ${b} BLOCKING finding(s). THE LOAD WILL REFUSE. There is no override.`);
    lines.push('');

    // THE REMEDY DIFFERS PER FINDING, so do not state one remedy for all of
    // them. An earlier version of this footer said "fix them in the SOURCE
    // data" for every case, and printed "refused by the loader as well ()" with
    // an empty list when none were - a summary asserting something untrue,
    // about a report whose entire purpose is to be trusted.
    if (r > 0) {
      const names = (result.refusedByLoader || []).map((f) => f.check).join(', ');
      for (const chunk of (
        `The loader refuses these rows too (${names}), so no override could ever ` +
        'have loaded them - it would only write everything up to the first one ' +
        'and then stop, leaving MySQL part-populated (ETL-01). Fix them in the ' +
        'SOURCE data and re-run; the load is idempotent by legacy_id, so a ' +
        're-run resumes rather than duplicates.'
      ).match(/.{1,68}(\s|$)/g) || []) {
        lines.push(`    ${chunk.trim()}`);
      }
    }
    if (r < b) {
      if (r > 0) lines.push('');
      for (const chunk of (
        'The remaining finding(s) are not refused by the loader - each one names ' +
        'its own remedy above, and for some of them RUNNING THIS LOAD IS THE ' +
        'REMEDY. Read the detail rather than assuming the source data is at fault.'
      ).match(/.{1,68}(\s|$)/g) || []) {
        lines.push(`    ${chunk.trim()}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  /** Exported for `test/preflight-findings.test.js` - BB4's invariant. */
  BLOCKING_BUT_LOADABLE,
  finding,
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
