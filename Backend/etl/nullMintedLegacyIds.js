/**
 * =============================================================================
 * AE1-a - NULL every MINTED legacy_id, while MongoDB can still be read
 * =============================================================================
 *   npm run etl:null-minted -- --dry-run     report only
 *   npm run etl:null-minted                  apply
 *
 * SPEC-1A section 4.1 says a non-NULL `legacy_id` means "this row came from
 * MongoDB". During Phase 3 that stopped being true: `routes/categories.js` and
 * `repositories/users.js` MINTED ObjectId-shaped values for rows that had never
 * been near MongoDB, because `Donation.category` and `Donation.userId` were
 * required Mongoose ObjectId refs and a MySQL-only row could not be referenced
 * by one.
 *
 * Both minters are now gone (AE1-b in package 3.4; users in 3.6). This removes
 * the values they left behind, and afterwards the invariant is true again -
 * deliberately restored rather than never broken (ADR-051(c)).
 *
 * -----------------------------------------------------------------------------
 * THE ORDERING IS THE WHOLE POINT, AND IT HAS NO SECOND CHANCE
 * -----------------------------------------------------------------------------
 * A minted id and a genuine one are the same 24 hex characters. **The ONLY thing
 * that distinguishes them is whether a MongoDB document with that `_id` exists.**
 *
 * Once MongoDB is gone, that question is unanswerable for ever. Not
 * expensive - unanswerable. Every `legacy_id` becomes permanently ambiguous, and
 * anything that later relies on the invariant is relying on a guess.
 *
 * So this runs in package 3.6, BEFORE the cutover deletes anything, and it is
 * asserted by `test/null-minted.test.js` rather than left to a runbook step
 * somebody performs in the right order.
 *
 * -----------------------------------------------------------------------------
 * THE DANGEROUS FAILURE, AND THE GUARD FOR IT
 * -----------------------------------------------------------------------------
 * **Pointed at the WRONG MongoDB - or an empty one - this NULLs every genuine
 * `legacy_id` in the database.** Absence of a document is the whole signal, and
 * an empty source makes every row look minted.
 *
 * That is the same shape as the ETL's own Atlas guard: the ordinary mistake is
 * an exported shell variable, not an attacker. So:
 *
 *   - if an entity has migrated rows in MySQL and MongoDB holds ZERO documents
 *     for it, THE RUN REFUSES. That is the signature of the wrong database, and
 *     it is indistinguishable from "everything was minted" by any other means.
 *   - `--dry-run` reports without writing, and the report names counts per
 *     entity so the operator can sanity-check them against what they expect.
 *
 * It does NOT refuse on a merely surprising proportion, because a development
 * database legitimately has mostly-minted rows. The refusal is for the case
 * that cannot be legitimate: migrated rows on one side, nothing at all on the
 * other.
 *
 * -----------------------------------------------------------------------------
 * THE RESIDUAL, STATED RATHER THAN IMPLIED
 * -----------------------------------------------------------------------------
 * The guard catches an EMPTY source. It does NOT catch a POPULATED WRONG one:
 * if the ETL migrated from database A and this is pointed at database B, and B
 * holds documents of its own, the count is non-zero, the guard passes, and every
 * genuine id that happens not to exist in B is nulled.
 *
 * There is no purely local way to close that - "is this the database we migrated
 * from" is not answerable from either side alone. **Phase 4b must run
 * `--dry-run` FIRST and compare the per-entity counts against what it expects**,
 * which is the only check that can see it. That is a runbook step, and it is a
 * runbook step because the alternative is a threshold that would fire constantly
 * on development data and be turned off.
 *
 * -----------------------------------------------------------------------------
 * AND THE FALSE REFUSAL, WHICH IS THE SAME GUARD SEEN FROM THE OTHER SIDE
 * -----------------------------------------------------------------------------
 * If an entity is LEGITIMATELY all-minted - every row created after the
 * migration, none of them ever in MongoDB - then MongoDB holds zero documents
 * for it and THE RUN REFUSES even though nulling all of them is exactly right.
 *
 * That case is indistinguishable from the wrong database BY CONSTRUCTION, which
 * is the whole finding: no amount of care at this end tells them apart. The
 * refusal is the correct default because one mistake is recoverable (scope the
 * run with `entities` and say why) and the other is not.
 *
 * It is not hypothetical - it is how `test/null-minted.test.js`'s dry-run case
 * first failed, with a fixture that created a minted row and no genuine one.
 * ==============================================================================
 */

'use strict';

/** Entities carrying `legacy_id`, and the Mongoose model that would prove one. */
const ENTITIES = [
  { entity: 'category', delegate: 'category', model: 'Category' },
  { entity: 'user', delegate: 'user', model: 'User' },
  { entity: 'donation', delegate: 'donation', model: 'Donation' },
];

/**
 * @returns {{entity:string, migrated:number, mongoDocuments:number,
 *            minted:number, nulled:number, refused?:string}[]}
 */
async function nullMintedLegacyIds({ prisma, models, dryRun = false, entities = null }) {
  const report = [];

  for (const { entity, delegate, model } of ENTITIES) {
    // `entities` scopes the run. Operationally it allows one entity at a time
    // against a large production database; in tests it is what lets a suite
    // exercise the mechanism without its own MySQL fixtures tripping the
    // wrong-database guard on an unrelated table.
    if (entities && !entities.includes(entity)) continue;

    const Model = models[model];
    const db = prisma[delegate];
    if (!Model || !db) continue;

    const rows = await db.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });

    if (rows.length === 0) {
      report.push({ entity, migrated: 0, mongoDocuments: 0, minted: 0, nulled: 0 });
      continue;
    }

    const mongoDocuments = await Model.countDocuments();

    // THE GUARD. Rows on one side and nothing at all on the other is the
    // signature of the wrong database, and it is the only case where "every row
    // looks minted" cannot be legitimate.
    if (mongoDocuments === 0) {
      const err = new Error(
        `REFUSING: MySQL holds ${rows.length} '${entity}' row(s) with a legacy_id, ` +
          'and MongoDB holds NO documents for it at all. Absence of a document is ' +
          'the only thing that distinguishes a minted id from a genuine one, so ' +
          'against the wrong database - or an empty one - this would NULL every ' +
          'genuine value permanently. Check MONGODB_URI names the database the ' +
          'ETL migrated FROM.'
      );
      err.code = 'ERR_SOURCE_EMPTY';
      err.entity = entity;
      throw err;
    }

    // Which of these ids actually exist in MongoDB? Batched, because one query
    // per row against a production database is a different kind of mistake.
    const ids = rows.map((r) => r.legacyId);
    const found = new Set();
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      // eslint-disable-next-line no-await-in-loop
      const docs = await Model.find({ _id: { $in: slice } }, { _id: 1 }).lean();
      for (const d of docs) found.add(String(d._id));
    }

    const minted = rows.filter((r) => !found.has(r.legacyId));

    let nulled = 0;
    if (!dryRun && minted.length > 0) {
      const res = await db.updateMany({
        where: { id: { in: minted.map((r) => r.id) } },
        data: { legacyId: null },
      });
      nulled = res.count;
    }

    report.push({
      entity,
      migrated: rows.length,
      mongoDocuments,
      minted: minted.length,
      nulled,
    });
  }

  return report;
}

function formatReport(report, dryRun) {
  const lines = [''];
  lines.push(
    dryRun
      ? 'AE1-a: minted legacy_id report - DRY RUN, nothing has been changed'
      : 'AE1-a: minted legacy_id removal'
  );
  lines.push('-'.repeat(74));
  for (const r of report) {
    lines.push(
      `  ${r.entity.padEnd(10)} legacy_id rows: ${String(r.migrated).padStart(6)}   ` +
        `mongo docs: ${String(r.mongoDocuments).padStart(6)}   ` +
        `minted: ${String(r.minted).padStart(6)}   ` +
        `${dryRun ? 'would null' : 'nulled'}: ${r.dryRunOnly || r.nulled}`
    );
  }
  lines.push('-'.repeat(74));
  const totalMinted = report.reduce((n, r) => n + r.minted, 0);
  lines.push(
    totalMinted === 0
      ? '  No minted values remain. SPEC-1A section 4.1s invariant holds.'
      : `  ${totalMinted} minted value(s)${dryRun ? ' would be' : ''} removed.`
  );
  lines.push('');
  return lines.join('\n');
}

module.exports = { nullMintedLegacyIds, formatReport, ENTITIES };
