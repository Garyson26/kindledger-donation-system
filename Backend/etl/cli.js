/**
 * =============================================================================
 * ETL entry point (Phase 4a) - LOCAL ONLY
 * =============================================================================
 *   npm run etl:preflight          report only, never loads
 *   npm run etl                    pre-flight, then load if it is clean
 *   npm run etl -- --i-have-reviewed-the-preflight    load despite findings
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

const OVERRIDE = '--i-have-reviewed-the-preflight';

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
  const override = args.includes(OVERRIDE);

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
    // FATAL is not overridable. Strict mode is the one check whose failure
    // means every subsequent write is untrustworthy, so there is no flag for it.
    throw new Error('FATAL pre-flight finding. Not overridable.');
  }

  if (preflightOnly) {
    await cleanup();
    return;
  }

  // ETL-01. NOT OVERRIDABLE, and refused BEFORE anything is written.
  //
  // These are the findings whose rows `migrate.js` will also refuse. Overriding
  // one does not load it: the loader writes every row up to it and then throws,
  // which is how package 3.3's local donation load ended with two categories,
  // one user and four of five donations in MySQL. A partial load is strictly
  // worse than a refusal, so the flag does not reach this class.
  if (result.refusedByLoader.length > 0) {
    throw new Error(
      `${result.refusedByLoader.length} pre-flight finding(s) that the LOADER also ` +
        `refuses: ${result.refusedByLoader.map((f) => f.check).join(', ')}. ` +
        `${OVERRIDE} does not apply to these - it would start the load and stop ` +
        'partway, leaving MySQL part-populated. Fix them in the SOURCE data and ' +
        're-run; the load is idempotent by legacy_id.'
    );
  }

  if (result.blocking.length > 0 && !override) {
    throw new Error(
      `${result.blocking.length} blocking pre-flight finding(s). Resolve them in the ` +
        `SOURCE data, or re-run with ${OVERRIDE} if you have read the report and ` +
        'accept what it says. The ETL will not correct them for you.'
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
