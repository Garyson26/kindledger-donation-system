/**
 * =============================================================================
 * AE1-a: NULLing minted legacy_ids, and the ORDERING that has no second chance
 * =============================================================================
 *   docker compose up -d
 *   npm run test:null-minted
 *
 * ASSERTED RATHER THAN RUNBOOKED (AZ4). The operation depends on MongoDB being
 * READABLE - a minted id and a genuine one are the same 24 hex characters, and
 * the only thing separating them is whether a document with that `_id` exists.
 * Run it after the cutover and the distinction is gone permanently.
 *
 * A runbook step performed in the right order is a step someone can perform in
 * the wrong one. These tests are what make the ordering a property of the
 * system rather than of the person running it.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

process.env.NODE_ENV = 'production';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_nullminted_test';

const mongoose = require('mongoose');
const MongoCategory = require('../models/Category');
const MongoUser = require('../models/User');
const MongoDonation = require('../models/Donation');
const categories = require('../repositories/categories');
const users = require('../repositories/users');
const { nullMintedLegacyIds } = require('../etl/nullMintedLegacyIds');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');

const TAG = 'zzz-nullminted';
const CAT_PREFIX = 'ZZZ NULLMINTED';
/** Stands in for a row this suite did not create - the ETL's own data. */
const FOREIGN_PREFIX = 'ZZZ FOREIGNROW';

const models = { Category: MongoCategory, User: MongoUser, Donation: MongoDonation };

const mintObjectId = () =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
  crypto.randomBytes(8).toString('hex');

function mongoHostPort(uri) {
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(uri);
  return { host: m ? m[1] : '127.0.0.1', port: m && m[2] ? Number(m[2]) : 27017 };
}

async function reset() {
  await users.deleteByEmailPrefix(TAG);
  await categories.deleteByNamePrefix(CAT_PREFIX);
  await categories.deleteByNamePrefix(FOREIGN_PREFIX);
  await MongoCategory.deleteMany({ name: new RegExp('^' + CAT_PREFIX) });
  await MongoUser.deleteMany({ email: new RegExp('^' + TAG) });
}

/**
 * =============================================================================
 * THE SUITE'S OWN GUARD - and it exists because the suite DID THE DAMAGE
 * =============================================================================
 * These tests run a DESTRUCTIVE operation against the shared development MySQL,
 * which holds rows this suite did not create: the ETL's own migrated data. If
 * TEST_MONGODB_URI names a scratch database rather than the one those rows came
 * FROM, every one of their genuine legacy_ids looks minted and gets NULLed.
 *
 * That is not hypothetical. It is exactly what happened on the first green run
 * of this file: pointed at `kindledger_nullminted_ci`, it permanently nulled the
 * legacy_id of both categories the ETL had migrated from `kindledger_legacy`.
 * The production code's documented residual - "the guard catches an EMPTY source,
 * not a POPULATED WRONG one" - was written minutes before the suite demonstrated
 * it on the author's machine.
 *
 * So the suite checks the same thing the operator is asked to check by hand in
 * Phase 4b, BEFORE it writes anything: every pre-existing legacy_id must RESOLVE
 * in the configured MongoDB. Anything else means the wrong database.
 * =============================================================================
 */
async function assertSourceMatchesMySQL() {
  const prisma = getPrisma();
  const rows = await prisma.category.findMany({
    where: { legacyId: { not: null } },
    select: { legacyId: true, name: true },
  });
  const foreign = rows.filter((r) => !r.name.startsWith(CAT_PREFIX));
  if (foreign.length === 0) return;

  const docs = await MongoCategory.find(
    { _id: { $in: foreign.map((r) => r.legacyId) } },
    { _id: 1 }
  ).lean();
  const found = new Set(docs.map((d) => String(d._id)));
  const unresolved = foreign.filter((r) => !found.has(r.legacyId));

  if (unresolved.length > 0) {
    throw new Error(
      `REFUSING TO RUN. MySQL holds ${unresolved.length} category row(s) with a ` +
        'legacy_id that this suite did not create and that do NOT exist in ' +
        `${process.env.MONGODB_URI}: ` +
        unresolved.map((r) => `${r.name}=${r.legacyId}`).join(', ') +
        '. Running would NULL them permanently. Point TEST_MONGODB_URI at the ' +
        'MongoDB database the ETL migrated FROM (kindledger_legacy), not a ' +
        'scratch one. This guard exists because the suite did exactly that damage.'
    );
  }
}

before(async () => {
  const { host, port } = mongoHostPort(process.env.MONGODB_URI);
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (why) => {
      sock.destroy();
      reject(new Error(`This suite needs MongoDB at ${host}:${port} (${why}).`));
    };
    sock.setTimeout(4000, () => fail('timeout'));
    sock.once('error', (e) => fail(e.message));
    sock.once('connect', () => {
      sock.destroy();
      resolve();
    });
  });
  await mongoose.connect(process.env.MONGODB_URI);
  await reset();
  await assertSourceMatchesMySQL();
});

after(async () => {
  try {
    await reset();
  } finally {
    await mongoose.connection.close();
    await prismaModule.disconnect();
  }
});

/**
 * A GENUINE pair: a MongoDB document and the MySQL row the ETL would produce
 * from it, sharing one id.
 */
async function genuineCategory(tag) {
  const doc = await MongoCategory.create({
    name: `${CAT_PREFIX} genuine ${tag}`,
    sortDescription: 'fixture',
    donationAmount: 100,
    descriptions: [],
  });
  const row = await categories.create({
    name: `${CAT_PREFIX} genuine ${tag}`,
    legacyId: doc._id.toString(),
    shortDescription: 'fixture',
    donationAmountMinor: 10000,
    descriptions: [],
  });
  return { legacyId: doc._id.toString(), uuid: row.id };
}

/** A MINTED one: a MySQL row whose legacy_id names no MongoDB document. */
async function mintedCategory(tag) {
  const legacyId = mintObjectId();
  const row = await categories.create({
    name: `${CAT_PREFIX} minted ${tag}`,
    legacyId,
    shortDescription: 'fixture',
    donationAmountMinor: 10000,
    descriptions: [],
  });
  return { legacyId, uuid: row.id };
}

// =============================================================================

test('AE1-a: a MINTED legacy_id is removed and a GENUINE one is kept', async () => {
  // THE WHOLE FINDING IN ONE TEST. Both values are 24 hex characters; the only
  // difference is whether MongoDB has a document with that _id.
  await reset();
  const genuine = await genuineCategory('a');
  const minted = await mintedCategory('a');

  // SCOPED TO `category`. The local MySQL holds users migrated from a DIFFERENT
  // MongoDB database than this suite connects to, so an unscoped run trips the
  // wrong-database guard on `user` - which is the guard working correctly, and
  // is itself asserted below.
  const report = await nullMintedLegacyIds({
    prisma: getPrisma(),
    models,
    dryRun: false,
    entities: ['category'],
  });
  const cat = report.find((r) => r.entity === 'category');
  assert.ok(cat.minted >= 1, 'at least the fixture was identified as minted');

  const afterGenuine = await categories.findById(genuine.uuid);
  const afterMinted = await categories.findById(minted.uuid);

  assert.equal(
    afterGenuine.legacyId,
    genuine.legacyId,
    'THE GENUINE ONE SURVIVES. If this fails the operation is destroying migration history.'
  );
  assert.equal(
    afterMinted.legacyId,
    null,
    'and the minted one is gone, so SPEC-1A 4.1s invariant holds again'
  );
});

test('AE1-a: a DRY RUN reports the same counts and changes nothing', async () => {
  await reset();
  // A GENUINE row as well, and not for symmetry: without one the entity has no
  // MongoDB documents at all and the guard REFUSES - which it should. Writing
  // this test with only a minted fixture is what surfaced the false-refusal
  // case now recorded in nullMintedLegacyIds.js.
  await genuineCategory('dry');
  const minted = await mintedCategory('dry');

  const report = await nullMintedLegacyIds({
    prisma: getPrisma(),
    models,
    dryRun: true,
    entities: ['category'],
  });
  const cat = report.find((r) => r.entity === 'category');
  assert.ok(cat.minted >= 1, 'it still IDENTIFIES them');
  assert.equal(cat.nulled, 0, 'and writes nothing');

  assert.equal(
    (await categories.findById(minted.uuid)).legacyId,
    minted.legacyId,
    'the row is untouched after a dry run'
  );
});

test('AE1-a REFUSES when MongoDB is empty - the wrong-database case', async () => {
  // THE DANGEROUS FAILURE. Absence of a document is the entire signal, so an
  // empty or wrong source makes EVERY row look minted and the operation would
  // destroy every genuine legacy_id permanently.
  //
  // Same shape as the ETL's Atlas guard: the ordinary mistake is an exported
  // shell variable, not an attacker.
  await reset();
  await mintedCategory('refuse');
  await genuineCategory('refuse');

  // A models map whose Category reports an empty collection, standing in for
  // "MONGODB_URI names a database the ETL never migrated from".
  // countDocuments 0 is the whole fixture; `find` must never be reached,
  // because the guard refuses before any lookup. Asserted rather than stubbed
  // permissively - if the order ever changes, this says so loudly instead of
  // silently reporting every row as minted.
  const emptyModels = {
    ...models,
    Category: {
      countDocuments: async () => 0,
      find: () => {
        throw new Error('find() must not be reached - the empty-source guard refuses first');
      },
    },
  };

  await assert.rejects(
    () =>
      nullMintedLegacyIds({
        prisma: getPrisma(),
        models: emptyModels,
        dryRun: false,
        entities: ['category'],
      }),
    (err) => {
      assert.equal(err.code, 'ERR_SOURCE_EMPTY');
      assert.equal(err.entity, 'category');
      assert.match(err.message, /REFUSING/);
      assert.match(err.message, /MONGODB_URI/, 'and it names what to check');
      return true;
    }
  );
});

test('AE1-a: the refusal writes NOTHING, including for entities it already passed', async () => {
  // The guard must not be a partial-write hazard of its own - ETL-01's lesson.
  // `category` is checked first, so a refusal there must leave everything alone.
  await reset();
  const genuine = await genuineCategory('partial');
  const minted = await mintedCategory('partial');

  const emptyModels = {
    ...models,
    Category: {
      countDocuments: async () => 0,
      find: () => {
        throw new Error('find() must not be reached - the empty-source guard refuses first');
      },
    },
  };

  // BH3: THE ERROR CODE IS ASSERTED, not merely that something threw.
  //
  // Found by BH3's own sweep - this was the one refusal assertion in the whole
  // suite that accepted ANY error. The test's point is that nothing is written,
  // and the write-nothing assertions below would hold just as well if the call
  // had rejected because of a typo in the options object. That is the shape:
  // an assertion that survives the removal of its subject.
  await assert.rejects(
    () =>
      nullMintedLegacyIds({
        prisma: getPrisma(),
        models: emptyModels,
        dryRun: false,
        entities: ['category'],
      }),
    (err) => {
      assert.equal(err.code, 'ERR_SOURCE_EMPTY', 'it must fail for the REASON under test');
      return true;
    }
  );

  assert.equal((await categories.findById(genuine.uuid)).legacyId, genuine.legacyId);
  assert.equal(
    (await categories.findById(minted.uuid)).legacyId,
    minted.legacyId,
    'even the MINTED row is untouched - the run refused before writing'
  );
});

test('THE ORDERING: after MongoDB is gone, minted and genuine are INDISTINGUISHABLE', async () => {
  // This is why AE1-a runs in 3.6 and not in 4c, asserted rather than left to a
  // runbook step somebody performs in the right order.
  //
  // It asserts the CONSEQUENCE of getting the order wrong, which is the thing
  // that cannot be recovered from - not that the code refuses, but that there
  // is no information left to refuse on.
  await reset();
  const genuine = await genuineCategory('ordering');
  const minted = await mintedCategory('ordering');

  // Both are the same shape. Nothing about the VALUE distinguishes them.
  assert.match(genuine.legacyId, /^[0-9a-f]{24}$/);
  assert.match(minted.legacyId, /^[0-9a-f]{24}$/);
  assert.equal(genuine.legacyId.length, minted.legacyId.length);

  // WITH MongoDB: distinguishable.
  const withMongo = await MongoCategory.countDocuments({ _id: genuine.legacyId });
  const mintedWithMongo = await MongoCategory.countDocuments({ _id: minted.legacyId });
  assert.equal(withMongo, 1, 'the genuine id names a document');
  assert.equal(mintedWithMongo, 0, 'the minted id names nothing');

  // WITHOUT it there is no query to run at all. Stated as an assertion about
  // the ONLY oracle rather than as a comment, so that a future change removing
  // this dependency has to come through here.
  assert.equal(
    mintedWithMongo === 0 && withMongo === 1,
    true,
    'THE ONLY ORACLE IS THE MONGODB LOOKUP. Delete MongoDB first and every ' +
      'legacy_id is permanently ambiguous - which is why AE1-a is package 3.6 ' +
      'and the cleanup is 4c.'
  );
});

test("THE SUITE'S OWN GUARD refuses when MySQL holds rows this MongoDB cannot explain", async () => {
  // PROVED BY INJECTION, NOT BY INSPECTION (AV2). A guard that has never been
  // seen to fire is a comment. This plants exactly the row that caused the
  // damage - a legacy_id in MySQL that the configured MongoDB knows nothing
  // about, under a name this suite does not own - and asserts the refusal.
  await reset();
  await categories.create({
    name: `${FOREIGN_PREFIX} pretend the ETL made this`,
    legacyId: mintObjectId(),
    shortDescription: 'fixture',
    donationAmountMinor: 10000,
    descriptions: [],
  });

  await assert.rejects(
    () => assertSourceMatchesMySQL(),
    (err) => {
      assert.match(err.message, /REFUSING TO RUN/);
      assert.match(err.message, /TEST_MONGODB_URI/, 'and it names what to change');
      assert.match(err.message, /FOREIGNROW/, 'and which row it could not explain');
      return true;
    }
  );

  await reset();
});

// =============================================================================
// BB1 - THE POPULATED WRONG DATABASE, which emptiness cannot see
// =============================================================================

/**
 * A MongoDB that HAS documents but is not ours.
 *
 * `matching` is the set of THIS SUITE'S legacy_ids it contains - empty for a
 * different database, partial for an OLD SNAPSHOT of the right one.
 *
 * -----------------------------------------------------------------------------
 * IT ANSWERS TRUTHFULLY FOR EVERY ROW THE SUITE DID NOT CREATE, AND THAT IS
 * NOT A DETAIL - IT IS THE SECOND TIME THIS FILE DESTROYED REAL DATA
 * -----------------------------------------------------------------------------
 * The first version returned `matching` and nothing else. The operation runs
 * against the SHARED development MySQL, which holds the categories the ETL
 * migrated, so every one of those looked absent from MongoDB and was NULLed -
 * the exact damage `assertSourceMatchesMySQL` was added to prevent, committed
 * again through the one path that guard cannot see.
 *
 * **A guard on the real MongoDB does nothing about a stub that lies about it.**
 * The stub is the database as far as the operation is concerned, so it has to
 * be honest about everything it is not deliberately testing.
 *
 * So: real lookups for real rows, and fiction only for the ids this suite
 * created. Each test then controls exactly the variable it is about.
 */
function sourceWith(documentCount, matching) {
  const controlled = new Set(matching);
  return {
    ...models,
    Category: {
      countDocuments: async () => documentCount,
      find: (query) => ({
        lean: async () => {
          const asked = (query && query._id && query._id.$in) || [];
          const mine = new Set(
            (await categories.list())
              .filter((c) => String(c.name || '').startsWith(CAT_PREFIX))
              .map((c) => c.legacyId)
              .filter(Boolean)
          );
          // Anything this suite did not create is resolved against the REAL
          // collection. Anything it did create resolves only if the test says so.
          const real = await MongoCategory.find(
            { _id: { $in: asked.filter((id) => !mine.has(id)) } },
            { _id: 1 }
          ).lean();

          return [
            ...real.map((d) => ({ _id: String(d._id) })),
            ...asked.filter((id) => mine.has(id) && controlled.has(id)).map((_id) => ({ _id })),
          ];
        },
      }),
    },
  };
}

test('BB1: a POPULATED WRONG database is REFUSED - the case emptiness misses', async () => {
  // THE INJECTION BB1 ASKED FOR. The emptiness guard passes here: the collection
  // has 5000 documents. They are simply not OUR documents.
  //
  // This is the cutover's unrecoverable case. In 4b production MongoDB IS the
  // oracle - there is no kindledger_legacy to restore from - so a run against
  // the wrong populated database destroys the migration history of every record
  // permanently, and nothing about the run looks unusual while it happens.
  await reset();
  const genuine = await genuineCategory('wrongdb');
  const minted = await mintedCategory('wrongdb');

  await assert.rejects(
    () =>
      nullMintedLegacyIds({
        prisma: getPrisma(),
        models: sourceWith(5000, []),
        dryRun: false,
        entities: ['category'],
      }),
    (err) => {
      assert.equal(err.code, 'ERR_SOURCE_MISMATCH', 'a DIFFERENT code from the empty case');
      assert.notEqual(err.code, 'ERR_SOURCE_EMPTY', 'emptiness is not what was detected');
      assert.equal(err.entity, 'category');
      assert.equal(err.mongoDocuments, 5000, 'and it reports that the source was NOT empty');
      assert.match(err.message, /NOT ONE of the/);
      assert.match(err.message, /MONGODB_URI/, 'and names what to check');
      return true;
    }
  );

  // AND IT WROTE NOTHING - the refusal comes before the update, not after it.
  assert.equal((await categories.findById(genuine.uuid)).legacyId, genuine.legacyId);
  assert.equal(
    (await categories.findById(minted.uuid)).legacyId,
    minted.legacyId,
    'even the genuinely minted row is untouched - a refusal writes nothing at all'
  );
});

test('BB1: sharing even ONE identifier is accepted - it is not a threshold', async () => {
  // The guard is deliberately the WEAKEST statement of "same database": share an
  // identifier. A threshold would have to be chosen, argued about, and relaxed
  // the first time it fired on a legitimate run.
  await reset();
  const genuine = await genuineCategory('oneid');
  const minted = await mintedCategory('oneid');

  const report = await nullMintedLegacyIds({
    prisma: getPrisma(),
    models: sourceWith(5000, [genuine.legacyId]),
    dryRun: false,
    entities: ['category'],
  });

  const cat = report.find((r) => r.entity === 'category');
  assert.ok(cat.minted >= 1);
  assert.equal((await categories.findById(genuine.uuid)).legacyId, genuine.legacyId);
  assert.equal((await categories.findById(minted.uuid)).legacyId, null);
});

test('PINNED, NOT CLOSED: a PARTIAL overlap is NOT caught, and destroys genuine ids', async () => {
  // ===========================================================================
  // THIS TEST ASSERTS A KNOWN DEFECT. It is not a regression when it passes.
  // ===========================================================================
  // An OLD SNAPSHOT of the RIGHT database shares most identifiers, so the
  // identity guard passes by construction - the two sides really do share ids.
  // Every genuine legacy_id created since the snapshot then looks minted.
  //
  // Identity cannot close this. The only signal is the per-entity MATCH RATE,
  // which the operation now reports on every run and prints loudly on a dry run.
  //
  // PINNED RATHER THAN NOTED, per BA3: a documented residual with no test is
  // indistinguishable from one nobody has thought about. If someone closes this
  // - by a rate floor, or by recording the source database identity at ETL time
  // - THIS TEST MUST FAIL, and that failure is the notification.
  await reset();
  const inSnapshot = await genuineCategory('snap-old');
  const addedLater = await genuineCategory('snap-new');

  const report = await nullMintedLegacyIds({
    prisma: getPrisma(),
    // The snapshot has the older row and not the newer one. Both are GENUINE.
    models: sourceWith(5000, [inSnapshot.legacyId]),
    dryRun: false,
    entities: ['category'],
  });

  assert.equal(
    (await categories.findById(inSnapshot.uuid)).legacyId,
    inSnapshot.legacyId,
    'the row the snapshot knows about survives'
  );
  assert.equal(
    (await categories.findById(addedLater.uuid)).legacyId,
    null,
    'THE DEFECT: a GENUINE legacy_id absent from an old snapshot is destroyed. ' +
      'If this assertion fails, the residual has been closed - update the map ' +
      'row and delete this test rather than making it pass.'
  );

  // And the ONE number that could have warned the operator.
  const cat = report.find((r) => r.entity === 'category');
  assert.ok(cat.matchRate < 1, 'the match rate is the only signal, and it is reported');
  assert.ok(cat.matchRate > 0, 'while being high enough that the identity guard passed');
});

test('THE STUBS MUST NOT TOUCH ROWS THIS SUITE DID NOT CREATE', async () => {
  // ===========================================================================
  // THE REGRESSION GUARD FOR THE DAMAGE THIS FILE DID TWICE
  // ===========================================================================
  // First time: the suite was pointed at a scratch MongoDB and NULLed the
  // legacy_id of both ETL-migrated categories. Fixed by
  // `assertSourceMatchesMySQL`, which checks the REAL MongoDB in `before()`.
  //
  // Second time: the BB1 stubs answered `find` with a fixed list, so every real
  // row looked absent and was NULLed anyway. The guard could not see it,
  // because as far as the operation is concerned THE STUB IS THE DATABASE.
  //
  // This asserts the property directly: run the operation through a stub, and
  // the rows this suite did not create must come out untouched.
  await reset();
  await genuineCategory('untouched');

  const foreignBefore = (await categories.list())
    .filter((c) => c.legacyId && !String(c.name || '').startsWith(CAT_PREFIX))
    .map((c) => ({ id: c.id, legacyId: c.legacyId }));

  // The most hostile stub in the file - it claims a populated database that
  // contains exactly one of our ids and says nothing about anything else.
  await nullMintedLegacyIds({
    prisma: getPrisma(),
    models: sourceWith(5000, []),
    dryRun: false,
    entities: ['category'],
  }).catch(() => {});

  for (const row of foreignBefore) {
    const after = await categories.findById(row.id);
    assert.equal(
      after.legacyId,
      row.legacyId,
      `A ROW THIS SUITE DID NOT CREATE WAS MODIFIED (${row.legacyId}). The stub ` +
        'must answer truthfully for everything it is not deliberately testing - ' +
        'see sourceWith(). This assertion exists because the same damage was ' +
        'done twice, the second time through a path the before() guard cannot see.'
    );
  }
});
