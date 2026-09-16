/**
 * AE1-a entry point. Same local-only guard as the ETL itself.
 *
 *   npm run etl:null-minted -- --dry-run
 *   npm run etl:null-minted
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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

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

  const report = await nullMintedLegacyIds({ prisma, models, dryRun });
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
