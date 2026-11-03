/**
 * =============================================================================
 * Run every suite and say which failed
 * =============================================================================
 *   npm run test:all
 *
 * WAS `bridge-exit-check.js`, which measured AE3's exit condition: zero MongoDB
 * fallbacks across the full suite, as the evidence for deleting the bridges.
 *
 * **Package 3.6 deleted the bridges, so that check became vacuous by
 * construction** - it scanned for log markers nothing emits any more and would
 * have reported a clean sweep for ever, on a subject that no longer exists.
 * That is the shape BH3 was commissioned to find, and this file is where BH3
 * found one (a scan that could report clean over zero suites).
 *
 * The AE3 apparatus is gone. What is kept is the part that was useful
 * independently of bridges: the only single command that runs every suite, with
 * BH3's guard that it actually found some.
 *
 * A gate built for a migration has an end date. Leaving it in place afterwards
 * does not make it a safety net; it makes it a green tick with no subject.
 * =============================================================================
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Suites this runner CANNOT execute, with the reason - reported, never dropped.
 * A check that silently skips what it cannot do is worse than one that fails.
 */
const SEPARATE_INVOCATION = new Map([
  [
    'no-committed-secrets.test.js',
    'reads `git ls-files`, and git is not installed in the api image. It needs ' +
      'no services at all - run `npm run test:no-secrets` on the host or the CI ' +
      'runner, where git exists.',
  ],
  [
    'trust-proxy.test.js',
    'runs from the HOST against the compose stack through nginx, not inside the ' +
      'api container.',
  ],
]);

/**
 * The MongoDB SERVER is wherever this process was told it is: `mongo:27017`
 * inside the api container (compose), 127.0.0.1 on a CI runner, which sets
 * TEST_MONGODB_URI to its service. Only the database NAME is chosen per suite,
 * below. Hard-coding the compose host made every MongoDB suite fail on CI while
 * passing in its own step (CM1). An Atlas host is refused: a test runner never
 * touches a hosted cluster.
 */
const MONGO_SERVER = (() => {
  const m = /^(mongodb:\/\/[^/?]+)/.exec(process.env.TEST_MONGODB_URI || '');
  const server = m ? m[1] : 'mongodb://mongo:27017';
  if (/mongodb\.net|^mongodb\+srv:/i.test(server)) {
    throw new Error(`REFUSING: TEST_MONGODB_URI points at a hosted cluster (${server.replace(/\/\/[^@]*@/, '//***@')}).`);
  }
  return server;
})();

/** EACH SUITE GETS ITS OWN MongoDB DATABASE - see the note below. */
function databaseFor(file) {
  // `null-minted` is the exception, and it is not a convenience.
  //
  // It runs a DESTRUCTIVE operation whose oracle is "does a document with this
  // _id exist", so it must read the database the ETL migrated FROM. Given a
  // scratch one its own guard REFUSES - correctly, and the whole suite fails.
  //
  // That refusal is the control working, so the runner supplies the right
  // database rather than the suite relaxing its guard.
  if (file === 'null-minted.test.js') return MONGO_SERVER + '/kindledger_legacy';

  const slug = file.replace(/\.test\.js$/, '').replace(/[^a-z0-9]+/gi, '_');
  return MONGO_SERVER + '/kindledger_all_' + slug;
}

const dir = __dirname;
const suites = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

// THE RUNNER MUST HAVE FOUND SOMETHING (BH3). A renamed directory or a changed
// suffix would empty this list, skip every loop body, and print a clean report
// on no evidence.
const KNOWN = ['payment-callbacks.test.js', 'auth-characterisation.test.js', 'etl.test.js'];
if (suites.length < 10) {
  // eslint-disable-next-line no-console
  console.error(`SCAN FAILED: found only ${suites.length} suite file(s) in ${dir}.`);
  process.exit(1);
}
for (const k of KNOWN) {
  if (!suites.includes(k)) {
    // eslint-disable-next-line no-console
    console.error(`SCAN FAILED: ${k} is not among the discovered suites.`);
    process.exit(1);
  }
}

let failed = 0;
const deferred = [];

for (const file of suites) {
  if (SEPARATE_INVOCATION.has(file)) {
    deferred.push(file);
    // eslint-disable-next-line no-console
    console.log('  ' + file.padEnd(40) + 'NOT RUN HERE - ' + SEPARATE_INVOCATION.get(file));
    continue;
  }

  const res = spawnSync(process.execPath, ['--test', path.join(dir, file)], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TEST_MONGODB_URI: databaseFor(file) }),
    timeout: 15 * 60 * 1000,
  });

  // eslint-disable-next-line no-console
  console.log(`  ${file.padEnd(40)} ${res.status === 0 ? 'pass' : 'FAIL'}`);
  if (res.status !== 0) {
    failed += 1;
    // A FAIL with no reason sends the reader off to re-run the suite by hand.
    // Show the failing assertions, or the tail of the output if there are none.
    const lines = `${res.stdout || ''}${res.stderr || ''}`.split('\n');
    const notOk = lines.filter((l) => /^\s*not ok |^\s*(error|expected|actual|code):|AssertionError/.test(l));
    const shown = (notOk.length ? notOk : lines.filter(Boolean).slice(-25)).slice(0, 40);
    // eslint-disable-next-line no-console
    console.log(shown.map((l) => '      | ' + l).join('\n'));
  }
}

// eslint-disable-next-line no-console
console.log(`
${'-'.repeat(78)}`);
if (deferred.length > 0) {
  // eslint-disable-next-line no-console
  console.log(`NOT RUN HERE: ${deferred.join(', ')}. Stated rather than skipped.
`);
}

if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`${failed} suite(s) FAILED.`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('Every suite run here passed.');
