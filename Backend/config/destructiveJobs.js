/**
 * =============================================================================
 * AUTHORISATION for jobs that delete records (AT1)
 * =============================================================================
 * SAFETY AND AUTHORISATION ARE DIFFERENT QUESTIONS, AND ONE FLAG MUST NOT
 * ANSWER BOTH.
 *
 *   config/migrationState  answers  "is it SAFE to delete from this store?"
 *   this module             answers  "SHOULD we be deleting at all?"
 *
 * A job runs only when BOTH say yes. Neither is sufficient, and the second is
 * never implied by the first.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS: A PURGE WENT LIVE AS A SIDE EFFECT
 * -----------------------------------------------------------------------------
 * Package AS7 migrated `routes/admin.js` and moved `user` from `split` to
 * `mysql`. That was correct. It also, with no further decision by anyone, made
 * the inactive-account purge runnable - `migrationState.assertDeletable('user')`
 * had been refusing it, and stopped.
 *
 * An operator who set `SCHEDULER_ENABLED=true` after that package would delete
 * accounts that the same setting would have spared before it. Nobody asked for
 * that as a feature; it fell out of a migration.
 *
 * **IT WOULD HAVE RECURRED, AND WORSE.** Package 3.4 moves `donation` to
 * `mysql`, which under the old arrangement would make the DONATION retention
 * purge live on the same transition - two destructive jobs authorised at once,
 * by a change whose subject was a route file.
 *
 * -----------------------------------------------------------------------------
 * MIGRATION STATE IS A SAFETY PRECONDITION, NOT AN AUTHORISATION
 * -----------------------------------------------------------------------------
 * `migrationState` says the rows are all in one place and deleting from it will
 * not destroy history while live writes accumulate elsewhere. That is a
 * statement about CORRECTNESS. It is not, and must never be read as, a
 * statement that anyone wants the deletion to happen.
 *
 * The gates below are per-JOB and not one global flag, deliberately. A single
 * "destructive jobs enabled" switch would re-create the problem one level up:
 * an operator turning it on for the pending-signup sweep would authorise the
 * donation retention purge in the same keystroke.
 *
 * THEY DEFAULT TO OFF, and no code path anywhere turns one on. Only an operator
 * setting the environment variable does.
 * =============================================================================
 */

'use strict';

/**
 * @typedef {Object} JobDefinition
 * @property {string} env      The environment variable that authorises it.
 * @property {string} entity   The entity it deletes, checked against migrationState.
 * @property {string} deletes  What is lost, in plain words, for the refusal message.
 * @property {string} costOfLeavingItOff
 *   Not every default-off job is free. An operator deciding what to enable needs
 *   BOTH halves, or "off" reads as the cautious choice everywhere and one of
 *   these is a retention obligation going unmet.
 */

/** @type {Record<string, JobDefinition>} */
const JOBS = {
  'retention-purge': {
    env: 'JOB_RETENTION_PURGE',
    entity: 'donation',
    deletes: 'donation records older than the ten-year retention window',
    costOfLeavingItOff:
      'Donations are retained past the stated ten years. A retention POLICY ' +
      'that is documented and not enforced is its own finding (BUG-04), so ' +
      'this should be turned on deliberately after cutover - not left off by ' +
      'inertia.',
  },

  'inactive-account-purge': {
    env: 'JOB_INACTIVE_ACCOUNT_PURGE',
    entity: 'user',
    deletes: 'accounts older than ten years that have never made a donation',
    costOfLeavingItOff:
      'Personal data for accounts nobody has used in a decade is kept ' +
      'indefinitely. Same shape as the above: not enforcing a stated retention ' +
      'rule is a finding, not a safe default.',
  },

  'pending-signup-sweep': {
    env: 'JOB_PENDING_SIGNUP_SWEEP',
    entity: 'pendingSignup',
    deletes: 'unverified signup attempts older than 24 hours',
    costOfLeavingItOff:
      'THIS IS THE ONE TO TURN ON FIRST. Each row holds a name, an email and a ' +
      'bcrypt hash, and it replaces a MongoDB TTL index that used to expire ' +
      'them continuously (SPEC-1A section 5.2). Leaving it off means those ' +
      'rows accumulate forever - a sweep that never runs is a retention ' +
      'problem, not a disk-space one, and it is the reason this job exists.',
  },
};

const jobNames = () => Object.keys(JOBS);

function definitionOf(job) {
  const def = JOBS[job];
  if (!def) {
    throw new Error(
      `Unknown destructive job '${job}'. Declare it in ` +
        'config/destructiveJobs.js rather than running it ungated - a job ' +
        'nobody declared is a job nobody authorised.'
    );
  }
  return def;
}

/** Truthy only for an explicit 'true'. '1', 'yes' and 'TRUE ' are not enough. */
function isAuthorised(job) {
  const def = definitionOf(job);
  return String(process.env[def.env] || '').trim().toLowerCase() === 'true';
}

/**
 * Refuse a job the operator has not explicitly authorised.
 *
 * Typed distinctly from `migrationState`'s refusal, because the two mean
 * opposite things to whoever reads the log: this one says the system is working
 * as configured, the other says the configuration would have destroyed data.
 */
function assertAuthorised(job) {
  const def = definitionOf(job);
  if (isAuthorised(job)) return;

  const err = new Error(
    `NOT AUTHORISED: the '${job}' job deletes ${def.deletes}, and ` +
      `${def.env} is not 'true'. This is separate from migration state on ` +
      'purpose: migration state says whether deleting would be SAFE, not ' +
      'whether anyone wants it to happen (AT1). ' +
      def.costOfLeavingItOff
  );
  err.code = 'ERR_JOB_NOT_AUTHORISED';
  err.job = job;
  err.env = def.env;
  throw err;
}

/**
 * Both gates, in the order that produces the most useful refusal.
 *
 * AUTHORISATION IS CHECKED FIRST. If nobody asked for the deletion, whether it
 * would have been safe is moot, and reporting the safety problem first would
 * send an operator to fix a migration they have no need to care about yet.
 */
function assertRunnable(job, operation) {
  assertAuthorised(job);
  // Required here rather than at module load: config/migrationState is read by
  // the ETL and the bridges too, and a cycle through services/scheduler would
  // be easy to introduce and hard to see.
  require('./migrationState').assertDeletable(definitionOf(job).entity, operation);
}

/** For the boot log and the scheduler's registration notice. */
const authorisedJobs = () => jobNames().filter(isAuthorised);
const unauthorisedJobs = () => jobNames().filter((j) => !isAuthorised(j));

function summary() {
  return jobNames()
    .map((j) => `${j}=${isAuthorised(j) ? 'authorised' : 'off'}`)
    .join(' ');
}

module.exports = {
  JOBS,
  jobNames,
  definitionOf,
  isAuthorised,
  assertAuthorised,
  assertRunnable,
  authorisedJobs,
  unauthorisedJobs,
  summary,
};
