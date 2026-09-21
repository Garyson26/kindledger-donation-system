/**
 * =============================================================================
 * Rebuild the LOCAL legacy MongoDB from MySQL's own legacy_id values
 * =============================================================================
 *   npm run fixture:legacy-mongo
 *
 * DEVELOPMENT FIXTURE. Never run against anything but a local MongoDB.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS, AND THE MISTAKE IT DOCUMENTS
 * -----------------------------------------------------------------------------
 * `docker-compose.legacy-mongo.yml` says of the `mongo` service:
 *
 *   "No volume, deliberately. State that survives a restart would start looking
 *    like a development database people rely on."
 *
 * **It started looking like one anyway.** Package 3.6 treated
 * `kindledger_legacy` as the source of truth for AE1-a's oracle - the thing that
 * distinguishes a MINTED legacy_id from a GENUINE one - and
 * `null-minted.test.js`'s guard consults it before deciding what to destroy.
 *
 * Then a `docker compose down` removed the container, and with it every
 * document, exactly as the comment promised. The `legacy_id` values in MySQL
 * now point at nothing, so **minted and genuine are locally indistinguishable**
 * - which is precisely the irreversibility AE1-a exists to warn about,
 * demonstrated on the development stack rather than at the cutover.
 *
 * The comment was right and the practice grew around it regardless. A warning
 * that a thing is ephemeral does not stop people depending on it; a cheap way
 * to rebuild it does.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT REBUILDS, AND WHAT IT CANNOT
 * -----------------------------------------------------------------------------
 * For every MySQL row carrying a `legacy_id`, it creates a MongoDB document
 * with THAT `_id`. The ids are what the oracle needs; the field values are
 * reconstructed from MySQL and are not the original documents.
 *
 * So this restores **the ability to tell migrated rows from minted ones**, and
 * it restores AE3 part 2's "a database holding both migrated and post-3.1
 * records". It does NOT restore the original MongoDB content, and it never
 * could - that content is gone. Nothing in the project needs it; every consumer
 * of a `legacy_id` asks only whether a document with that id EXISTS.
 * =============================================================================
 */

'use strict';

const mongoose = require('mongoose');
const { getPrisma, disconnect } = require('../config/prisma');

/** Same shape as the ETL's own guard: the ordinary mistake is a shell variable. */
function assertLocalTarget(uri) {
  const value = String(uri || '');
  if (!value) throw new Error('MONGODB_URI is not set.');
  if (/mongodb\+srv:|\.mongodb\.net|atlas/i.test(value)) {
    throw new Error(
      `REFUSING: MONGODB_URI looks like a hosted cluster (${value.slice(0, 40)}...). ` +
        'This is a development fixture builder and it WRITES. Local only.'
    );
  }
  if (!/@?(localhost|127\.0\.0\.1|mongo)(:|\/)/.test(value)) {
    throw new Error(`REFUSING: MONGODB_URI does not look local: ${value.slice(0, 60)}`);
  }
}

async function main() {
  assertLocalTarget(process.env.MONGODB_URI);
  await mongoose.connect(process.env.MONGODB_URI);

  const prisma = getPrisma();
  const models = {
    Category: require('../models/Category'),
    User: require('../models/User'),
    Donation: require('../models/Donation'),
  };

  const plan = [
    {
      entity: 'category',
      Model: models.Category,
      rows: await prisma.category.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true, name: true, shortDescription: true, donationAmountMinor: true },
      }),
      doc: (r) => ({
        _id: new mongoose.Types.ObjectId(r.legacyId),
        name: r.name,
        sortDescription: r.shortDescription || 'rebuilt fixture',
        donationAmount: Number(r.donationAmountMinor || 0) / 100,
        descriptions: [],
      }),
    },
    {
      entity: 'user',
      Model: models.User,
      rows: await prisma.user.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true, name: true, email: true, role: true, isActive: true },
      }),
      doc: (r) => ({
        _id: new mongoose.Types.ObjectId(r.legacyId),
        name: r.name,
        email: r.email,
        // A bcrypt hash of nothing usable. This fixture must never authenticate
        // anyone: the request path stopped reading MongoDB in package 3.6, and
        // a working credential here would be a login that cannot be audited.
        password: 'REBUILT-FIXTURE-NOT-A-HASH',
        role: r.role === 'admin' ? 'admin' : 'user',
        isVerified: true,
        isActive: r.isActive !== false,
      }),
    },
    {
      entity: 'donation',
      Model: models.Donation,
      rows: await prisma.donation.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true, donorName: true, donorEmail: true, amountMinor: true },
      }),
      doc: (r) => ({
        _id: new mongoose.Types.ObjectId(r.legacyId),
        donorName: r.donorName || 'Rebuilt Fixture',
        donorEmail: r.donorEmail || 'rebuilt@invalid.test',
        amount: Number(r.amountMinor || 0) / 100,
        date: new Date('2024-01-01T00:00:00Z'),
        quantity: 1,
      }),
    },
  ];

  const lines = ['', 'Rebuilding the local legacy MongoDB from MySQL legacy_id values', '-'.repeat(70)];

  for (const { entity, Model, rows, doc } of plan) {
    let created = 0;
    let present = 0;

    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      if (await Model.exists({ _id: new mongoose.Types.ObjectId(r.legacyId) })) {
        present += 1;
        continue;
      }
      // IDEMPOTENT, and never an update. A document that already exists is left
      // exactly as it is - this rebuilds what is MISSING and does not decide
      // that its own reconstruction is better than whatever is there.
      // eslint-disable-next-line no-await-in-loop
      await Model.collection.insertOne(doc(r));
      created += 1;
    }

    lines.push(
      `  ${entity.padEnd(10)} MySQL legacy_id rows: ${String(rows.length).padStart(5)}   ` +
        `already present: ${String(present).padStart(5)}   created: ${String(created).padStart(5)}`
    );
  }

  lines.push('-'.repeat(70));
  lines.push('  AE1-a can distinguish minted from genuine again, locally.');
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));

  await mongoose.connection.close().catch(() => {});
  await disconnect().catch(() => {});
}

if (require.main === module) {
  main().catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('\nREBUILD FAILED:', err && err.message ? err.message : err);
    await mongoose.connection.close().catch(() => {});
    await disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { main, assertLocalTarget };
