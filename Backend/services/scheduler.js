/**
 * =============================================================================
 * Scheduled jobs (SPEC-2 section 7.2)
 * =============================================================================
 * Two jobs covering THREE retention rules, all against MySQL:
 *
 *   1. The donation retention purge - BUG-04. Declared as a Vercel cron in
 *      Phase 1a against POST /api/admin/cleanup/trigger, which sits behind
 *      adminAuth, so the cron received a 401 and the purge has never once run.
 *   2. The inactive-account purge, in the same nightly job. Added in package
 *      3.3 when `dataCleanupService` was retired: that service implemented
 *      three rules and this file had replaced two, so retiring it without this
 *      would have dropped a retention control without anyone deciding to.
 *   3. The pending-signup expiry sweep - replaces MongoDB's TTL index, which
 *      MySQL has no equivalent for (SPEC-1A section 5.2).
 *
 * BOTH ARE INERT UNTIL PHASE 4 LOADS DATA, and that is correct rather than a
 * limitation. Under the additive model live data is still in MongoDB, so these
 * jobs run against empty MySQL tables and purge nothing.
 *
 * THEY ARE DELIBERATELY NOT POINTED AT MONGODB. That work would be thrown away
 * at cutover, and it would put a destructive job against live production data
 * into a phase that has no business touching it.
 *
 * DOUBLE-GUARDED. Registration requires SCHEDULER_ENABLED=true, so a Phase 3
 * deployment cannot begin deleting rows before the migration has run. The
 * default is off; an operator turns it on once, deliberately, after cutover.
 * =============================================================================
 */

'use strict';

const cron = require('node-cron');
const donations = require('../repositories/donations');
const users = require('../repositories/users');
const pendingSignups = require('../repositories/pendingSignups');

// SPEC-1A section 9: donations are retained for ten years.
const RETENTION_YEARS = 10;

// Asia/Kolkata, matching the original node-cron declaration in
// dataCleanupService.js. Times are otherwise ambiguous for an Indian NGO.
const TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'Asia/Kolkata';

const tasks = [];

function tenYearsAgo(now = new Date()) {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - RETENTION_YEARS);
  return d;
}

/**
 * Delete donations older than the retention window.
 *
 * Exported and callable directly so the tests can drive it without waiting for
 * a cron tick, and so Phase 4 can run it once by hand after cutover.
 *
 * `dryRun` counts without deleting. The first post-migration run should be a
 * dry run: this is the job that has never executed, so the first real execution
 * will delete a decade of accumulated rows in one pass and nobody currently
 * knows how many that is.
 */
/**
 * The earliest date that can plausibly be a real donation (AG1a).
 *
 * Not a guess at the organisation's founding date - a floor below which a value
 * is certainly a defect rather than history. A donation dated 1969 is a zero
 * epoch; one dated 1900 is a parse failure. Neither is a donation.
 */
const PLAUSIBLE_FLOOR = new Date('2000-01-01T00:00:00.000Z');

async function purgeOldDonations({ dryRun = false, now = new Date() } = {}) {
  const cutoff = tenYearsAgo(now);

  // Counted FIRST and reported whatever happens next. An implausible date is
  // evidence of a migration defect, and this job must never be the thing that
  // destroys the evidence.
  const implausible = await donations.countImplausibleDates(PLAUSIBLE_FLOOR, now);

  const candidates = await donations.countOlderThan(cutoff, PLAUSIBLE_FLOOR);
  const base = {
    cutoff: cutoff.toISOString(),
    floor: PLAUSIBLE_FLOOR.toISOString(),
    candidates,
    implausible,
  };

  if (implausible > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scheduler] ${implausible} donation(s) are dated before ` +
        `${PLAUSIBLE_FLOOR.toISOString()} or in the future. They are EXCLUDED from the ` +
        'purge. This is a data defect - investigate rather than widening the floor (AG1a).'
    );
  }

  if (dryRun || candidates === 0) {
    return { ...base, deleted: 0, dryRun: Boolean(dryRun) };
  }

  const deleted = await donations.deleteOlderThan(cutoff, PLAUSIBLE_FLOOR);
  return { ...base, deleted, dryRun: false };
}

/**
 * Purge inactive accounts - THE THIRD RETENTION RULE (package 3.3).
 *
 * `dataCleanupService` did three things: donation retention, pending-signup
 * expiry, and this. This file had replaced the first two, and the map recorded
 * that it "already implements the same retention rules" - true of two of them.
 * Retiring the legacy service without this would have DROPPED A RETENTION
 * CONTROL silently, which for an NGO holding donor personal data is the kind of
 * loss that surfaces years later in an audit, not in a test.
 *
 * Same shape as `purgeOldDonations` deliberately: dry-run capable, counts
 * first, never swallows a failure. The guards are the legacy ones - admins are
 * never purged, and an account with ANY donation is never purged, because
 * severing a donation from the person who made it is not a retention outcome
 * anybody asked for.
 */
async function purgeInactiveUsers({ dryRun = false, now = new Date() } = {}) {
  const cutoff = tenYearsAgo(now);
  const candidates = await users.countInactiveOlderThan(cutoff);
  const base = { cutoff: cutoff.toISOString(), candidates };

  if (dryRun || candidates === 0) {
    return { ...base, deleted: 0, dryRun: Boolean(dryRun) };
  }

  const deleted = await users.deleteInactiveOlderThan(cutoff);
  return { ...base, deleted, dryRun: false };
}

/**
 * Delete expired pending signups.
 *
 * This is the TTL replacement, and it is a correctness requirement rather than
 * tidiness: each row holds a name, an email and a bcrypt hash, so a sweep that
 * never runs is a retention problem, not a disk-space one.
 */
async function sweepExpiredSignups({ dryRun = false, now = new Date() } = {}) {
  const candidates = await pendingSignups.countExpired(now);
  if (dryRun || candidates === 0) {
    return { candidates, deleted: 0, dryRun: Boolean(dryRun) };
  }
  const deleted = await pendingSignups.deleteExpired(now);
  return { candidates, deleted, dryRun: false };
}

function enabled() {
  return String(process.env.SCHEDULER_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Register the cron jobs. Called from app.js.
 *
 * @returns {{registered: boolean, reason?: string, jobs: string[]}}
 */
function initializeScheduler() {
  if (!enabled()) {
    // eslint-disable-next-line no-console
    console.log('[scheduler] disabled (set SCHEDULER_ENABLED=true to register jobs)');
    return { registered: false, reason: 'SCHEDULER_ENABLED is not true', jobs: [] };
  }

  // 02:00 daily, matching the Phase 1a Vercel cron declaration.
  tasks.push(
    cron.schedule(
      '0 2 * * *',
      async () => {
        try {
          const result = await purgeOldDonations();
          // eslint-disable-next-line no-console
          console.log('[scheduler] retention purge', JSON.stringify(result));
          // The third retention rule, carried across from dataCleanupService in
          // package 3.3. Run AFTER the donation purge, and that order matters:
          // an account whose last donation was just purged becomes eligible in
          // the same pass, which is what the legacy service did too.
          const accounts = await purgeInactiveUsers();
          // eslint-disable-next-line no-console
          console.log('[scheduler] inactive-account purge', JSON.stringify(accounts));
        } catch (err) {
          // A failed scheduled job must not take the process down - but it must
          // not look like a quiet success either. The legacy
          // dataCleanupService returned 0 from its catch, which made a partial
          // delete indistinguishable from a clean no-op to every caller
          // INCLUDING the log line, which was the only record (BUG-10).
          // eslint-disable-next-line no-console
          console.error(
            '[scheduler] retention purge FAILED - rows may have been partially deleted:',
            err && err.stack ? err.stack : err
          );
        }
      },
      { timezone: TIMEZONE }
    )
  );

  // Hourly. The TTL it replaces was continuous, so a daily sweep would let a
  // row outlive its stated 24-hour lifetime by up to a further day.
  tasks.push(
    cron.schedule(
      '17 * * * *',
      async () => {
        try {
          const result = await sweepExpiredSignups();
          if (result.deleted > 0) {
            // eslint-disable-next-line no-console
            console.log('[scheduler] pending-signup sweep', JSON.stringify(result));
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[scheduler] pending-signup sweep failed:', err && err.message);
        }
      },
      { timezone: TIMEZONE }
    )
  );

  // eslint-disable-next-line no-console
  console.log(`[scheduler] registered 2 job(s), timezone=${TIMEZONE}`);
  return { registered: true, jobs: ['retention-purge', 'pending-signup-sweep'] };
}

function stopScheduler() {
  while (tasks.length > 0) {
    const t = tasks.pop();
    try {
      t.stop();
    } catch {
      // Already stopped.
    }
  }
}

module.exports = {
  initializeScheduler,
  stopScheduler,
  purgeOldDonations,
  purgeInactiveUsers,
  sweepExpiredSignups,
  enabled,
  RETENTION_YEARS,
  PLAUSIBLE_FLOOR,
  tenYearsAgo,
};
