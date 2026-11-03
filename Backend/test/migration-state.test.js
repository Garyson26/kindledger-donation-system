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
const destructiveJobs = require('../config/destructiveJobs');
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

/**
 * AT1: this suite's subject is the SAFETY gate, so it authorises the jobs and
 * then asserts that safety still refuses. Authorisation has its own suite -
 * test/destructive-jobs.test.js - and keeping them apart is the point: if one
 * file could assert both, the two questions would be one question again.
 */
function authoriseAll() {
  for (const job of destructiveJobs.jobNames()) {
    process.env[destructiveJobs.definitionOf(job).env] = 'true';
  }
}

/**
 * Temporarily declare an entity not-migrated.
 *
 * NEEDED FROM PACKAGE 3.4 ONWARDS, and that is worth stating. The migration is
 * complete, so the SAFETY gate refuses nothing in normal operation and there is
 * no naturally-unsafe entity left to test it against. The condition has to be
 * constructed - which means the gate is from here on EXERCISED ONLY BY THESE
 * TESTS.
 *
 * That is AU3's "control validated only where nothing is at stake", seen coming
 * rather than in hindsight: a gate the system never triggers is one refactor
 * away from being deleted as dead code, and this suite is the only thing that
 * would notice.
 */
async function withStore(entity, store, fn) {
  const original = migrationState.ENTITIES[entity].store;
  migrationState.ENTITIES[entity].store = store;
  try {
    return await fn();
  } finally {
    migrationState.ENTITIES[entity].store = original;
  }
}

function deauthoriseAll() {
  for (const job of destructiveJobs.jobNames()) {
    delete process.env[destructiveJobs.definitionOf(job).env];
  }
}

before(async () => {
  authoriseAll();
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
  deauthoriseAll();
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

test('CONTROL: the self-check FAILS when the allowlist does not cover an importer', () => {
  // Without this, the test above passes whether or not it can detect anything.
  //
  // CHANGED TWICE NOW, AND THE SECOND TIME IS THE INTERESTING ONE. The control
  // first used `user`/`routes/admin.js`; AS7 migrated that file and the example
  // stopped existing. It then used `donation`/`routes/payment.js`; package 3.4
  // migrated THAT file, and the example stopped existing again.
  //
  // A CONTROL THAT NAMES A SPECIFIC VIOLATION HAS A LIFETIME, and this one
  // expired twice in two packages. Rewritten to depend on no violation at all:
  // it takes an entity that IS correctly declared, removes one entry from its
  // allowlist, and asserts the files that entry was covering are then reported.
  // Nothing about the migration's progress can retire that.
  const entity = 'donation';
  const state = migrationState.stateFor(entity);
  assert.equal(state.store, migrationState.MYSQL, 'precondition');

  const importers = importersOf(state.model);
  assert.ok(importers.length > 0, `CONTROL FAILED: nothing imports models/${state.model}, so the scan finds nothing`);

  // Every importer is allowlisted today - that is what the test above asserts.
  for (const f of importers) {
    assert.ok(
      state.mongooseAllowed.some((prefix) => f.startsWith(prefix)),
      `precondition: ${f} should already be allowlisted`
    );
  }

  // Remove ONE allowlist entry and the files it covered must be reported.
  for (const dropped of state.mongooseAllowed) {
    const narrowed = state.mongooseAllowed.filter((p) => p !== dropped);
    const covered = importers.filter((f) => f.startsWith(dropped));
    if (covered.length === 0) continue;

    const violations = importers.filter((f) => !narrowed.some((prefix) => f.startsWith(prefix)));
    assert.deepEqual(
      violations.sort(),
      covered.sort(),
      `CONTROL FAILED: dropping '${dropped}' from the allowlist did not surface ` +
        'the files it covers, so the self-check above proves nothing'
    );
  }
});

test('`split` is not `mysql`: an entity with a live MongoDB writer is not migrated', () => {
  // A binary migrated/not-migrated cannot express the condition that causes
  // harm. CHANGED IN AS7: `user` left this list when routes/admin.js migrated
  // and ADMIN-01 closed. `donation` remains, because routes/payment.js is still
  // the only live creator of donations and it still writes MongoDB.
  // CHANGED IN 3.4: `donation` was the last one, and the migration is complete.
  // The list is now empty, which is the state this whole sequence was aiming at
  // - and it means the SAFETY gate refuses nothing in normal operation from
  // here on. That is why AT1's separate authorisation gate matters more after
  // this package than before it, not less.
  for (const e of migrationState.entityNames()) {
    assert.equal(migrationState.isMysqlAuthoritative(e), true, `${e} should be mysql`);
  }
  assert.deepEqual(migrationState.pendingMigration(), []);

  // Every entity states its reason with a file reference, migrated or not - a
  // bare verdict would be the next inherited claim.
  for (const e of migrationState.entityNames()) {
    const reason = migrationState.stateFor(e).reason;
    assert.ok(
      /\.js/.test(reason) || /by construction/.test(reason),
      `${e}'s reason names no file. State the writer, or the next reader has ` +
        'to rediscover it.'
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

test('AS2: the retention purge REFUSES while an entity is mid-migration (CONSTRUCTED IN 3.4)', async () => {
  // The scenario the finding is about: an operator sets SCHEDULER_ENABLED=true
  // before the donation write path has migrated. Before AS2 the only thing
  // standing in the way was that the variable defaults to false.
  const row = await makeAncientDonation('ancient');

  const before = await donations.countOlderThan(
    scheduler.tenYearsAgo(),
    scheduler.PLAUSIBLE_FLOOR
  );
  assert.ok(before > 0, 'precondition: there is something the purge would delete');

  // CHANGED IN 3.4. `donation` reached `mysql` in this package, so "mid-migration"
  // no longer describes the system and the state is constructed. The gate's
  // BEHAVIOUR is unchanged; only the availability of a natural subject is.
  await withStore('donation', migrationState.SPLIT, async () => {
    await assert.rejects(
      () => scheduler.purgeOldDonations({ dryRun: false }),
      (err) => {
        assert.equal(err.code, 'ERR_NOT_AUTHORITATIVE', 'refusal must be typed');
        assert.equal(err.entity, 'donation');
        assert.equal(err.state, 'split');
        assert.match(err.message, /REFUSED/);
        return true;
      }
    );
  });

  // THE ASSERTION THAT MATTERS: nothing was deleted.
  assert.equal(
    await donations.countOlderThan(scheduler.tenYearsAgo(), scheduler.PLAUSIBLE_FLOOR),
    before,
    'the purge refused but still deleted rows'
  );
  assert.ok(await donations.findByLegacyId(row.legacyId), 'the fixture survived');
});

test('AS2: a DRY RUN is still allowed, and reports the store (CHANGED IN 3.4)', async () => {
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
    'mysql',
    'CHANGED IN 3.4: the migration is complete, so a dry run now reports a ' +
      'store that would NOT refuse. The value is still reported rather than ' +
      'dropped, because the day it says anything else an operator needs to see it'
  );
});

test('AS7 made the account purge SAFE; AT1 keeps it UNAUTHORISED (CHANGED IN 3.4)', async () => {
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

  // SAFETY no longer refuses it - that is what AS7 changed, and it is what
  // prompted AT1.
  assert.doesNotThrow(() => migrationState.assertDeletable('user', 'the inactive-account purge'));

  // CHANGED IN 3.4: `donation` used to be the counter-example here, and it
  // reached `mysql` in this package. THE POINT SURVIVES IN A BETTER FORM - the
  // purge is safe and STILL DOES NOT RUN, because nothing authorised it. Before
  // AT1 this transition alone would have made it live.
  // This suite authorises every job in `before()` so that it can test the
  // SAFETY gate in isolation, so the authorisation gate has to be un-set here
  // to observe it - which is itself the separation working: one suite cannot
  // accidentally assert both.
  const destructiveJobs = require('../config/destructiveJobs');
  const env = destructiveJobs.definitionOf('inactive-account-purge').env;
  const previous = process.env[env];
  delete process.env[env];
  try {
    assert.equal(destructiveJobs.isAuthorised('inactive-account-purge'), false);
    assert.throws(
      () => destructiveJobs.assertRunnable('inactive-account-purge', 'probe'),
      (err) => err.code === 'ERR_JOB_NOT_AUTHORISED'
    );
  } finally {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  }
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
    // CHANGED IN 3.4: constructed, because there is no unsafe entity left.
    await withStore('donation', migrationState.SPLIT, async () => {
      await assert.rejects(
        () => scheduler.purgeOldDonations({ dryRun: false }),
        (err) => err.code === 'ERR_NOT_AUTHORITATIVE'
      );
    });
  } finally {
    if (previous === undefined) delete process.env.SCHEDULER_ENABLED;
    else process.env.SCHEDULER_ENABLED = previous;
  }
});

// =============================================================================
// PAY-02: which Mongoose models does the APP actually register at boot?
// =============================================================================

test('the set of Mongoose models registered at boot is DECLARED, not incidental', async () => {
  // THE GATE THAT WOULD HAVE CAUGHT PAY-02.
  //
  // Package AS7 removed `const User = require("../models/User")` from
  // routes/admin.js as a dead import - the binding genuinely was unused, and
  // AT4's own check is what flagged it. But `require()` DOES WORK: it registers
  // the schema with Mongoose's global model registry, and that registration was
  // the only one in the process. Removing it broke
  // `GET /api/payment/status/:txnid`, which calls `.populate('userId', ...)`
  // and now threw `Schema hasn't been registered for model "User"` on every
  // request - a 500 on the donor-facing receipt lookup.
  //
  // AN UNUSED BINDING IS NOT AN UNUSED IMPORT. No reference-level analysis can
  // see a side effect on a global registry; only asking the booted process can.
  //
  // Asserted as an EXACT SET rather than a minimum, so both directions are
  // caught: a model silently dropped (PAY-02) and a model silently reintroduced
  // (a route quietly reaching back to Mongoose).
  //
  // Run in a CHILD PROCESS with a deliberately unreachable MONGODB_URI, because
  // registration happens at require() time and does not need a connection -
  // which keeps this suite free of a database dependency it otherwise lacks.
  const { execFileSync } = require('node:child_process');
  const script = `
    const mongoose = require('mongoose');
    require(${JSON.stringify(path.join(BACKEND, 'app.js'))});
    process.stdout.write(JSON.stringify(mongoose.modelNames().sort()));
    process.exit(0);
  `;

  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VERCEL: '1',
      MONGODB_URI: 'mongodb://127.0.0.1:1/unreachable-on-purpose',
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-chars-long',
      ADMIN_CREATION_KEY: 'test-admin-key',
      SCHEDULER_ENABLED: 'false',
    },
  });

  const registered = JSON.parse(out.trim().slice(out.trim().lastIndexOf('[')));

  // WHAT EACH ONE IS DOING THERE. A model on this list with no reason is a
  // coupling nobody chose.
  //
  // CHANGED IN 3.4, AND THIS IS THE MILESTONE. `Donation` was the last entry -
  // registered by routes/payment.js, the final live Mongoose writer. THE
  // APPLICATION NOW LOADS NO MONGOOSE MODEL AT ALL.
  //
  // Mongoose itself is still connected (config/db.js) and the models still
  // exist on disk for the ETL and the seeders; removing those is package 3.6.
  // What this asserts is narrower and more useful: no REQUEST PATH can reach a
  // Mongoose model, because none is loaded.
  //
  // An empty expectation is a strong one. Anything appearing here is a route
  // reaching back to the old store, and the message below says so.
  //
  // ============================================================================
  // DELETE THIS TEST IN PACKAGE 3.6, IN THE SAME COMMIT THAT REMOVES MONGOOSE.
  // ============================================================================
  // It guards a coupling that cannot exist once Mongoose is gone. A gate
  // protecting nothing passes forever, nobody can tell whether it still works,
  // and it makes this suite look better covered than it is - AU3's shape one
  // package out. Recorded here AND in docs/remediation-map.md under AV2,
  // because a note in only one of the two is how a gate outlives its subject.
  const expected = {};

  assert.deepEqual(
    registered,
    Object.keys(expected).sort(),
    'The models registered at boot changed.\n' +
      `  registered: ${registered.join(', ') || '(none)'}\n` +
      `  expected:   ${Object.keys(expected).sort().join(', ') || '(none)'}\n\n` +
      'If one DISAPPEARED, something that looked like a dead import was ' +
      'registering it - that is PAY-02, and something using .populate() is now ' +
      'throwing. If one APPEARED, a file reached back to Mongoose. Update this ' +
      'list WITH THE REASON, or undo the change.'
  );
});
