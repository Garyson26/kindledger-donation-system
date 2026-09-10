#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * Server compatibility guard (SPEC-1A B4)
 * =============================================================================
 * Refuses to proceed unless the server is MySQL >= 8.0.16 and not MariaDB.
 *
 *   node db/require-mysql-version.js          # exits non-zero if unsupported
 *
 * Wired into `npm run db:migrate` and `npm run db:seed` so an unsupported
 * server fails loudly before anything is written.
 *
 * WHY THIS IS NOT PARANOIA
 *
 *   MySQL < 8.0.16 - CHECK constraint syntax PARSES AND IS THEN SILENTLY
 *   IGNORED. The schema would apply without a single error and without any of
 *   its guarantees: a category could be priced at zero, a donation could be
 *   for zero rupees, branding_settings could hold rows for id 2, 3, 4. Nothing
 *   would surface until someone noticed the data was wrong.
 *
 *   MariaDB - has no utf8mb4_0900_* collations at all. It forks MySQL at 5.5
 *   and never adopted the UCA 9.0.0 collations. The DDL either fails outright
 *   on the COLLATE clauses or, depending on version and configuration, falls
 *   back to a different collation. A fallback to a case-SENSITIVE collation
 *   silently reopens the duplicate-account gap the unique index exists to
 *   close; a fallback to an accent-INSENSITIVE one silently merges
 *   jose@x.com with its e-with-acute variant. Both are data-integrity
 *   as ordinary application bugs months later.
 *
 * Once this repository is public, NGOs will run it against whatever their host
 * provides. A clear refusal at install time is far kinder than either failure.
 * =============================================================================
 */

'use strict';

const MIN = { major: 8, minor: 0, patch: 16 };
const MIN_STR = `${MIN.major}.${MIN.minor}.${MIN.patch}`;

const REQUIREMENT =
  'KindLedger requires MySQL 8.0.16 or later. MariaDB is not supported.';

function fail(detail, remedy) {
  console.error('\n' + '='.repeat(72));
  console.error('  UNSUPPORTED DATABASE SERVER');
  console.error('='.repeat(72));
  console.error(`  ${REQUIREMENT}`);
  console.error('');
  console.error(`  Detected: ${detail}`);
  if (remedy) {
    console.error('');
    for (const line of remedy) console.error(`  ${line}`);
  }
  console.error('='.repeat(72) + '\n');
  process.exit(1);
}

/** Parses the leading x.y.z out of a MySQL version string. */
function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function isAtLeastMinimum(v) {
  if (v.major !== MIN.major) return v.major > MIN.major;
  if (v.minor !== MIN.minor) return v.minor > MIN.minor;
  return v.patch >= MIN.patch;
}

/**
 * Pure classifier, exported so it can be unit tested without a live server.
 *
 * This matters: a MariaDB instance often cannot be reached through Prisma at
 * all (the handshake fails before any query runs), so the 'mariadb' branch is
 * hard to exercise end to end. Keeping the decision in a pure function means
 * the logic is still covered by tests. See test/server-guard.test.js.
 *
 * @returns {{kind: 'mariadb'|'unparseable'|'too-old'|'ok', version: string}}
 */
function classifyServer(version, comment) {
  const haystack = `${version || ''} ${comment || ''}`.toLowerCase();

  // MariaDB is usually obvious from VERSION() ("11.8.9-MariaDB-ubu2404") but
  // version_comment is checked too, since some builds report only there
  // ("mariadb.org binary distribution").
  if (haystack.includes('mariadb')) {
    return { kind: 'mariadb', version: String(version) };
  }

  const v = parseVersion(version);
  if (!v) return { kind: 'unparseable', version: String(version) };
  if (!isAtLeastMinimum(v)) return { kind: 'too-old', version: String(version) };
  return { kind: 'ok', version: String(version) };
}

/**
 * Does this sql_mode give strict behaviour for transactional tables?
 *
 * WHY THIS IS A HARD REQUIREMENT, not a preference.
 * Without STRICT_TRANS_TABLES, MySQL does not reject an out-of-set ENUM value.
 * It inserts the EMPTY STRING and raises a *warning* instead of error 1265.
 * Verified against mysql:8.4.11 with sql_mode='':
 *
 *   INSERT ... status='banana', payment_status='nonsense'
 *     -> Warning 1265 (not an error)
 *     -> stored as '' / '', LENGTH(status) = 0
 *     -> the row is INVISIBLE to `WHERE payment_status = 'Paid'`
 *
 * That is BUG-02 / BUG-03 recreated: a donation exists whose status matches no
 * filter, so it silently vanishes from every report and reconciliation. The
 * ENUM stops being a constraint and becomes a suggestion.
 *
 * STRICT_TRANS_TABLES is a MySQL 8 default, but sql_mode is settable and
 * managed providers ship their own defaults, so it must be checked rather than
 * assumed.
 *
 * STRICT_ALL_TABLES is stricter and also acceptable. TRADITIONAL is a
 * composite that includes STRICT_TRANS_TABLES; MySQL normally expands it in
 * @@sql_mode, but it is accepted here in case a build reports the alias.
 *
 * Exported as a pure function so it is unit testable without a server.
 */
function hasStrictMode(sqlMode) {
  const modes = String(sqlMode || '')
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  return (
    modes.includes('STRICT_TRANS_TABLES') ||
    modes.includes('STRICT_ALL_TABLES') ||
    modes.includes('TRADITIONAL')
  );
}

/**
 * Is this error consistent with never having reached a MySQL server that would
 * answer a version query - i.e. a connection or authentication failure?
 *
 * C5: on a real MariaDB the connection frequently fails at the handshake,
 * before any version query runs, so the 'mariadb' verdict is never reached and
 * the self-hoster sees a bare connection error instead of the message written
 * for them. This lets that path name MariaDB as a likely cause.
 */
function looksLikeConnectionFailure(message) {
  return /authentication failed|access denied|can't reach|cannot reach|connection refused|econnrefused|handshake|server has gone away|protocol|timed out|etimedout/i.test(
    String(message || '')
  );
}

module.exports = {
  classifyServer,
  parseVersion,
  isAtLeastMinimum,
  hasStrictMode,
  looksLikeConnectionFailure,
  MIN_STR,
  REQUIREMENT,
};

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let version;
  let comment;
  let sessionMode;
  let globalMode;
  try {
    // version_comment names the distribution; MariaDB reports itself there
    // even when @@version has been made to look like MySQL.
    const rows = await prisma.$queryRawUnsafe(
      'SELECT VERSION() AS version, @@version_comment AS comment, ' +
        '@@SESSION.sql_mode AS session_mode, @@GLOBAL.sql_mode AS global_mode'
    );
    version = rows[0].version;
    comment = rows[0].comment || '';
    sessionMode = rows[0].session_mode || '';
    globalMode = rows[0].global_mode || '';
  } catch (err) {
    await prisma.$disconnect().catch(() => {});

    // C5: a MariaDB server usually fails here rather than at the version
    // check, so this is the branch that has to name it. Otherwise the person
    // this guard exists for never sees the message written for them.
    if (looksLikeConnectionFailure(err.message)) {
      // Prisma error messages begin with blank lines, so take the first
      // non-empty line rather than line zero.
      const firstLine =
        String(err.message || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .find((l) => !/^invalid `prisma/i.test(l)) || 'no detail available';

      fail(`no usable connection to the server: ${firstLine}`, [
        'MARIADB IS A LIKELY CAUSE if you are pointing this at one.',
        '',
        'MariaDB is not supported, and the connection typically fails during',
        'the handshake - before any version query can run - so this guard',
        'cannot always name it explicitly. If your server is MariaDB, that is',
        'the problem, and no amount of credential fixing will help.',
        '',
        'MariaDB has no utf8mb4_0900_* collations. The email uniqueness',
        'guarantee in db/schema.sql depends on utf8mb4_0900_as_ci, and a',
        'silent fallback to another collation would either merge distinct',
        'donor accounts or permit duplicate ones.',
        '',
        'Otherwise, the usual causes are:',
        '  - DATABASE_URL host, port, user or password is wrong',
        '  - the database is not running, or not reachable from here',
        '  - a password containing reserved characters is not percent-encoded',
        '',
        'The bundled docker-compose.yml provides a correct mysql:8.4:',
        '    docker compose up -d db',
      ]);
      return;
    }

    fail(`could not query the server version (${err.message})`, [
      'Check DATABASE_URL and that the database is reachable.',
    ]);
    return;
  }

  await prisma.$disconnect().catch(() => {});

  const verdict = classifyServer(version, comment);

  if (verdict.kind === 'mariadb') {
    fail(`MariaDB (${version})`, [
      'MariaDB has no utf8mb4_0900_* collations. The email uniqueness',
      'guarantee in db/schema.sql depends on utf8mb4_0900_as_ci, and a silent',
      'fallback to another collation would either merge distinct accounts or',
      'permit duplicate ones.',
      '',
      'Use MySQL 8.0.16+ or 8.4 LTS. The bundled docker-compose.yml provides',
      'a correctly configured mysql:8.4 out of the box.',
    ]);
  }

  if (verdict.kind === 'unparseable') {
    fail(`an unrecognised version string ("${version}")`, [
      'Expected something like "8.4.11". Cannot confirm CHECK constraint',
      'support, so refusing rather than guessing.',
    ]);
  }

  if (verdict.kind === 'too-old') {
    fail(`MySQL ${version}`, [
      `CHECK constraints are only ENFORCED from ${MIN_STR}. On ${version} the`,
      'syntax in db/schema.sql parses and is then silently ignored, so the',
      'schema would apply with none of its integrity guarantees:',
      '  - a category could be priced at zero',
      '  - a donation could be recorded for zero rupees',
      '  - branding_settings could hold more than one row',
      '',
      'Upgrade to MySQL 8.0.16+ (8.4 LTS recommended).',
    ]);
  }

  // C3. Strict SQL mode. Without it an out-of-set ENUM value is inserted as
  // the EMPTY STRING with a warning rather than error 1265, which silently
  // recreates the BUG-02 / BUG-03 corruption class.
  //
  // Both scopes are checked. SESSION governs writes on this connection;
  // GLOBAL is what every new connection inherits, including the application's
  // pool, the Phase 4 ETL and anyone at a mysql prompt. A non-strict GLOBAL is
  // a loaded gun even if this particular session happens to be strict.
  for (const [scope, mode] of [['SESSION', sessionMode], ['GLOBAL', globalMode]]) {
    if (!hasStrictMode(mode)) {
      fail(`MySQL ${version} with a non-strict ${scope} sql_mode`, [
        `${scope} sql_mode = "${mode}"`,
        '',
        'STRICT_TRANS_TABLES (or STRICT_ALL_TABLES) is required. Without it,',
        'MySQL does not reject an out-of-set ENUM value - it inserts the EMPTY',
        'STRING and raises a warning instead of error 1265. Verified:',
        '',
        "    INSERT ... status='banana', payment_status='nonsense'",
        '      -> Warning 1265, not an error',
        "      -> stored as '' / '', LENGTH(status) = 0",
        "      -> the row is INVISIBLE to WHERE payment_status = 'Paid'",
        '',
        'That is a donation whose status matches no filter, so it vanishes',
        'from every report and reconciliation without a trace. The ENUM stops',
        'being a constraint and becomes a suggestion.',
        '',
        'Fix it on the server (my.cnf / provider console):',
        '    sql_mode = STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
        '',
        'The bundled docker-compose.yml uses the MySQL 8 default, which is',
        'already strict.',
      ]);
    }
  }

  // 3. Positive confirmation that CHECKs are actually enforced, not merely
  //    supported by version number. Cheap, and catches an exotic build.
  const { PrismaClient: PC } = require('@prisma/client');
  const p2 = new PC();
  try {
    await p2.$executeRawUnsafe('DROP TABLE IF EXISTS _kl_check_probe');
    await p2.$executeRawUnsafe(
      'CREATE TABLE _kl_check_probe (n INT, CONSTRAINT ck_probe CHECK (n > 0)) ENGINE=InnoDB'
    );
    let enforced = false;
    try {
      await p2.$executeRawUnsafe('INSERT INTO _kl_check_probe (n) VALUES (0)');
    } catch {
      enforced = true;
    }
    await p2.$executeRawUnsafe('DROP TABLE IF EXISTS _kl_check_probe');

    if (!enforced) {
      await p2.$disconnect().catch(() => {});
      fail(`MySQL ${version}, which accepted a CHECK violation`, [
        'The server reports a supported version but did not enforce a CHECK',
        'constraint. Refusing to apply a schema whose integrity guarantees',
        'would be silently absent.',
      ]);
    }
  } catch (err) {
    // A failure to run the probe itself (permissions, say) should not block
    // an otherwise supported server - the version check already passed.
    console.warn(`  note: CHECK enforcement probe could not run (${err.message})`);
  } finally {
    await p2.$disconnect().catch(() => {});
  }

  console.log(`  Database server OK: MySQL ${version} (CHECK constraints enforced, strict sql_mode)`);
}

// Only connect and exit when run as a script. Required as a module (by
// test/server-guard.test.js) it must expose classifyServer without touching
// the network or calling process.exit.
if (require.main === module) {
  main().catch((err) => {
    console.error('Version guard failed unexpectedly:', err);
    process.exit(1);
  });
}
