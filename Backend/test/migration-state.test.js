/**
 * =============================================================================
 * The migration-state declaration, and the destructive-job gate (AS2)
 * =============================================================================
 *   docker compose up -d
 *   npm run test:migration-state
 *
 * TWO JOBS, AND THE FIRST IS THE MORE IMPORTANT ONE.
 *
 * 1. THE DECLARATION IS CHECKED AGAINST THE CODE. `config/migrationState.js`
 *    is a sentence about the system, and a sentence about the system is
 *    precisely what produced eight inherited claims - one of which described a
 *    narrowing nobody had implemented. So this suite walks the source tree and
 *    asserts the declaration is TRUE, rather than reading it.
 *
 * 2. THE GATE ACTUALLY REFUSES. Enabling the scheduler mid-migration must
 *    refuse rather than purge, and the refusal must be distinguishable from a
 *    failure - "nothing was touched" and "it crashed partway through deleting"
 *    are opposite facts about the data.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'production';

const migrationState = require('../config/migrationState');
const scheduler = require('../services/scheduler');
const donations = require('../repositories/donations');
const categories = require('../repositories/categories');
const prismaModule = require('../config/prisma');

const TAG = 'zzz-migstate';
const CAT_PREFIX = 'ZZZ MIGSTATE';
const BACKEND = path.join(__dirname, '..');

let categoryId;

const mintObjectId = () =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
  crypto.randomBytes(8).toString('hex');

// -----------------------------------------------------------------------------
// Source-tree walk
// -----------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', 'prisma', 'uploads', 'coverage']);

function sourceFiles(dir = BACKEND, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Repo-relative, forward-slashed, so the allowlists read the same on any OS. */
const rel = (abs) => path.relative(BACKEND, abs).split(path.sep).join('/');

/**
 * Files importing a Mongoose model, by model name.
 *
 * Matches `require('../models/User')` in any quoting or nesting, which is how
 * every import in this codebase is written - including the lazy ones inside the
 * bridges, which a static import scan would miss and which are exactly the
 * call sites that matter.
 */
function importersOf(modelName) {
  const pattern = new RegExp(`require\\(\\s*['"\`][^'"\`]*models/${modelName}['"\`]\\s*\\)`);
  return sourceFiles()
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const probe = await require('../repositories').checkDatabase();
  assert.equal(probe.ok, true, `MySQL unreachable: ${probe.error}`);

  await donations.deleteByDonorEmailPrefix(TAG);
  await categories.deleteByNamePrefix(CAT_PREFIX);
  const cat = await categories.create({
    name: `${CAT_PREFIX} fixture`,
    legacyId: mintObjectId(),
    shortDescription: 'fixture',
    donationAmountMinor: 150000,
    descriptions: [],
  });
  categoryId = cat.legacyId;
});

after(async () => {
  try {
    await donations.deleteByDonorEmailPrefix(TAG);
    await categories.deleteByNamePrefix(CAT_PREFIX);
  } finally {
    await prismaModule.disconnect();
  }
});

// =============================================================================
// 1. The declaration is TRUE, not merely written down
// =============================================================================

test('every entity that exists is declared - an undeclared entity is an unchecked one', () => {
  const models = fs
    .readdirSync(path.join(BACKEND, 'models'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''));

  const declared = new Set(
    migrationState
      .entityNames()
      .map((e) => migrationState.stateFor(e).model)
      .filter(Boolean)
  );

  for (const m of models) {
    assert.ok(
      declared.has(m),
      `models/${m}.js exists but no entity in config/migrationState.js declares it. ` +
        'An entity nobody declared is an entity nobody checked - which is how ' +
        'ADMIN-01 survived three packages.'
    );
  }
});

test('THE SELF-CHECK: no file outside the allowlist imports a migrated model', () => {
  // THIS IS THE TEST THAT STOPS THE DECLARATION BECOMING AN INHERITED CLAIM.
  //
  // For every entity declared `mysql`, the only files permitted to touch its
  // Mongoose model are the ones the declaration names: the ETL, which reads the
  // old store by definition, and the bridges, which read it as a fallback for
  // rows not yet migrated.
  //
  // The asymmetry is deliberate and is the right way round. Migrating a file
  // and forgetting to update the declaration leaves it UNDERSTATED, which is
  // safe. Updating the declaration without migrating the file leaves it
  // OVERSTATED - a purge would then be permitted against an entity MongoDB
  // still writes - and THAT is the direction this test catches.
  const violations = [];

  for (const entity of migrationState.entityNames()) {
    const state = migrationState.stateFor(entity);
    if (state.store !== migrationState.MYSQL || !state.model) continue;

    for (const file of importersOf(state.model)) {
      const allowed = state.mongooseAllowed.some((prefix) => file.startsWith(prefix));
      if (!allowed) violations.push(`${entity} (${state.model}): ${file}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    'config/migrationState.js declares these entities MySQL-authoritative, but ' +
      'these files still import their Mongoose model and are not on the ' +
      "entity's mongooseAllowed list:\n  " +
      violations.join('\n  ') +
      '\n\nEither the file has not actually migrated - in which case the ' +
      'declaration is wrong and a purge could destroy data - or it is a ' +
      'legitimate reader of the old store, in which case add it to ' +
      'mongooseAllowed WITH A REASON.'
  );
});

test('CONTROL: the self-check FAILS when the declaration overstates reality', () => {
  // Without this, the test above passes whether or not it can detect anything.
  //
  // CHANGED IN AS7. The control used to use `user`/`routes/admin.js`, and AS7
  // migrated that file - so the example it relied on stopped existing. THE
  // CONTROL HAD TO MOVE WITH THE MIGRATION, which is worth noting: a control
  // that names a specific violation expires when that violation is fixed, and a
  // control nobody notices has expired is worse than none.
  //
  // `donation` is the remaining `split` - routes/payment.js still writes
  // MongoDB. Declaring it `mysql` is the dangerous edit now.
  const state = migrationState.stateFor('donation');
  assert.equal(state.store, migrationState.SPLIT, 'precondition: donation is split');

  const importers = importersOf(state.model);
  assert.ok(
    importers.includes('routes/payment.js'),
    'CONTROL FAILED: routes/payment.js does not import models/Donation, so the ' +
      'scan is not finding what it claims to find'
  );

  // The check the previous test would run, with `donation` pretended to be
  // mysql and payment.js NOT allowlisted.
  const without = state.mongooseAllowed.filter((p) => p !== 'routes/payment.js');
  const wouldViolate = importers.filter((f) => !without.some((prefix) => f.startsWith(prefix)));

  assert.ok(
    wouldViolate.includes('routes/payment.js'),
    'CONTROL FAILED: declaring `donation` mysql would NOT be caught, so the ' +
      'self-check above proves nothing'
  );
});

test('`split` is not `mysql`: an entity with a live MongoDB writer is not migrated', () => {
  // A binary migrated/not-migrated cannot express the condition that causes
  // harm. CHANGED IN AS7: `user` left this list when routes/admin.js migrated
  // and ADMIN-01 closed. `donation` remains, because routes/payment.js is still
  // the only live creator of donations and it still writes MongoDB.
  assert.equal(migrationState.isMysqlAuthoritative('donation'), false);
  assert.equal(migrationState.isMysqlAuthoritative('user'), true, 'CHANGED IN AS7');
  assert.equal(migrationState.isMysqlAuthoritative('pendingSignup'), true);
  assert.equal(migrationState.isMysqlAuthoritative('category'), true);

  // And the reason is recorded, not just the verdict - a bare 'split' would be
  // the next inherited claim.
  for (const e of migrationState.pendingMigration()) {
    assert.match(
      migrationState.stateFor(e).reason,
      /\.js/,
      `${e} is declared not-migrated but its reason names no file. State the ` +
        'writer, or the next reader has to rediscover it.'
    );
  }
});

test('an undeclared entity throws rather than defaulting to something', () => {
  assert.throws(
    () => migrationState.storeFor('invoice'),
    /Unknown entity 'invoice'/,
    'an unknown entity must refuse, never assume - a default here is a silent ' +
      'permission to delete'
  );
});

// =============================================================================
// 2. The gate refuses, and a refusal is not a failure
// =============================================================================

async function makeAncientDonation(tag) {
  const eleven = new Date();
  eleven.setFullYear(eleven.getFullYear() - 11);
  return donations.create({
    legacyId: mintObjectId(),
    donorName: 'ZZZ MigState ' + tag,
    donorEmail: `${TAG}-${tag}@invalid.test`,
    categoryId,
    quantity: 1,
    baseAmountMinor: 150000,
    extraAmountMinor: 0,
    amountMinor: 150000,
    donatedAt: eleven,
  });
}

test('AS2: the retention purge REFUSES mid-migration, and the rows survive', async () => {
  // The scenario the finding is about: an operator sets SCHEDULER_ENABLED=true
  // before the donation write path has migrated. Before AS2 the only thing
  // standing in the way was that the variable defaults to false.
  const row = await makeAncientDonation('ancient');

  const before = await donations.countOlderThan(
    scheduler.tenYearsAgo(),
    scheduler.PLAUSIBLE_FLOOR
  );
  assert.ok(before > 0, 'precondition: there is something the purge would delete');

  await assert.rejects(
    () => scheduler.purgeOldDonations({ dryRun: false }),
    (err) => {
      assert.equal(err.code, 'ERR_NOT_AUTHORITATIVE', 'refusal must be typed');
      assert.equal(err.entity, 'donation');
      assert.equal(err.state, 'split');
      assert.match(err.message, /REFUSED/);
      // The message must name the file, not just the state - an operator
      // reading it at 02:00 needs to know what to migrate.
      assert.match(err.message, /payment\.js/, 'the refusal names the live writer');
      return true;
    }
  );

  // THE ASSERTION THAT MATTERS: nothing was deleted.
  assert.equal(
    await donations.countOlderThan(scheduler.tenYearsAgo(), scheduler.PLAUSIBLE_FLOOR),
    before,
    'the purge refused but still deleted rows'
  );
  assert.ok(await donations.findByLegacyId(row.legacyId), 'the fixture survived');
});

test('AS2: a DRY RUN is still allowed in the same state', async () => {
  // Refusing the preview would remove information for no safety gain: counting
  // is not destructive, and the dry run is how an operator learns what the
  // purge would do once the entity has migrated.
  await makeAncientDonation('dry');

  const result = await scheduler.purgeOldDonations({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.deleted, 0);
  assert.ok(result.candidates > 0, 'it still counts');
  assert.equal(
    result.authoritativeStore,
    'split',
    'and it reports WHY a real run would refuse, rather than leaving the ' +
      'operator to discover it by trying'
  );
});

test('AS7 MADE THE INACTIVE-ACCOUNT PURGE LIVE (CHANGED IN AS7)', async () => {
  // WAS: refused, because `user` was `split` - routes/admin.js still wrote
  // MongoDB (ADMIN-01), so purging from MySQL would have deleted migrated
  // history while live accounts accumulated in the other store.
  //
  // STATE THIS LOUDLY RATHER THAN LETTING IT PASS AS A GREEN TEST. Closing
  // ADMIN-01 did not only fix the admin console: it PERMITTED A DESTRUCTIVE JOB
  // THAT WAS PREVIOUSLY REFUSED. An operator who sets SCHEDULER_ENABLED=true
  // after this package will delete accounts that the same setting would have
  // spared before it. That is correct - MySQL is now authoritative - and it is
  // a change in blast radius that nobody asked for as a feature, which is
  // exactly the kind of consequence a migration hides.
  //
  // The purge remains bounded by its own guards: admins are never deleted, and
  // an account with ANY donation is never deleted (repositories/users
  // .countInactiveOlderThan).
  assert.equal(migrationState.isMysqlAuthoritative('user'), true);

  const result = await scheduler.purgeInactiveUsers({ dryRun: true });
  assert.equal(result.authoritativeStore, 'mysql');
  assert.equal(result.deleted, 0, 'a dry run still deletes nothing');

  // It no longer refuses. Asserted through the gate directly rather than by
  // running a real purge, because this suite has no business deleting accounts
  // it did not create.
  assert.doesNotThrow(() => migrationState.assertDeletable('user', 'the inactive-account purge'));

  // And `donation` still refuses, so the gate is still doing its job per-entity
  // rather than having been switched off wholesale.
  assert.throws(
    () => migrationState.assertDeletable('donation', 'the retention purge'),
    (err) => err.code === 'ERR_NOT_AUTHORITATIVE'
  );
});

test('AS2: the pending-signup sweep is ALLOWED - the gate is per-entity', async () => {
  // This is why the gate is not a blanket "is the migration finished". That
  // question would block a job which is completely safe today, and a control
  // that blocks safe work gets turned off.
  assert.equal(migrationState.isMysqlAuthoritative('pendingSignup'), true);
  const result = await scheduler.sweepExpiredSignups({ dryRun: false });
  assert.equal(result.dryRun, false, 'it ran rather than refusing');
  assert.equal(typeof result.deleted, 'number');
});

test('SCHEDULER_ENABLED cannot turn the gate off', async () => {
  // The whole point of AS2: the environment variable decides REGISTRATION, an
  // operational choice. The declaration decides DELETION, a correctness one.
  const previous = process.env.SCHEDULER_ENABLED;
  process.env.SCHEDULER_ENABLED = 'true';
  try {
    assert.equal(scheduler.enabled(), true, 'precondition: the scheduler is enabled');
    await makeAncientDonation('enabled');
    await assert.rejects(
      () => scheduler.purgeOldDonations({ dryRun: false }),
      (err) => err.code === 'ERR_NOT_AUTHORITATIVE'
    );
  } finally {
    if (previous === undefined) delete process.env.SCHEDULER_ENABLED;
    else process.env.SCHEDULER_ENABLED = previous;
  }
});
