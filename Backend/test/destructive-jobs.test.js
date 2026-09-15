/**
 * =============================================================================
 * Destructive-job AUTHORISATION, and its independence from migration state (AT1)
 * =============================================================================
 *   docker compose up -d
 *   npm run test:destructive-jobs
 *
 * A SEPARATE FILE FROM `migration-state.test.js` ON PURPOSE. The whole finding
 * is that safety and authorisation are different questions, and putting both
 * suites in one file would quietly assert the opposite.
 *
 * THE CENTRAL ASSERTION is the one AT1 asks for: moving an entity to `mysql`
 * must NOT, by itself, make its purge runnable. Package AS7 did exactly that -
 * migrating `routes/admin.js` moved `user` to `mysql`, and the inactive-account
 * purge became live as a SIDE EFFECT of a route migration that nobody read as a
 * decision about deleting accounts. Package 3.4 would have repeated it for
 * donations, authorising two destructive jobs on one transition.
 * =============================================================================
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'production';

const destructiveJobs = require('../config/destructiveJobs');
const migrationState = require('../config/migrationState');
const scheduler = require('../services/scheduler');
const donations = require('../repositories/donations');
const categories = require('../repositories/categories');
const prismaModule = require('../config/prisma');

const TAG = 'zzz-destjobs';
const CAT_PREFIX = 'ZZZ DESTJOBS';
let categoryId;

const mintObjectId = () =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
  crypto.randomBytes(8).toString('hex');

/** Every authorisation variable, cleared, so no test inherits another's state. */
function clearAllAuthorisation() {
  for (const job of destructiveJobs.jobNames()) {
    delete process.env[destructiveJobs.definitionOf(job).env];
  }
}

/**
 * Run `fn` with an entity's declared store temporarily changed.
 *
 * MUTATING THE DECLARATION IS THE ONLY WAY TO TEST THE THING AT1 ASKS ABOUT -
 * the question is what happens ON THE TRANSITION, and waiting for package 3.4
 * to find out is exactly the sequence that produced the finding. Restored in a
 * `finally` so a failing assertion cannot leak a false `mysql` into the rest of
 * the run, which would make every later safety check vacuous.
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

async function makeAncientDonation(tag) {
  const eleven = new Date();
  eleven.setFullYear(eleven.getFullYear() - 11);
  return donations.create({
    legacyId: mintObjectId(),
    donorName: 'ZZZ DestJobs ' + tag,
    donorEmail: `${TAG}-${tag}@invalid.test`,
    categoryId,
    quantity: 1,
    baseAmountMinor: 150000,
    extraAmountMinor: 0,
    amountMinor: 150000,
    donatedAt: eleven,
  });
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

beforeEach(() => clearAllAuthorisation());

after(async () => {
  clearAllAuthorisation();
  try {
    await donations.deleteByDonorEmailPrefix(TAG);
    await categories.deleteByNamePrefix(CAT_PREFIX);
  } finally {
    await prismaModule.disconnect();
  }
});

// =============================================================================
// The default
// =============================================================================

test('every destructive job defaults to OFF, and no code path turns one on', () => {
  for (const job of destructiveJobs.jobNames()) {
    assert.equal(destructiveJobs.isAuthorised(job), false, `${job} must default off`);
  }
  assert.deepEqual(destructiveJobs.authorisedJobs(), []);
});

test('only the WORD "true" authorises - not "1", "yes" or "on"', () => {
  // The contract, stated precisely because the first version of this test got
  // it wrong: the risk being defended against is ACCIDENTAL authorisation, and
  // `1`/`yes`/`on` are values that end up in an environment by habit or by a
  // deployment tool's boolean coercion. Case and surrounding whitespace on the
  // actual word are unambiguous intent and are accepted - refusing ` true ` or
  // `True` would silently ignore an operator who plainly meant it, which for a
  // gate is a worse failure than being one keyword wide.
  const env = destructiveJobs.definitionOf('retention-purge').env;

  for (const value of ['1', 'yes', 'on', 'y', 'enabled', '', 'false', 'truthy']) {
    process.env[env] = value;
    assert.equal(
      destructiveJobs.isAuthorised('retention-purge'),
      false,
      `'${value}' must NOT authorise a job that deletes donation records`
    );
  }

  for (const value of ['true', 'True', 'TRUE', ' true ']) {
    process.env[env] = value;
    assert.equal(destructiveJobs.isAuthorised('retention-purge'), true, `'${value}' authorises`);
  }

  // An unset variable is not authorisation either - the case that actually
  // happens, since the default is to not mention the job at all.
  delete process.env[env];
  assert.equal(destructiveJobs.isAuthorised('retention-purge'), false);
});

test('an undeclared job throws rather than being treated as unauthorised', () => {
  // Silently refusing an unknown job would be safe and would hide a typo in a
  // call site forever - the job simply never runs and nobody learns why.
  assert.throws(
    () => destructiveJobs.assertAuthorised('retentionpurge'),
    /Unknown destructive job/
  );
});

test('every job states what leaving it OFF costs', () => {
  // Without this, "off" reads as the cautious choice everywhere, and one of
  // these jobs being off is a retention obligation going unmet rather than a
  // risk avoided.
  for (const job of destructiveJobs.jobNames()) {
    const def = destructiveJobs.definitionOf(job);
    assert.ok(
      def.costOfLeavingItOff && def.costOfLeavingItOff.length > 40,
      `${job} does not say what leaving it off costs`
    );
    assert.ok(def.deletes && def.deletes.length > 10, `${job} does not say what it deletes`);
  }
});

// =============================================================================
// THE CENTRAL ASSERTION (AT1)
// =============================================================================

test('AT1: moving an entity to `mysql` does NOT make its purge runnable', async () => {
  // THE FINDING, STATED AS A TEST. AS7 moved `user` to mysql and the
  // inactive-account purge went live with it. This asserts that the same
  // transition for `donation` - which package 3.4 performs - cannot do that.
  await makeAncientDonation('transition');

  // Precondition: donation is split, so today it refuses on SAFETY.
  assert.equal(migrationState.storeFor('donation'), migrationState.SPLIT);

  await withStore('donation', migrationState.MYSQL, async () => {
    // The safety gate now passes, exactly as it will after package 3.4.
    assert.doesNotThrow(() => migrationState.assertDeletable('donation', 'probe'));

    // AND THE JOB STILL DOES NOT RUN.
    await assert.rejects(
      () => scheduler.purgeOldDonations({ dryRun: false }),
      (err) => {
        assert.equal(
          err.code,
          'ERR_JOB_NOT_AUTHORISED',
          'the refusal must be about AUTHORISATION, not safety - if this is ' +
            'ERR_NOT_AUTHORITATIVE the two gates have been collapsed again'
        );
        assert.equal(err.job, 'retention-purge');
        return true;
      }
    );
  });

  // And the fixture survived the whole thing.
  assert.ok(
    (await donations.countOlderThan(scheduler.tenYearsAgo(), scheduler.PLAUSIBLE_FLOOR)) > 0
  );
});

test('AT1: the same holds for users, which is where the finding came from', async () => {
  // `user` is ALREADY mysql - AS7 moved it. So this needs no simulation: the
  // safety gate passes right now, and the job must still refuse.
  assert.equal(migrationState.isMysqlAuthoritative('user'), true);
  assert.doesNotThrow(() => migrationState.assertDeletable('user', 'probe'));

  const dry = await scheduler.purgeInactiveUsers({ dryRun: true });
  if (dry.candidates > 0) {
    await assert.rejects(
      () => scheduler.purgeInactiveUsers({ dryRun: false }),
      (err) => err.code === 'ERR_JOB_NOT_AUTHORISED' && err.job === 'inactive-account-purge'
    );
  } else {
    // No candidates means the job short-circuits before either gate, so assert
    // the gate directly rather than claiming a pass the run did not produce.
    assert.throws(
      () => destructiveJobs.assertRunnable('inactive-account-purge', 'probe'),
      (err) => err.code === 'ERR_JOB_NOT_AUTHORISED'
    );
  }
});

// =============================================================================
// Neither gate is sufficient alone
// =============================================================================

test('authorisation alone is NOT enough - safety is still checked', async () => {
  await makeAncientDonation('authonly');
  process.env[destructiveJobs.definitionOf('retention-purge').env] = 'true';

  // donation is `split`, so this must refuse on SAFETY even though authorised.
  await assert.rejects(
    () => scheduler.purgeOldDonations({ dryRun: false }),
    (err) => {
      assert.equal(err.code, 'ERR_NOT_AUTHORITATIVE');
      assert.equal(err.entity, 'donation');
      return true;
    }
  );
});

test('AUTHORISATION IS CHECKED FIRST when both gates would refuse', () => {
  // If nobody asked for the deletion, whether it would have been safe is moot -
  // and reporting the safety problem first sends an operator to investigate a
  // migration they have no reason to care about yet.
  assert.equal(migrationState.storeFor('donation'), migrationState.SPLIT);
  assert.throws(
    () => destructiveJobs.assertRunnable('retention-purge', 'probe'),
    (err) => err.code === 'ERR_JOB_NOT_AUTHORISED'
  );
});

test('BOTH gates open: the purge actually runs', async () => {
  // The control for every refusal above. Without it they prove only that the
  // job never runs, which a permanently broken job would also satisfy.
  const row = await makeAncientDonation('both');
  process.env[destructiveJobs.definitionOf('retention-purge').env] = 'true';

  await withStore('donation', migrationState.MYSQL, async () => {
    const result = await scheduler.purgeOldDonations({ dryRun: false });
    assert.ok(result.deleted > 0, 'it deleted something');
    assert.equal(result.dryRun, false);
  });

  assert.equal(await donations.findByLegacyId(row.legacyId), null, 'the ancient row is gone');
});

// =============================================================================
// Per-job, not global
// =============================================================================

test('authorising one job does not authorise another', () => {
  // A single "destructive jobs enabled" switch would re-create the finding one
  // level up: enabling the pending-signup sweep would authorise the donation
  // retention purge in the same keystroke.
  process.env[destructiveJobs.definitionOf('pending-signup-sweep').env] = 'true';

  assert.equal(destructiveJobs.isAuthorised('pending-signup-sweep'), true);
  assert.equal(destructiveJobs.isAuthorised('retention-purge'), false);
  assert.equal(destructiveJobs.isAuthorised('inactive-account-purge'), false);
  assert.deepEqual(destructiveJobs.authorisedJobs(), ['pending-signup-sweep']);
});

test('the pending-signup sweep is SAFE but still needs authorising', async () => {
  // It is the one job whose entity has never been split, so nothing about
  // migration state has ever stood in its way. It still refuses.
  assert.equal(migrationState.isMysqlAuthoritative('pendingSignup'), true);
  await assert.rejects(
    () => scheduler.sweepExpiredSignups({ dryRun: false }),
    (err) => err.code === 'ERR_JOB_NOT_AUTHORISED' && err.job === 'pending-signup-sweep'
  );

  process.env[destructiveJobs.definitionOf('pending-signup-sweep').env] = 'true';
  const result = await scheduler.sweepExpiredSignups({ dryRun: false });
  assert.equal(result.dryRun, false, 'authorised, and it ran');
});

// =============================================================================
// Dry runs
// =============================================================================

test('a DRY RUN needs no authorisation, in any migration state', async () => {
  // Counting is not destructive, and the preview is how an operator decides
  // whether to authorise at all. Requiring authorisation to see what a job
  // WOULD do would make the decision unmakeable.
  const d = await scheduler.purgeOldDonations({ dryRun: true });
  assert.equal(d.deleted, 0);
  assert.equal(d.authoritativeStore, 'split');

  const u = await scheduler.purgeInactiveUsers({ dryRun: true });
  assert.equal(u.deleted, 0);

  const p = await scheduler.sweepExpiredSignups({ dryRun: true });
  assert.equal(p.deleted, 0);
});
