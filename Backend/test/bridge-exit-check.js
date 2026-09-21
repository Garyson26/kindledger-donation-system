/**
 * =============================================================================
 * AE3 PART 1 - zero MongoDB fallbacks across the FULL suite, ASSERTED
 * =============================================================================
 *   npm run test:bridge-exit
 *
 * ADR-050 makes deleting a bridge an EMPIRICAL question, and `readyToDelete()`
 * can only answer it for ONE PROCESS. `node --test` runs each suite in its own
 * process, so the in-memory counter resets sixteen times and a total nobody can
 * see is a total nobody can check.
 *
 * So this reads the evidence the bridges already emit. Every fallback logs a
 * deliberately ugly, greppable tag (AD1a, AJ1b) precisely so that it cannot be
 * taken silently. This runner executes every suite, scans all output for those
 * tags, and EXITS NON-ZERO if any appear.
 *
 * -----------------------------------------------------------------------------
 * THE ONE EXCLUSION, STATED RATHER THAN QUIETLY APPLIED
 * -----------------------------------------------------------------------------
 * `category-bridge.test.js` EXISTS to drive the fallback path - it asserts that
 * a MongoDB-only category still resolves. A check that counted those would be
 * unsatisfiable, and the usual response to an unsatisfiable check is to delete
 * it. It is excluded BY NAME, not by a pattern that could quietly grow.
 *
 * Every other suite is in scope, including the ones that have nothing to do
 * with bridges: a fallback firing in `schema.test.js` would be the single most
 * interesting thing this repository could tell me.
 * =============================================================================
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Suites whose PURPOSE is to exercise the fallback. Name them, do not glob. */
const DRIVES_FALLBACK_BY_DESIGN = new Set(['category-bridge.test.js']);

/**
 * Suites this runner CANNOT execute, with the reason - reported, never dropped.
 * A check that silently skips what it cannot do is worse than one that fails.
 */
const SEPARATE_INVOCATION = new Map([
  [
    'trust-proxy.test.js',
    'runs from the HOST against the compose stack through nginx, not inside the ' +
      'api container. Run `npm run test:trust-proxy` from the host and scan its ' +
      'output with the same markers.',
  ],
]);

/**
 * EACH SUITE GETS ITS OWN MongoDB DATABASE.
 *
 * Learned the expensive way. Pointing every suite at one URI made four of them
 * fail, and pointed the ETL suite's loader at `kindledger_legacy` - the database
 * this project's own migrated rows came FROM. Nothing was lost, because the
 * suites clean up by prefix, but the near-miss is why this is DERIVED here
 * rather than taken from the environment.
 */
function databaseFor(file) {
  const slug = file.replace(/\.test\.js$/, '').replace(/[^a-z0-9]+/gi, '_');
  return 'mongodb://mongo:27017/kindledger_exit_' + slug;
}

/** The tags the bridges emit. Both, because they are emitted in different places. */
const MARKERS = [/MongoDB FALLBACK/, /\[AUTH-DECISION-FROM-MONGO\]/];

const dir = __dirname;
const suites = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

// =============================================================================
// THE SCAN MUST HAVE SCANNED SOMETHING (BH3)
// =============================================================================
// Found by BH3's sweep, in the check that AUTHORISES DELETING THE BRIDGES -
// which is the highest-harm place it could have been.
//
// Without this, a renamed directory or a changed suffix makes `suites` empty,
// every loop body is skipped, no offender is found, and the runner prints
// "AE3 PART 1 PASSES" and exits 0. A green exit check over zero suites is not
// weaker evidence than a real one; it is no evidence wearing its clothes.
//
// `migration-state.test.js` already had this property - "CONTROL FAILED:
// nothing imports models/X, so the scan finds nothing" - and this file did not.
// The control existed one suite away, which is AY2 for the seventh time.
const KNOWN = ['payment-callbacks.test.js', 'auth-characterisation.test.js', 'etl.test.js'];
if (suites.length < 10) {
  // eslint-disable-next-line no-console
  console.error(
    `SCAN FAILED: found only ${suites.length} suite file(s) in ${dir}. The exit ` +
      'check cannot report a clean sweep over a directory it did not read.'
  );
  process.exit(1);
}
for (const k of KNOWN) {
  if (!suites.includes(k)) {
    // eslint-disable-next-line no-console
    console.error(
      `SCAN FAILED: ${k} is not among the discovered suites. Named explicitly ` +
        'because a pattern that quietly stops matching is the failure this guard ' +
        'exists for, and a count alone would not notice one file dropping out.'
    );
    process.exit(1);
  }
}

let failed = 0;
const offenders = [];

const deferred = [];

for (const file of suites) {
  if (SEPARATE_INVOCATION.has(file)) {
    deferred.push(file);
    // eslint-disable-next-line no-console
    console.log('  ' + file.padEnd(40) + 'NOT RUN HERE - ' + SEPARATE_INVOCATION.get(file));
    continue;
  }

  const excluded = DRIVES_FALLBACK_BY_DESIGN.has(file);
  const res = spawnSync(process.execPath, ['--test', path.join(dir, file)], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TEST_MONGODB_URI: databaseFor(file) }),
    timeout: 15 * 60 * 1000,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const hits = output.split('\n').filter((l) => MARKERS.some((m) => m.test(l)));

  const status = res.status === 0 ? 'pass' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(
    `  ${file.padEnd(40)} tests:${status.padEnd(5)} fallbacks:${String(hits.length).padStart(3)}` +
      (excluded ? '   (excluded - drives the fallback by design)' : '')
  );

  if (res.status !== 0) failed += 1;
  if (!excluded && hits.length > 0) offenders.push({ file, hits });
}

// eslint-disable-next-line no-console
console.log('\n' + '-'.repeat(78));

if (offenders.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    'AE3 PART 1 FAILS. A bridge STILL CARRIED TRAFFIC. Deleting it now would not ' +
      'remove dead code - it would make these lookups return nothing:\n'
  );
  for (const o of offenders) {
    // eslint-disable-next-line no-console
    console.error(`  ${o.file}`);
    for (const h of o.hits.slice(0, 5)) console.error(`      ${h.trim()}`);
  }
  process.exit(1);
}

if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `AE3 PART 1 IS NOT ANSWERED. ${failed} suite(s) FAILED, so "no fallback fired" ` +
      'may only mean the code that would have fired never ran. A green exit ' +
      'check on a red suite is the inverted oracle again (AX4).'
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
if (deferred.length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    'NOT ANSWERED HERE: ' + deferred.join(', ') + '. Stated rather than skipped - ' +
      'see SEPARATE_INVOCATION at the top of this file.'
  );
}

console.log(
  'AE3 PART 1 PASSES: every suite green, and NO MongoDB fallback fired outside\n' +
    'the one suite that exists to drive it. This is the first of TWO conditions.\n' +
    'Part 2 - an exercise against a database holding BOTH migrated and post-3.1\n' +
    'records - cannot be inferred from here and is recorded separately.'
);
