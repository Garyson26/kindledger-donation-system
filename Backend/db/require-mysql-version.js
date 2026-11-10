#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * Server compatibility guard (SPEC-1A B4, CX1)
 * =============================================================================
 * Refuses to proceed unless the server provides every FEATURE the schema
 * depends on. MySQL 8.0.16+ and MariaDB 11.4.5+ both do.
 *
 *   node db/require-mysql-version.js          # exits non-zero if unsupported
 *
 * Wired into `npm run db:migrate` and `npm run db:seed` so an unsupported
 * server fails loudly before anything is written, and - since CX1 - run by the
 * application itself on its first request (config/serverGuard.js), so a deploy
 * pointed at an unsupported server answers 503 instead of quietly working.
 *
 * -----------------------------------------------------------------------------
 * THE REQUIREMENT, PER FEATURE (CX1). Verified against mysql:8.4 and
 * mariadb:11.8.9, the build Hostinger's shared hosting runs.
 * -----------------------------------------------------------------------------
 *
 *   Feature                      MySQL       MariaDB     Checked by
 *   ---------------------------  ----------  ----------  ---------------------
 *   CHECK constraints ENFORCED   8.0.16      10.2.1      version + live probe
 *   utf8mb4_0900_as_ci / _ai_ci  8.0.1       11.4.5      behaviour probe
 *   REGEXP in a CHECK            8.0.16      10.2.1      (the schema uses the
 *                                                         operator, not
 *                                                         REGEXP_LIKE(), which
 *                                                         MariaDB lacks)
 *   strict sql_mode, SESSION     the app     the app     @@SESSION (config/prisma
 *                                                         sets it on connect: DB1)
 *   strict sql_mode, GLOBAL      server      server      WARNING only (DB1)
 *   TLS to a non-private host    the URL     the URL     Ssl_cipher (DB4)
 *
 *   MySQL < 8.0.16 - CHECK constraint syntax PARSES AND IS THEN SILENTLY
 *   IGNORED. The schema would apply without a single error and without any of
 *   its guarantees: a category could be priced at zero, a donation could be
 *   for zero rupees, branding_settings could hold rows for id 2, 3, 4.
 *
 *   MariaDB < 11.4.5 - has no utf8mb4_0900_* collations. 11.4.5 added them as
 *   aliases (MDEV-20912): utf8mb4_0900_as_ci -> utf8mb4_uca1400_nopad_as_ci,
 *   utf8mb4_0900_ai_ci -> utf8mb4_uca1400_nopad_ai_ci.
 *
 * THIS COMMENT USED TO SAY "MariaDB has no utf8mb4_0900_* collations at all".
 * That was true when it was written and stopped being true in 11.4.5. The old
 * rule refused MariaDB BY NAME, which was right for the wrong reason - and a
 * name check cannot tell an 11.4.4 that lacks the collations from an 11.8 that
 * has them. The guard now asks the server what it DOES, not what it is called:
 * the collation probe compares strings and checks the answers, so a server
 * whose alias someday maps to something accent-insensitive fails here rather
 * than merging jose@ and its e-with-acute variant into one account.
 *
 * WHAT THE ALIASES DO, MEASURED (CX1(c)): 22 address pairs - case, precomposed
 * and combining accents, eszett, ligatures, fullwidth, dotless i, zero-width
 * characters, trailing space, emoji, a Cyrillic homoglyph - compared under both
 * collations and through a unique index on both servers. Every result was
 * identical. The one known difference is the UCA version underneath (14.0 on
 * MariaDB, 9.0 on MySQL); the pairs tested are Latin-script.
 *
 * KNOWN DIFFERENCES THAT ARE ACCEPTED, recorded so nobody rediscovers them:
 *   - CHECK violation errno: 3819 on MySQL, 4025 on MariaDB. Nothing reads it.
 *   - MariaDB's default sql_mode has no NO_ZERO_DATE / NO_ZERO_IN_DATE, so a
 *     hand-written '0000-00-00' is stored. Prisma cannot produce one (CY1).
 *   - Fractional seconds beyond the column's precision: MySQL rounds, MariaDB
 *     truncates. Only milliseconds are ever written.
 *
 * Once this repository is public, NGOs will run it against whatever their host
 * provides. A clear refusal at install time is far kinder than either failure.
 * =============================================================================
 */

'use strict';

const MIN = { major: 8, minor: 0, patch: 16 };
const MIN_STR = `${MIN.major}.${MIN.minor}.${MIN.patch}`;
const MARIADB_MIN = { major: 11, minor: 4, patch: 5 };
const MARIADB_MIN_STR = `${MARIADB_MIN.major}.${MARIADB_MIN.minor}.${MARIADB_MIN.patch}`;

const REQUIREMENT =
  `KindLedger requires MySQL ${MIN_STR}+ or MariaDB ${MARIADB_MIN_STR}+, a strict sql_mode on its own connections, and TLS to any non-private host.`;

/** Parses the leading x.y.z out of a MySQL version string. */
function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function isAtLeast(v, min) {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** Kept for its existing callers; the MySQL threshold. */
function isAtLeastMinimum(v) {
  return isAtLeast(v, MIN);
}

/**
 * Pure classifier, exported so it can be unit tested without a live server.
 *
 * The FLAVOUR decides which threshold applies, so it has to be read correctly:
 * MariaDB 10.11 is numerically above MySQL's 8.0.16 and would pass the MySQL
 * rule while lacking every 0900 collation. MariaDB is usually obvious from
 * VERSION() ("11.8.9-MariaDB-ubu2404"); version_comment is checked too, since
 * some builds report only there ("mariadb.org binary distribution").
 *
 * The version is necessary, not sufficient: inspectServer() still probes
 * behaviour, because a version number is a claim about features, not a test.
 *
 * @returns {{kind: 'ok'|'too-old'|'unparseable', flavour: 'mysql'|'mariadb', version: string, minimum: string}}
 */
function classifyServer(version, comment) {
  const haystack = `${version || ''} ${comment || ''}`.toLowerCase();
  const flavour = haystack.includes('mariadb') ? 'mariadb' : 'mysql';
  const [min, minimum] = flavour === 'mariadb' ? [MARIADB_MIN, MARIADB_MIN_STR] : [MIN, MIN_STR];

  const v = parseVersion(version);
  if (!v) return { kind: 'unparseable', flavour, version: String(version), minimum };
  if (!isAtLeast(v, min)) return { kind: 'too-old', flavour, version: String(version), minimum };
  return { kind: 'ok', flavour, version: String(version), minimum };
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
 * MEASURED AGAIN ON MARIADB 11.8 (CY3), through the application's own write
 * path. Prisma's typed API refuses an out-of-set enum BEFORE sending SQL, so
 * the app and the ETL cannot reach that branch. What a non-strict server does
 * to them instead is silent: a 200-character donor name stored as 120, PayU's
 * error text cut at 1000, a quantity of 5e9 clipped to 4294967295. And a
 * hand-written INSERT - phpMyAdmin, a script - still gets BUG-02 exactly.
 *
 * STRICT_TRANS_TABLES is the MySQL 8 and MariaDB default, but sql_mode is
 * settable and managed providers ship their own defaults, so it must be checked
 * rather than assumed.
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
 * C5 wrote this for MariaDB, on the belief that its handshake fails before any
 * query runs. Prisma 6.19 connects to mariadb:11.8.9 without trouble (CX1), so
 * the MariaDB reading is withdrawn. The classifier stays: an unreachable host
 * or a wrong password still deserves a message that says so.
 */
function looksLikeConnectionFailure(message) {
  return /authentication failed|access denied|can't reach|cannot reach|connection refused|econnrefused|handshake|server has gone away|protocol|timed out|etimedout/i.test(
    String(message || '')
  );
}

/**
 * Is this host on a network where plaintext and RSA key retrieval are tolerable?
 * Loopback, RFC 1918, IPv6 loopback and unique-local, and SINGLE-LABEL names
 * (`db`, `mysql`: a compose or CI service). Anything with a dot is treated as
 * public, even if it happens to resolve privately - fail closed, because the
 * cost of a wrong "private" is a database password on the open internet.
 */
function isPrivateHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !h.includes('.') && !h.includes(':');
}

// -----------------------------------------------------------------------------
// Inspection - SELECTs only, so the application can run it on every cold start
// -----------------------------------------------------------------------------

const METADATA_SQL =
  // version_comment names the distribution; MariaDB reports itself there even
  // when @@version has been made to look like MySQL.
  'SELECT VERSION() AS version, @@version_comment AS comment, ' +
  '@@SESSION.sql_mode AS session_mode, @@GLOBAL.sql_mode AS global_mode, ' +
  "(SELECT COUNT(*) FROM information_schema.COLLATIONS WHERE COLLATION_NAME IN ('utf8mb4_0900_as_ci', 'utf8mb4_0900_ai_ci')) AS collations";

// Hex literals, so no client, driver or console between here and the server
// can re-encode the accented characters and turn the probe into a no-op.
const hex = (s) => `CONVERT(X'${Buffer.from(s, 'utf8').toString('hex')}' USING utf8mb4)`;
const eq = (a, b, coll) => `(${hex(a)} COLLATE ${coll} = ${hex(b)} COLLATE ${coll})`;

/**
 * What the email uniqueness rule needs, asked as questions with known answers.
 * users.email and pending_signups.email are utf8mb4_0900_as_ci; every table's
 * default is utf8mb4_0900_ai_ci.
 */
const COLLATION_EXPECTATIONS = [
  ['as_ci folds case', eq('JOSE@X.COM', 'jose@x.com', 'utf8mb4_0900_as_ci'), 1],
  ['as_ci keeps accents', eq('jos\u00e9@x.com', 'jose@x.com', 'utf8mb4_0900_as_ci'), 0],
  ['as_ci treats a combining accent as the precomposed one', eq('jos\u00e9@x.com', 'jose\u0301@x.com', 'utf8mb4_0900_as_ci'), 1],
  ['as_ci keeps a trailing space (NO PAD)', eq('jose@x.com ', 'jose@x.com', 'utf8mb4_0900_as_ci'), 0],
  ['ai_ci folds case', eq('JOSE', 'jose', 'utf8mb4_0900_ai_ci'), 1],
  ['ai_ci folds accents', eq('jos\u00e9', 'jose', 'utf8mb4_0900_ai_ci'), 1],
];

const COLLATION_SQL =
  'SELECT ' + COLLATION_EXPECTATIONS.map(([, expr], i) => `${expr} AS c${i}`).join(', ');

/** Which expectations a probe row fails. Pure. */
function evaluateCollationProbe(row) {
  return COLLATION_EXPECTATIONS.filter(([, , want], i) => Number(row[`c${i}`]) !== want).map(([label]) => label);
}

/**
 * Inspect the server through `query(sql) => Promise<rows>`, on the connection
 * the APPLICATION uses - so SESSION means the app's own session. Three round
 * trips. Throws only if the server cannot be queried at all; every other
 * outcome is a verdict.
 *
 * `host` is the DATABASE_URL host; without it the TLS rule is not applied.
 *
 * @returns {Promise<{supported: boolean, server: string, problems: string[], warnings: string[]}>}
 */
async function inspectServer(query, { host } = {}) {
  const meta = (await query(METADATA_SQL))[0];
  const verdict = classifyServer(meta.version, meta.comment);
  const server = `${verdict.flavour === 'mariadb' ? 'MariaDB' : 'MySQL'} ${verdict.version}`;
  const problems = [];
  const warnings = [];

  if (verdict.kind === 'unparseable') {
    problems.push(`unrecognised version string "${verdict.version}"; cannot confirm CHECK support, so refusing rather than guessing`);
  } else if (verdict.kind === 'too-old') {
    problems.push(
      verdict.flavour === 'mariadb'
        ? `MariaDB below ${verdict.minimum} has no utf8mb4_0900_* collations`
        : `MySQL below ${verdict.minimum} parses CHECK constraints and silently ignores them`
    );
  }

  // SESSION is the application's own connection, made strict by config/prisma
  // on connect. If it is not strict, that mechanism failed, and every write the
  // application makes is exposed: refuse.
  if (!hasStrictMode(meta.session_mode)) {
    problems.push(`SESSION sql_mode is not strict ("${meta.session_mode || ''}")`);
  }
  // GLOBAL is everyone else's. On shared hosting nobody but the provider can
  // change it, and since DB1 it governs only out-of-band SQL (DB3), so it is a
  // warning that names what is unenforced, not a refusal.
  if (!hasStrictMode(meta.global_mode)) {
    warnings.push(
      `GLOBAL sql_mode is not strict ("${meta.global_mode || ''}"). The application's own connections are strict; ` +
        'anything else is NOT - phpMyAdmin, a hand-run SQL session, any script with its own client. There, an ' +
        "out-of-set ENUM is stored as '' (a donation in no report), long text is cut and numbers are clipped."
    );
  }

  // DB4. have_ssl=YES and require_secure_transport=0 on Hostinger: TLS works and
  // nothing on the server enforces it. So the application does.
  if (host !== undefined && !isPrivateHost(host)) {
    const cipher = ((await query("SHOW SESSION STATUS LIKE 'Ssl_cipher'"))[0] || {}).Value;
    if (!cipher) {
      problems.push(
        `the connection to ${host} is NOT ENCRYPTED. Add ?sslaccept=strict to DATABASE_URL ` +
          '(or accept_invalid_certs if the certificate cannot be verified). Without it the password and every donor row cross the network readable'
      );
    }
  }

  if (Number(meta.collations) !== 2) {
    problems.push('utf8mb4_0900_as_ci and utf8mb4_0900_ai_ci are not both available');
  } else {
    for (const failed of evaluateCollationProbe((await query(COLLATION_SQL))[0])) {
      problems.push(`collation behaviour wrong: ${failed}`);
    }
  }

  return { supported: problems.length === 0, server, problems, warnings };
}

module.exports = {
  classifyServer,
  parseVersion,
  isAtLeastMinimum,
  hasStrictMode,
  looksLikeConnectionFailure,
  inspectServer,
  isPrivateHost,
  evaluateCollationProbe,
  COLLATION_EXPECTATIONS,
  MIN_STR,
  MARIADB_MIN_STR,
  REQUIREMENT,
};

// -----------------------------------------------------------------------------
// CLI - the install-time gate in front of `prisma migrate deploy`
// -----------------------------------------------------------------------------

function fail(detail, remedy) {
  console.error('\n' + '='.repeat(72));
  console.error('  UNSUPPORTED DATABASE SERVER');
  console.error('='.repeat(72));
  console.error(`  ${REQUIREMENT}`);
  console.error('');
  for (const line of [].concat(detail)) console.error(`  Detected: ${line}`);
  if (remedy) {
    console.error('');
    for (const line of remedy) console.error(`  ${line}`);
  }
  console.error('='.repeat(72) + '\n');
  process.exit(1);
}

/**
 * WHY THIS MUST RUN BEFORE THE MIGRATION, AND NOT MERELY BEFORE THE APP (CY2).
 *
 * DDL in MySQL and MariaDB commits implicitly, statement by statement. A
 * migration that fails at statement ten leaves statements one to nine applied
 * and a failed row in _prisma_migrations. On MariaDB 11.8 the unmodified init
 * migration did exactly that: six tables created, branding_settings refused,
 * and a schema that looked nearly right. Nothing can roll that back, so the only
 * defence is to refuse BEFORE the first statement. Every check here is a
 * reason the migration could stop partway; none of them writes anything except
 * the CHECK probe's throwaway table, which it drops.
 */
async function main() {
  // The APPLICATION's client, not a bare PrismaClient: SESSION sql_mode is only
  // meaningful on the connection the application writes through (DB1).
  const { getPrisma, buildPoolConfig } = require('../config/prisma');
  const prisma = getPrisma();
  const host = (buildPoolConfig() || {}).host;

  let result;
  try {
    result = await inspectServer((sql) => prisma.$queryRawUnsafe(sql), { host });
  } catch (err) {
    await prisma.$disconnect().catch(() => {});
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
        'The usual causes are:',
        '  - DATABASE_URL host, port, user or password is wrong',
        '  - the database is not running, or not reachable from here',
        '  - a password containing reserved characters is not percent-encoded',
        '  - on shared hosting: this machine is not in the Remote MySQL allow list',
        '',
        'The bundled docker-compose.yml provides a correct mysql:8.4:',
        '    docker compose up -d db',
      ]);
      return;
    }
    fail(`could not query the server (${err.message})`, ['Check DATABASE_URL and that the database is reachable.']);
    return;
  }

  if (!result.supported) {
    await prisma.$disconnect().catch(() => {});
    fail(result.problems.map((p) => `${result.server}: ${p}`), [
      'WHY EACH OF THESE STOPS THE INSTALL:',
      '  - CHECK constraints: below MySQL 8.0.16 they parse and are ignored, so',
      '    a donation of zero rupees or a second branding row is accepted.',
      '  - 0900 collations: the email uniqueness rule depends on',
      '    utf8mb4_0900_as_ci being case-insensitive and accent-SENSITIVE. Any',
      '    other behaviour merges distinct donor accounts or permits duplicates.',
      '  - strict sql_mode on the SESSION: config/prisma.js sets it on every',
      '    connection. If it did not take, every write is exposed.',
      '  - TLS: a non-private host without ?sslaccept= is reached in plaintext.',
      '',
      'Use MySQL 8.4 LTS (the bundled docker-compose.yml) or MariaDB 11.4.5+.',
    ]);
  }

  // Positive confirmation that CHECKs are actually enforced, not merely
  // supported by version number. Cheap, and catches an exotic build. This is
  // the one DDL step, and why it lives here rather than in the app-start check.
  //
  // INSERT IGNORE, AND COUNT (DM2(c)). The probe used to INSERT the violating
  // row and treat the thrown error as success - correct, but the shared Prisma
  // client logs every query error, so a SUPPORTED server printed
  // `prisma:error ... ck_probe` above "Database server OK", and on the first
  // real install that read as a failure. With IGNORE, MySQL 8.4 and MariaDB
  // 11.8 both skip a CHECK-violating row with a warning instead of an error,
  // strict session or not (measured on both): zero rows means enforced, one
  // means the server accepted the violation. Nothing is thrown, so nothing is
  // logged, and the CI guard step asserts there is no prisma:error.
  let checkConfirmed = false;
  try {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _kl_check_probe');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE _kl_check_probe (n INT, CONSTRAINT ck_probe CHECK (n > 0)) ENGINE=InnoDB'
    );
    await prisma.$executeRawUnsafe('INSERT IGNORE INTO _kl_check_probe (n) VALUES (0)');
    // `rows_kept`, not `stored`: STORED is a reserved word in MySQL 8.
    const [{ rows_kept: rowsKept }] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS rows_kept FROM _kl_check_probe'
    );
    const enforced = Number(rowsKept) === 0;
    checkConfirmed = enforced;
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _kl_check_probe');

    if (!enforced) {
      await prisma.$disconnect().catch(() => {});
      fail(`${result.server}, which accepted a CHECK violation`, [
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
    await prisma.$disconnect().catch(() => {});
  }

  for (const w of result.warnings) console.warn(`  WARNING: ${w}`);
  // Claim CHECK enforcement only when the probe CONFIRMED it. A probe that
  // could not run does not block (above), but the OK line used to say
  // "CHECK constraints enforced" straight after saying it could not check.
  const checks = checkConfirmed
    ? 'CHECK constraints enforced'
    : 'CHECK enforcement NOT confirmed - the probe could not run, see the note above';
  console.log(`  Database server OK: ${result.server} (${checks}, strict session, 0900 collations behave)`);
}

// Only connect and exit when run as a script. Required as a module (by
// test/server-guard.test.js and config/serverGuard.js) it must expose the
// classifiers without touching the network or calling process.exit.
if (require.main === module) {
  main().catch((err) => {
    console.error('Version guard failed unexpectedly:', err);
    process.exit(1);
  });
}
