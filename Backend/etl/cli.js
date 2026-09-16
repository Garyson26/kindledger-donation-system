/**
 * =============================================================================
 * ETL entry point (Phase 4a) - LOCAL ONLY
 * =============================================================================
 *   npm run etl:preflight          report only, never loads
 *   npm run etl                    pre-flight, then load if it is clean
 *
 * THERE IS NO OVERRIDE FLAG, and there used to be (ETL-01, AR5). See below.
 *
 * THE PRE-FLIGHT ALWAYS RUNS. There is no way to load without it, because the
 * two reports it produces - mixed-case status counts and float rounding deltas
 * - are the ONLY record of those findings' blast radius once the data is in
 * MySQL. Skipping it would destroy evidence rather than merely omit a check.
 *
 * THIS PACKAGE DOES NOT TOUCH PRODUCTION. It reads whatever `MONGODB_URI`
 * names, and the guard below refuses an Atlas host outright: production access
 * belongs to Phase 4b, with a freeze window and a rollback boundary, and the
 * point of building the ETL now is that five route packages exercise it locally
 * first.
 * =============================================================================
 */

'use strict';

const mongoose = require('mongoose');
const { getPrisma, disconnect } = require('../config/prisma');
const { runPreflight, formatReport } = require('./preflight');
const { runMigration } = require('./migrate');

/**
 * WHY THERE IS NO `--i-have-reviewed-the-preflight` FLAG ANY MORE (ETL-01, AR5).
 *
 * There was one. Its purpose was to let an operator knowingly accept a BLOCKING
 * finding and load anyway.
 *
 * THE FIRST TIME IT WAS ACTUALLY USED, it wrote two categories, one user and
 * four of five donations, then threw on exactly the row the pre-flight had
 * reported - leaving MySQL part-populated. `migrate.js` refuses an implausible
 * date rather than inventing one, which is correct; but a `throw` fails the RUN,
 * not the ROW.
 *
 * Checked afterwards rather than assumed: EVERY blocking finding is one the
 * loader also refuses - implausible dates, orphaned category references, and
 * case-variant emails, which collide on `uq_users_email`. So overriding one
 * could never load the rows it was overriding. It could only convert a clean
 * refusal, with nothing written, into a partial load.
 *
 * AN OPTION THAT CAN ONLY MAKE THINGS WORSE IS WORSE THAN NO OPTION. The first
 * fix made the flag not apply to those findings - which left a documented flag
 * that applied to nothing, i.e. the same defect one level up. It is gone.
 *
 * If a BLOCKING-but-genuinely-loadable finding is ever added, the flag comes
 * back WITH IT, scoped to it, and not before.
 */

/**
 * Refuse anything that looks like production.
 *
 * A hostname check is not a security boundary - it is a guard against the
 * ordinary mistake of an exported shell variable. Phase 4b does production
 * deliberately, with a runbook. This package must not do it by accident.
 */
function assertLocalTarget(uri) {
  const u = String(uri || '');
  if (!u) throw new Error('MONGODB_URI is not set.');
  if (/mongodb\+srv:|\.mongodb\.net/i.test(u)) {
    throw new Error(
      'MONGODB_URI points at MongoDB Atlas. Phase 4a is LOCAL ONLY - production ' +
        'belongs to Phase 4b, with a freeze window and a rollback boundary. Refusing.'
    );
  }
  if (!/(127\.0\.0\.1|localhost|:\/\/mongo[:/])/i.test(u)) {
    throw new Error(
      `MONGODB_URI (${u.replace(/\/\/[^@]*@/, '//***@')}) is not a recognised local ` +
        'host. Refusing rather than guessing.'
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const preflightOnly = args.includes('--preflight-only');

  // A leftover flag from a previous run must not be silently ignored - that is
  // how an operator concludes it worked.
  const stale = args.find((a) => a.startsWith('--i-have-reviewed'));
  if (stale) {
    throw new Error(
      `${stale} no longer exists. Every blocking finding is one the loader also ` +
        'refuses, so overriding could only produce a partial load (ETL-01). Fix ' +
        'the findings in the SOURCE data and re-run; the load is idempotent by ' +
        'legacy_id, so a re-run resumes rather than duplicates.'
    );
  }

  assertLocalTarget(process.env.MONGODB_URI);

  await mongoose.connect(process.env.MONGODB_URI);
  const prisma = getPrisma();

  const models = {
    User: require('../models/User'),
    Category: require('../models/Category'),
    Donation: require('../models/Donation'),
    PendingSignup: require('../models/PendingSignup'),
  };

  const result = await runPreflight({ prisma, models });
  // eslint-disable-next-line no-console
  console.log(formatReport(result));

  if (result.fatal.length > 0) {
    // FATAL is kept separate from BLOCKING even though neither can now be
    // bypassed, because they mean different things: BLOCKING is "these ROWS
    // cannot be loaded", FATAL is "NO row can be trusted". Strict mode is the
    // only FATAL check, and it fails before the data is even examined.
    throw new Error('FATAL pre-flight finding: the ETL connection is not in strict mode.');
  }

  if (preflightOnly) {
    await cleanup();
    return;
  }

  // ETL-01. Refused BEFORE anything is written, which is the whole point: the
  // failure this replaces wrote two categories, one user and four of five
  // donations before throwing on the fifth.
  if (result.blocking.length > 0) {
    const refused = result.refusedByLoader.map((f) => f.check);
    throw new Error(
      `${result.blocking.length} blocking pre-flight finding(s)` +
        (refused.length > 0 ? `, all of which the LOADER also refuses: ${refused.join(', ')}` : '') +
        '. Resolve them in the SOURCE data and re-run. There is no override: it ' +
        'could only start the load and stop partway, leaving MySQL part-populated ' +
        '(ETL-01). The load is idempotent by legacy_id, so a re-run resumes rather ' +
        'than duplicates.'
    );
  }

  const stats = await runMigration({ prisma, models });

  // eslint-disable-next-line no-console
  console.log('\nETL load complete');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stats, null, 2));
  await cleanup();
}

async function cleanup() {
  await mongoose.connection.close().catch(() => {});
  await disconnect().catch(() => {});
}

if (require.main === module) {
  main().catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('\nETL FAILED:', err && err.message ? err.message : err);
    await cleanup();
    process.exit(1);
  });
}

module.exports = { assertLocalTarget, main };
