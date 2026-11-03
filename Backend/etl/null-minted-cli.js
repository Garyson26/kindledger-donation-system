/**
 * AE1-a entry point. Same local-only guard as the ETL itself.
 *
 *   npm run etl:null-minted -- --dry-run
 *   npm run etl:null-minted -- --min-match-rate=1.0
 *
 * An apply run MUST state --min-match-rate (BC3). The dry run is what tells you
 * what to state. For the 4b cutover the value is 1.0 - see nullMintedLegacyIds.js.
 *
 * Phase 4b runs this against production, once, BEFORE the cutover deletes
 * MongoDB - which is the only window in which a minted id can be told apart
 * from a genuine one. See nullMintedLegacyIds.js.
 */

'use strict';

const mongoose = require('mongoose');
const { getPrisma, disconnect } = require('../config/prisma');
const { nullMintedLegacyIds, formatReport } = require('./nullMintedLegacyIds');
const { assertLocalTarget } = require('./cli');

function parseMinMatchRate(args) {
  const flag = args.find((a) => a.startsWith('--min-match-rate='));
  if (!flag) return null;
  const value = Number(flag.split('=')[1]);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--min-match-rate must be a number in [0, 1], got '${flag.split('=')[1]}'`);
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const minMatchRate = parseMinMatchRate(args);

  // ===========================================================================
  // AN APPLY RUN MUST STATE ITS EXPECTATION (BC3)
  // ===========================================================================
  // The match rate is the only signal for an OLD SNAPSHOT of the right database,
  // which shares most identifiers and so passes the identity guard. Printing it
  // is enough in development; at a cutover, a human reading a number under time
  // pressure is not a control (AY1).
  //
  // Required on every apply run rather than only in production, because a flag
  // that appears for the first time on the one run that matters is a flag
  // nobody has typed before. `--dry-run` is exempt: it writes nothing, and it is
  // the step that TELLS you what to state.
  if (!dryRun && minMatchRate === null) {
    throw new Error(
      'REFUSING: an apply run must state --min-match-rate=<0..1>. Run with ' +
        '--dry-run first; it reports the match rate per entity. FOR THE PHASE 4b ' +
        'CUTOVER THE VALUE IS 1.0 - production MySQL is populated by the ETL and ' +
        'by nothing else, so every legacy_id came from production MongoDB and ' +
        'every one must resolve. Minted ids are a Phase 3 development artefact ' +
        'and that code has never been deployed. A lower figure in production ' +
        'means rows were deleted from MongoDB after the ETL ran, or this is the ' +
        'wrong database.'
    );
  }

  // Phase 4a and 3.6 are LOCAL ONLY, exactly as the ETL is. Phase 4b lifts this
  // deliberately, with a runbook and a freeze window.
  assertLocalTarget(process.env.MONGODB_URI);

  await mongoose.connect(process.env.MONGODB_URI);
  const prisma = getPrisma();

  const models = {
    User: require('../models/User'),
    Category: require('../models/Category'),
    Donation: require('../models/Donation'),
  };

  const report = await nullMintedLegacyIds({ prisma, models, dryRun, minMatchRate });
  // eslint-disable-next-line no-console
  console.log(formatReport(report, dryRun));

  await cleanup();
}

async function cleanup() {
  await mongoose.connection.close().catch(() => {});
  await disconnect().catch(() => {});
}

if (require.main === module) {
  main().catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('\nAE1-a FAILED:', err && err.message ? err.message : err);
    await cleanup();
    process.exit(1);
  });
}

module.exports = { main };
