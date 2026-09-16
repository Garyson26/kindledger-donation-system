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
 * THE SECOND GUARD: IDENTITY, NOT EMPTINESS (BB1)
 * -----------------------------------------------------------------------------
 * The emptiness check above catches an EMPTY source. **It does not catch a
 * POPULATED WRONG one**, which is the dangerous case: point this at a different
 * database that has documents of its own, the count is non-zero, the first guard
 * passes, and every genuine id absent from it is nulled.
 *
 * That gap was documented here as a residual and left to a 4b runbook step. It
 * was wrong twice over. AY1 says a mitigation that depends on a human cannot
 * carry a closure claim; and within minutes of the note being written, the test
 * suite demonstrated the gap on the author's own machine, nulling two genuine
 * category ids. A note next to the code did not reach the code (BA3).
 *
 * So the check is IDENTITY and it lives in the operation:
 *
 *   **If MongoDB holds documents for an entity but NOT ONE of the legacy_ids in
 *   MySQL is among them, this is not the database those rows came from.**
 *
 * A count cannot see that. Emptiness cannot see that. Only asking whether the
 * two sides share identifiers can, and sharing identifiers is what "the source
 * the rows came from" MEANS.
 *
 * THE CUTOVER IS WHY THIS COULD NOT WAIT. In 4b, production MongoDB IS the
 * oracle: there is no second copy to restore from, and a wrong-database run
 * destroys the migration history of every record permanently.
 *
 * -----------------------------------------------------------------------------
 * WHAT IDENTITY STILL DOES NOT COVER - PINNED, NOT NOTED (BB5)
 * -----------------------------------------------------------------------------
 * A PARTIALLY overlapping database still passes: an old snapshot of the right
 * database shares most ids, so `found` is non-empty, and the genuine ids added
 * since the snapshot are nulled.
 *
 * Identity cannot close that, because both sides genuinely do share
 * identifiers. What closes it is the per-entity MATCH RATE, which this now
 * reports on every run and which `--dry-run` prints before anything is written.
 *
 * **THAT RESIDUAL IS PINNED BY A TEST**, not left here as prose - see
 * `test/null-minted.test.js`, "a PARTIAL overlap is NOT caught". Per BA3 a
 * residual with no test is indistinguishable from one nobody thought about.
 *
 * -----------------------------------------------------------------------------
 * AND FOR THE CUTOVER IT IS A FLOOR, NOT A PRINTOUT (BC3)
 * -----------------------------------------------------------------------------
 * Printing the rate loudly is enough in development. It is not a control at a
 * cutover, where a human reads a number under time pressure - AY1 again.
 *
 * So `minMatchRate` REFUSES below a stated floor, and `null-minted-cli.js`
 * REQUIRES the flag on any apply run. The operator does not read a number and
 * judge it; they state an expectation beforehand and the run enforces it.
 *
 * **THE 4b VALUE IS 1.0, and the reason is specific rather than cautious.**
 * Minted legacy_ids are a PHASE 3 DEVELOPMENT ARTEFACT: they exist because
 * `routes/categories.js` and `repositories/users.js` fabricated them for rows
 * created through the running application. That code has never been deployed.
 * Production MySQL is populated by the ETL and by nothing else, so every
 * legacy_id in it came from production MongoDB and every one must resolve.
 *
 * A production rate below 1.0 therefore does not mean "some rows were minted".
 * It means **rows were deleted from MongoDB after the ETL ran, or this is not
 * the database the ETL read** - and both are reasons to stop, not to proceed.
 * The freeze window is what makes 1.0 attainable rather than aspirational.
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
async function nullMintedLegacyIds({
  prisma,
  models,
  dryRun = false,
  entities = null,
  minMatchRate = null,
}) {
  if (minMatchRate !== null) {
    if (typeof minMatchRate !== 'number' || minMatchRate < 0 || minMatchRate > 1) {
      throw new Error(`minMatchRate must be a number in [0, 1], got ${minMatchRate}`);
    }
  }

  const report = [];
  const pendingWrites = [];

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

    // =========================================================================
    // THE IDENTITY GUARD (BB1). Emptiness was not enough.
    // =========================================================================
    // Documents on the other side, and NOT ONE id in common, means this is not
    // the database these rows came from. Every row would look minted and every
    // genuine value would be destroyed - and in 4b, permanently, because
    // production MongoDB is the oracle and there is no second copy.
    //
    // Deliberately NOT a threshold. A threshold has to be chosen, argued about
    // and eventually relaxed; "share at least one identifier" is the weakest
    // possible statement of "this is the same database" and needs no number.
    if (found.size === 0) {
      const err = new Error(
        `REFUSING: MongoDB holds ${mongoDocuments} '${entity}' document(s), but ` +
          `NOT ONE of the ${rows.length} legacy_id value(s) in MySQL appears among ` +
          'them. Sharing no identifiers at all is what a DIFFERENT DATABASE looks ' +
          'like - the emptiness check cannot see this, because the collection is ' +
          'not empty. Running would NULL every legacy_id for this entity, and ' +
          'after the cutover that is not recoverable. Check MONGODB_URI names the ' +
          'database the ETL migrated FROM. If this entity really was created ' +
          "entirely after the migration, scope the run with `entities` and say so.",
      );
      err.code = 'ERR_SOURCE_MISMATCH';
      err.entity = entity;
      err.mongoDocuments = mongoDocuments;
      err.legacyRows = rows.length;
      throw err;
    }

    const minted = rows.filter((r) => !found.has(r.legacyId));

    // DEFERRED, NOT APPLIED HERE (BC3 + ETL-01). The floor is a property of
    // the WHOLE RUN: refusing on the third entity after writing the first two
    // is the partial-load failure this project has already made once. Every
    // entity is measured first; nothing is written until all of them pass.
    if (minted.length > 0) {
      pendingWrites.push({ entity, db, ids: minted.map((r) => r.id) });
    }

    report.push({
      entity,
      migrated: rows.length,
      mongoDocuments,
      minted: minted.length,
      nulled: 0,
      // The number that sees the PARTIAL-overlap case the identity guard cannot.
      // Reported on every run, including dry runs, because it is the only thing
      // an operator can compare against an expectation.
      matchRate: rows.length === 0 ? null : found.size / rows.length,
    });
  }

  // ===========================================================================
  // THE FLOOR (BC3). Checked across EVERY entity, before ANY write.
  // ===========================================================================
  // This is the only check that can see a PARTIALLY overlapping source - an old
  // snapshot of the right database, which shares most identifiers and so passes
  // the identity guard by construction.
  if (minMatchRate !== null) {
    const below = report.filter((r) => r.matchRate !== null && r.matchRate < minMatchRate);
    if (below.length > 0) {
      const err = new Error(
        'REFUSING: the match rate is below the floor you stated. ' +
          below
            .map(
              (r) =>
                `${r.entity}: ${(r.matchRate * 100).toFixed(1)}% of ${r.migrated} legacy_id ` +
                `value(s) were found in MongoDB, floor ${(minMatchRate * 100).toFixed(1)}%`
            )
            .join('; ') +
          '. At a production cutover the expected rate is 100%: MySQL is populated ' +
          'by the ETL and by nothing else, so every legacy_id came from the source ' +
          'and every one must resolve. A lower rate means rows were DELETED from ' +
          'MongoDB after the ETL ran, or this is NOT the database the ETL read. ' +
          'Both are reasons to stop. NOTHING HAS BEEN WRITTEN.'
      );
      err.code = 'ERR_MATCH_RATE_BELOW_FLOOR';
      err.entities = below.map((r) => ({ entity: r.entity, matchRate: r.matchRate }));
      err.minMatchRate = minMatchRate;
      throw err;
    }
  }

  if (!dryRun) {
    for (const w of pendingWrites) {
      // eslint-disable-next-line no-await-in-loop
      const res = await w.db.updateMany({
        where: { id: { in: w.ids } },
        data: { legacyId: null },
      });
      const row = report.find((r) => r.entity === w.entity);
      if (row) row.nulled = res.count;
    }
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
        `matched: ${r.matchRate === null ? '   n/a' : (r.matchRate * 100).toFixed(1) + '%'}   ` +
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
  // The match rate is the ONLY signal for a partially-overlapping source - an
  // old snapshot of the right database - which the identity guard passes by
  // construction. Printed loudly rather than left in the numbers above.
  const partial = report.filter((r) => r.matchRate !== null && r.matchRate < 1);
  if (partial.length > 0) {
    lines.push('');
    lines.push('  CHECK THESE MATCH RATES AGAINST WHAT YOU EXPECT:');
    for (const r of partial) {
      lines.push(
        `    ${r.entity.padEnd(10)} ${(r.matchRate * 100).toFixed(1)}% of legacy_id ` +
          `values were found in MongoDB. If that is lower than you expected, this ` +
          `may be an OLD SNAPSHOT of the right database rather than the right one.`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { nullMintedLegacyIds, formatReport, ENTITIES };
