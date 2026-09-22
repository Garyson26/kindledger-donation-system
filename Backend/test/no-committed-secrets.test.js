/**
 * =============================================================================
 * BJ4 - no tracked file may carry a working credential
 * =============================================================================
 *   npm run test:no-secrets
 *
 * No database, no network. It reads what git tracks.
 *
 * `.env.example` being clean is good and is NOT the control - it is one file
 * staying well-written. The control is that NOTHING a self-hoster copies
 * carries a credential that works, checked every time.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS THE PUBLICATION RISK AND NOT A TIDINESS RULE
 * -----------------------------------------------------------------------------
 * This project is going to be published. The failure mode is an NGO cloning the
 * repository, running `docker compose up`, and inheriting a password that works
 * - or worse, a JWT secret that works, which makes every token forgeable by
 * anyone who has also read the repository.
 *
 * A fallback like `process.env.JWT_SECRET || 'dev-secret'` reads as
 * defensive programming and is the whole vulnerability. `config/jwt.js`
 * correctly throws instead, and this check is what keeps it that way.
 *
 * -----------------------------------------------------------------------------
 * SCOPE, AND WHY TESTS ARE OUTSIDE IT
 * -----------------------------------------------------------------------------
 * Files a self-hoster DEPLOYS: env templates, compose files, application source,
 * schema, CI workflows.
 *
 * `Backend/test/` is excluded deliberately and with a property rather than by a
 * blanket skip: its fixtures are credentials for nothing, they exist to be
 * typed into a throwaway database, and requiring them to be absent would mean
 * either an untestable suite or a second mechanism for supplying them. The
 * exclusion is one line below and says so; it is not hidden in a glob.
 * =============================================================================
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Files a self-hoster copies and runs.
 *
 * ANY TRACKED `.env*` ANYWHERE, and the widening is a finding of its own. The
 * first version named `.env.example` and `Backend/.env.example` - the two I
 * knew about - and would not have seen `Frontend/.env`, which is tracked.
 *
 * That file holds only `VITE_API_URL`, a value Vite embeds in the bundle and
 * which is public by construction, so nothing is exposed today. The hazard is
 * the next person adding a real value to a file git is already watching.
 *
 * A pattern listing the files you expect cannot see the one you did not expect
 * (AT4's dead imports, AR1's out-of-routes crossings, BJ4's second env
 * template). So the rule is the SHAPE of the name, not a list.
 */
const IN_SCOPE =
  /(^|\/)\.env($|\.)|^(docker-compose.*\.ya?ml|db\/.*\.sql|\.github\/workflows\/.*\.ya?ml|Backend\/(?!test\/).*\.js|Frontend\/src\/.*\.(js|jsx|ts|tsx))$/;

/**
 * A name that, holding a real value, would be a credential.
 * ALL-CAPS only: lowercase `token`, `passwordHash` and `credentials: true` are
 * code, not configuration, and matching them produced 70 hits of pure noise on
 * the first run of this check.
 *
 * -----------------------------------------------------------------------------
 * THIS IS A PROXY, AND SAYING SO IS PART OF THE CHECK (BO3)
 * -----------------------------------------------------------------------------
 * The PROPERTY is "no tracked file carries a working credential". What this
 * measures is "no tracked file assigns a non-placeholder value to a
 * CREDENTIAL-SHAPED NAME". Those are not the same claim.
 *
 * **A real secret stored as `FOO=8f3a...` is invisible to this check**, and no
 * refinement of the name pattern fixes that - the information simply is not in
 * the name.
 *
 * It is kept because the failure it does catch is the one that actually
 * happens: somebody writes `JWT_SECRET=` followed by something that works. It
 * is NOT a claim that the repository is free of secrets, and a green run must
 * not be cited as one.
 *
 * The second mechanism BC1 asks for is human review before publication - which
 * is weaker than a check, and is why this says so here rather than leaving a
 * green tick to be read as more than it is.
 */
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*(SECRET|PASSWORD|SALT|KEY|TOKEN|CREDENTIALS?)$/;

/**
 * A value that is visibly NOT a working credential.
 *
 * `ci-` is here on purpose: the workflows set `ci-root-password` and
 * `ci-only-jwt-secret-...` for a database that exists for ninety seconds inside
 * a GitHub runner. They are not secrets and pretending otherwise would push
 * them into repository settings, where they would be harder to read and no
 * safer.
 */
const OBVIOUSLY_NOT_REAL =
  /^(\$\{|<|["']?\s*$|test|TEST|ci-|CI-|zzz|ZZZ|changeme|CHANGEME|example|EXAMPLE|placeholder|dummy|fake|your|YOUR|xxx|\.\.\.|REPLACE|replace)/;

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

/** `NAME=value` and `NAME: value` - the shapes configuration actually takes. */
const ASSIGNMENT = /^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.+?)\s*$/;

function offendersIn(file) {
  const abs = path.join(repoRoot, file);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const lines = fs.readFileSync(abs, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    const m = ASSIGNMENT.exec(line);
    if (!m) return;

    const name = m[1];
    const value = m[2].replace(/^["']|["'],?$/g, '').trim();
    if (!CREDENTIAL_NAME.test(name)) return;
    if (value === '') return;
    if (OBVIOUSLY_NOT_REAL.test(value)) return;
    // `FOO: ${BAR}` and `FOO: process.env.BAR` are references, not values.
    if (value.startsWith('process.env') || value.startsWith('require')) return;

    // A URL IS NOT A CREDENTIAL, whatever the constant is called.
    //
    // Widening the scope to Frontend/src immediately flagged four lines of
    // `Frontend/src/config/constants.js` - RESET_PASSWORD, CHANGE_PASSWORD,
    // FORGOT_PASSWORD, REFRESH_TOKEN - whose values are template literals
    // building API paths. The NAMES are credential-shaped and the VALUES are
    // routes.
    //
    // Recorded rather than quietly patched because it is the failure mode this
    // file already warns about: a check that flags everything gets turned off,
    // and the first one turned off is the one that cried wolf.
    if (value.startsWith('`') || /^https?:\/\//.test(value) || value.startsWith('/')) return;

    out.push({ file, line: i + 1, name, value });
  });

  return out;
}

// =============================================================================

test('BJ4: no tracked file a self-hoster deploys carries a working credential', () => {
  const scoped = trackedFiles().filter((f) => IN_SCOPE.test(f));

  // THE SCAN MUST ACTUALLY SCAN SOMETHING. A pattern that stops matching - a
  // directory renamed, a glob subtly wrong - would otherwise report a clean
  // sweep over nothing, which is exactly the vacuous-test shape BH3 exists to
  // find. This is that guard, applied to this check.
  assert.ok(
    scoped.length > 20,
    `the scan matched only ${scoped.length} tracked files, which means the scope ` +
      'pattern is wrong. A clean result over nothing is not a clean result.'
  );
  assert.ok(
    scoped.includes('.env.example'),
    'the root env template must be in scope - it is the file people copy'
  );
  // Named explicitly because it is the one a pattern-by-list missed, and the
  // reason the scope is now shaped rather than enumerated.
  assert.ok(
    scoped.includes('Frontend/.env'),
    'EVERY tracked .env must be in scope, not the two we happen to know about'
  );
  assert.ok(
    scoped.some((f) => f.startsWith('docker-compose')),
    'the compose file must be in scope'
  );

  const offenders = scoped.flatMap(offendersIn);

  assert.deepEqual(
    offenders,
    [],
    'TRACKED FILES CARRY CREDENTIAL-SHAPED VALUES:\n' +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.name}=${o.value}`).join('\n') +
      '\n\nA self-hoster clones this repository and inherits these. If one is a ' +
      'JWT secret, every token is forgeable by anyone who has read the repo. ' +
      'Blank the value, or make it visibly synthetic.'
  );
});

test('BJ4: the check CATCHES a planted secret - proved by injection', () => {
  // AV2. A scan that has never been seen to fire is a comment. This plants the
  // exact line the check exists to stop and asserts it is found.
  const planted = [
    'JWT_SECRET=s3cr3t-that-actually-works-32-chars',
    'MYSQL_ROOT_PASSWORD=hunter2hunter2',
    "const PAYU_MERCHANT_SALT = 'aVeryRealLookingSaltValue12345678'",
  ];

  const tmp = path.join(__dirname, '.bj4-injection-probe.env');
  try {
    fs.writeFileSync(tmp, planted.join('\n'), 'utf8');
    const found = offendersIn(path.relative(repoRoot, tmp).split(path.sep).join('/'));

    assert.ok(
      found.length >= 2,
      `the check found ${found.length} of the planted credentials. It must find ` +
        'the plain NAME=value ones at minimum, or it would not have caught the ' +
        'fallback secret this exists for.'
    );
    assert.ok(
      found.some((o) => o.name === 'JWT_SECRET'),
      'a planted JWT_SECRET must be found - it is the worst case'
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('BJ4: it does NOT fire on placeholders, references or CI throwaways', () => {
  // The other half. A check that flags everything gets turned off, and the
  // first thing turned off is the one that cried wolf.
  const tmp = path.join(__dirname, '.bj4-negative-probe.env');
  try {
    fs.writeFileSync(
      tmp,
      [
        'JWT_SECRET=',
        'MYSQL_PASSWORD=<your-password>',
        'PAYU_MERCHANT_SALT=${PAYU_MERCHANT_SALT}',
        'ADMIN_CREATION_KEY=CHANGEME',
        'MYSQL_ROOT_PASSWORD=ci-root-password',
        'DATABASE_URL=mysql://kindledger:CHANGEME@db:3306/kindledger',
      ].join('\n'),
      'utf8'
    );
    const found = offendersIn(path.relative(repoRoot, tmp).split(path.sep).join('/'));
    assert.deepEqual(
      found,
      [],
      'false positives: ' + found.map((o) => `${o.name}=${o.value}`).join(', ')
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});
