/**
 * =============================================================================
 * Server compatibility guard - unit tests (SPEC-1A B4)
 * =============================================================================
 * No database required.
 *
 *   node --test test/server-guard.test.js
 *
 * WHY THESE EXIST AS UNIT TESTS
 * The decisions are pure functions tested against REAL version strings,
 * captured from actual servers, so every branch is covered without needing one
 * server per branch. The end-to-end half runs in CI: the schema job against
 * mysql:8.4 and mariadb:11.8, and a refusal job against an unsupported server
 * that asserts the install created NOTHING (CY2).
 *
 * CHANGED IN CX1, AND THE CHANGE IS THE POINT. Three tests here asserted that
 * MariaDB is refused by name. MariaDB 11.4.5+ is now supported, so they were
 * replaced, not relaxed: the version rule is per flavour, and the old trap they
 * guarded (10.11.6 passing the MySQL threshold) is still asserted below.
 * =============================================================================
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyServer, parseVersion, MIN_STR } = require('../db/require-mysql-version');

test('the minimum is 8.0.16, where CHECK constraints began to be enforced', () => {
  assert.equal(MIN_STR, '8.0.16');
});

test('accepts the MySQL versions we actually target', () => {
  // 8.4.11 is the string reported by mysql:8.4, verified live.
  for (const v of ['8.4.11', '8.4.0', '8.0.16', '8.0.35', '9.0.1', '8.0.16-log']) {
    assert.equal(classifyServer(v, 'MySQL Community Server - GPL').kind, 'ok', `${v} should be accepted`);
  }
});

test('rejects MySQL below 8.0.16, where CHECK is parsed and ignored', () => {
  for (const v of ['8.0.15', '8.0.0', '5.7.44', '5.6.51', '5.5.62']) {
    assert.equal(classifyServer(v, 'MySQL Community Server - GPL').kind, 'too-old', `${v} should be rejected`);
  }
});

test('accepts MariaDB 11.4.5 and later (CX1)', () => {
  // 11.8.9-MariaDB-ubu2404 is the live mariadb:11.8 string, and the build
  // Hostinger's shared hosting reports.
  for (const v of ['11.8.9-MariaDB-ubu2404', '11.8.9-MariaDB-log', '11.4.5-MariaDB', '12.0.2-MariaDB']) {
    const r = classifyServer(v, 'mariadb.org binary distribution');
    assert.equal(r.flavour, 'mariadb');
    assert.equal(r.kind, 'ok', `${v} should be accepted`);
  }
});

test('rejects MariaDB below 11.4.5, which has no utf8mb4_0900_* collations', () => {
  for (const v of ['11.4.4-MariaDB', '11.4.0-MariaDB', '10.11.6-MariaDB', '10.6.20-MariaDB', '10.2.1-MariaDB']) {
    assert.equal(classifyServer(v, '').kind, 'too-old', `${v} should be rejected`);
  }
});

test('MariaDB by version_comment alone still selects the MariaDB threshold', () => {
  // Some builds report a plausible MySQL version in VERSION() and only reveal
  // themselves in version_comment. 10.11.6 clears MySQL's 8.0.16, since 10 > 8,
  // while lacking every 0900 collation - so reading the flavour is
  // load-bearing, not belt-and-braces.
  assert.equal(classifyServer('10.11.6', 'mariadb.org binary distribution').kind, 'too-old');
  assert.equal(classifyServer('10.11.6', 'MariaDB Server').kind, 'too-old');

  // The trap: without the comment, the MySQL rule passes it.
  assert.equal(classifyServer('10.11.6', 'MySQL Community Server').kind, 'ok');
});

test('MariaDB detection is case-insensitive', () => {
  for (const c of ['MARIADB', 'mariadb', 'MariaDB']) {
    assert.equal(classifyServer(`11.4.2-${c}`, '').flavour, 'mariadb', `${c} should be detected`);
  }
});

test('refuses an unparseable version rather than guessing', () => {
  for (const v of ['', null, undefined, 'unknown', '8', '8.4', 'v8.4.11']) {
    assert.equal(classifyServer(v, '').kind, 'unparseable', `${JSON.stringify(v)} should be unparseable`);
  }
});

test('parseVersion reads the leading x.y.z and ignores any suffix', () => {
  assert.deepEqual(parseVersion('8.4.11-1.el9'), { major: 8, minor: 4, patch: 11 });
  assert.deepEqual(parseVersion('  8.0.16  '), { major: 8, minor: 0, patch: 16 });
  assert.equal(parseVersion('8.4'), null);
});

// =============================================================================
// C3 - strict SQL mode classifier
// =============================================================================
const { hasStrictMode, looksLikeConnectionFailure } = require('../db/require-mysql-version');

test('hasStrictMode accepts the MySQL 8 default sql_mode', () => {
  // Captured from mysql:8.4.11.
  assert.equal(
    hasStrictMode(
      'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
    ),
    true
  );
});

test('hasStrictMode accepts STRICT_ALL_TABLES and TRADITIONAL', () => {
  assert.equal(hasStrictMode('STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'), true);
  assert.equal(hasStrictMode('TRADITIONAL'), true);
  // Order and whitespace must not matter.
  assert.equal(hasStrictMode(' NO_ENGINE_SUBSTITUTION , strict_trans_tables '), true);
});

test('hasStrictMode rejects a non-strict sql_mode', () => {
  // Empty is the case that silently stores an out-of-set ENUM as ''.
  for (const m of ['', null, undefined, 'NO_ENGINE_SUBSTITUTION', 'ONLY_FULL_GROUP_BY,NO_ZERO_DATE', 'ANSI']) {
    assert.equal(hasStrictMode(m), false, `${JSON.stringify(m)} should not be considered strict`);
  }
});

test('hasStrictMode is not fooled by a substring', () => {
  // A mode merely containing the text must not count; only a real list member.
  assert.equal(hasStrictMode('NOT_STRICT_TRANS_TABLES_X'), false);
});

// =============================================================================
// C5 - connection-failure classifier
// =============================================================================
test('looksLikeConnectionFailure matches connection and credential failures', () => {
  // Captured from real runs against MariaDB 11.8.9 and an unreachable host.
  for (const m of [
    'Authentication failed against database server, the provided database credentials for `root` are not valid.',
    "Can't reach database server at `127.0.0.1:3306`",
    'ERROR 1045 (28000): Access denied for user',
    'connect ECONNREFUSED 127.0.0.1:3306',
    'Timed out during handshake',
  ]) {
    assert.equal(looksLikeConnectionFailure(m), true, `should match: ${m}`);
  }
});

test('looksLikeConnectionFailure does not match an ordinary query error', () => {
  for (const m of ['Unknown column x in field list', 'Table kindledger.foo does not exist', '']) {
    assert.equal(looksLikeConnectionFailure(m), false, `should not match: ${m}`);
  }
});

// =============================================================================
// CX1 - the inspection both gates share: version, strict mode, and collation
// BEHAVIOUR, through an injected query function
// =============================================================================
const { inspectServer, evaluateCollationProbe, COLLATION_EXPECTATIONS } = require('../db/require-mysql-version');

const STRICT_MARIA = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
const goodProbe = () => Object.fromEntries(COLLATION_EXPECTATIONS.map(([, , want], i) => [`c${i}`, want]));

function fakeServer({
  version = '11.8.9-MariaDB-ubu2404',
  comment = 'mariadb.org binary distribution',
  session = STRICT_MARIA,
  global = STRICT_MARIA,
  collations = 2,
  probe = goodProbe(),
} = {}) {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT VERSION()')) {
      return [{ version, comment, session_mode: session, global_mode: global, collations }];
    }
    return [probe];
  };
  return { query, calls };
}

test('inspectServer: MariaDB 11.8 with stock settings is supported', async () => {
  const r = await inspectServer(fakeServer().query);
  assert.deepEqual(r.problems, []);
  assert.equal(r.supported, true);
  assert.equal(r.server, 'MariaDB 11.8.9-MariaDB-ubu2404');
});

test('inspectServer: MySQL 8.4 with its default sql_mode is supported', async () => {
  const mode =
    'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
  const r = await inspectServer(
    fakeServer({ version: '8.4.13', comment: 'MySQL Community Server - GPL', session: mode, global: mode }).query
  );
  assert.equal(r.supported, true);
});

test('inspectServer: a non-strict GLOBAL sql_mode refuses even when the session is strict', async () => {
  const r = await inspectServer(fakeServer({ global: 'NO_ENGINE_SUBSTITUTION' }).query);
  assert.equal(r.supported, false);
  assert.match(r.problems.join('\n'), /GLOBAL sql_mode is not strict/);
});

test('inspectServer: missing 0900 collations refuse, and the behaviour probe is not run', async () => {
  // COLLATE utf8mb4_0900_as_ci on a server without it is a query ERROR, which
  // would read as "unreachable" rather than "unsupported" and let it through.
  const { query, calls } = fakeServer({ version: '11.4.4-MariaDB', collations: 0 });
  const r = await inspectServer(query);
  assert.equal(r.supported, false);
  assert.equal(calls.length, 1, 'the collation probe must not run when the collations are absent');
  assert.match(r.problems.join('\n'), /not both available/);
});

test('inspectServer: an accent-INSENSITIVE email collation refuses (jose@ would merge with its accented twin)', async () => {
  const probe = goodProbe();
  const i = COLLATION_EXPECTATIONS.findIndex(([label]) => label === 'as_ci keeps accents');
  probe[`c${i}`] = 1;
  const r = await inspectServer(fakeServer({ probe }).query);
  assert.equal(r.supported, false);
  assert.deepEqual(r.problems, ['collation behaviour wrong: as_ci keeps accents']);
});

test('evaluateCollationProbe reads BigInt, which is what Prisma returns from $queryRawUnsafe', () => {
  const row = Object.fromEntries(COLLATION_EXPECTATIONS.map(([, , want], i) => [`c${i}`, BigInt(want)]));
  assert.deepEqual(evaluateCollationProbe(row), []);
});

// =============================================================================
// CX1(b) - the application-start gate
// =============================================================================
const serverGuard = require('../config/serverGuard');

/** Run the middleware once, against whatever query resetServerVerdict() installed. */
function runGate() {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(body) {
        resolve({ next: false, status: this.statusCode, body });
      },
    };
    serverGuard.requireSupportedServer({}, res, () => resolve({ next: true }));
  });
}

test('gate: an unsupported server answers 503, generically, and the verdict is cached', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { query, calls } = fakeServer({ version: '10.11.6-MariaDB', collations: 0 });
  serverGuard.resetServerVerdict(query);
  const first = await runGate();
  assert.equal(first.status, 503);
  assert.deepEqual(first.body, { error: 'Service unavailable' }, 'which server and why belongs in the log');
  await runGate();
  assert.equal(calls.length, 1, 'a definitive refusal is not re-asked on every request');
  serverGuard.resetServerVerdict();
});

test('gate: an unreachable database is NOT a refusal, and is asked again next time', async () => {
  let asked = 0;
  const down = async () => {
    asked++;
    throw new Error("Can't reach database server");
  };
  serverGuard.resetServerVerdict(down);
  assert.deepEqual(await runGate(), { next: true });
  assert.deepEqual(await runGate(), { next: true });
  assert.equal(asked, 2);
  serverGuard.resetServerVerdict();
});

test('gate: a supported server passes through', async (t) => {
  t.mock.method(console, 'log', () => {});
  serverGuard.resetServerVerdict(fakeServer().query);
  assert.deepEqual(await runGate(), { next: true });
  serverGuard.resetServerVerdict();
});

// =============================================================================
// CX1 - connection budget: the URL parameters the pool is built from
// =============================================================================
const { buildDatabaseUrl } = require('../config/prisma');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('buildDatabaseUrl appends connection_limit and, when set, max_idle_connection_lifetime', () => {
  const url = withEnv(
    {
      DATABASE_URL: 'mysql://u:p@h:3306/d?sslaccept=strict',
      PRISMA_CONNECTION_LIMIT: '1',
      PRISMA_MAX_IDLE_CONNECTION_LIFETIME: '50',
    },
    buildDatabaseUrl
  );
  assert.equal(url, 'mysql://u:p@h:3306/d?sslaccept=strict&connection_limit=1&max_idle_connection_lifetime=50');
});

test('buildDatabaseUrl leaves the idle lifetime to Prisma when unset, and never overrides the URL', () => {
  const unset = { PRISMA_CONNECTION_LIMIT: undefined, PRISMA_MAX_IDLE_CONNECTION_LIFETIME: undefined };
  assert.equal(
    withEnv({ DATABASE_URL: 'mysql://u:p@h/d', ...unset }, buildDatabaseUrl),
    'mysql://u:p@h/d?connection_limit=10'
  );
  assert.equal(
    withEnv(
      {
        DATABASE_URL: 'mysql://u:p@h/d?connection_limit=3&max_idle_connection_lifetime=9',
        PRISMA_CONNECTION_LIMIT: '1',
        PRISMA_MAX_IDLE_CONNECTION_LIFETIME: '50',
      },
      buildDatabaseUrl
    ),
    'mysql://u:p@h/d?connection_limit=3&max_idle_connection_lifetime=9'
  );
});
