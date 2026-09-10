/**
 * =============================================================================
 * Scheduled jobs (SPEC-2 section 7.2)
 * =============================================================================
 * Two jobs, both against MySQL:
 *
 *   1. The retention purge - BUG-04. Declared as a Vercel cron in Phase 1a
 *      against POST /api/admin/cleanup/trigger, which sits behind adminAuth, so
 *      the cron received a 401 and the purge has never once run.
 *   2. The pending-signup expiry sweep - replaces MongoDB's TTL index, which
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
async function purgeOldDonations({ dryRun = false, now = new Date() } = {}) {
  const cutoff = tenYearsAgo(now);
  const candidates = await donations.countOlderThan(cutoff);
  if (dryRun || candidates === 0) {
    return { cutoff: cutoff.toISOString(), candidates, deleted: 0, dryRun: Boolean(dryRun) };
  }
  const deleted = await donations.deleteOlderThan(cutoff);
  return { cutoff: cutoff.toISOString(), candidates, deleted, dryRun: false };
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
        } catch (err) {
          // A failed scheduled job must never take the process down.
          // eslint-disable-next-line no-console
          console.error('[scheduler] retention purge failed:', err && err.message);
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
  sweepExpiredSignups,
  enabled,
  RETENTION_YEARS,
  tenYearsAgo,
};
