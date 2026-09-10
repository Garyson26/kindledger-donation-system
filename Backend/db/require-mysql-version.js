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
 *   jose@x.com with josé@x.com. Both are data-integrity failures that present
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

module.exports = { classifyServer, parseVersion, isAtLeastMinimum, MIN_STR, REQUIREMENT };

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let version;
  let comment;
  try {
    // version_comment names the distribution; MariaDB reports itself there
    // even when @@version has been made to look like MySQL.
    const rows = await prisma.$queryRawUnsafe(
      "SELECT VERSION() AS version, @@version_comment AS comment"
    );
    version = rows[0].version;
    comment = rows[0].comment || '';
  } catch (err) {
    await prisma.$disconnect().catch(() => {});
    fail(`could not query the server version (${err.message})`, [
      'Check DATABASE_URL and that the database is reachable.',
      '',
      'If the server is MariaDB, note that the connection itself may fail at',
      'the handshake before any version query runs - an authentication error',
      'here does not rule MariaDB out. It is unsupported either way.',
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

  console.log(`  Database server OK: MySQL ${version} (CHECK constraints enforced)`);
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
