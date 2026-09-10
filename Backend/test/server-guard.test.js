/**
 * =============================================================================
 * Server compatibility guard - unit tests (SPEC-1A B4)
 * =============================================================================
 * No database required.
 *
 *   node --test test/server-guard.test.js
 *
 * WHY THESE EXIST AS UNIT TESTS
 * The MariaDB branch of the guard is very hard to exercise end to end: a
 * MariaDB server frequently cannot be reached through Prisma at all, because
 * the connection fails during the handshake before any version query runs. An
 * end-to-end attempt therefore exits for the wrong reason and proves nothing
 * about the detection logic. Keeping the decision in a pure function and
 * testing it against REAL version strings - captured from actual servers -
 * gives the branch genuine coverage.
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

test('rejects MariaDB by VERSION() string', () => {
  // Captured from a live mariadb:11 container.
  const v = classifyServer('11.8.9-MariaDB-ubu2404', 'mariadb.org binary distribution');
  assert.equal(v.kind, 'mariadb');
});

test('rejects MariaDB by version_comment alone', () => {
  // Some builds report a plausible MySQL version in VERSION() and only reveal
  // themselves in version_comment. Note 10.11.6 would otherwise classify as
  // 'ok', since 10 > 8 - so this check is load-bearing, not belt-and-braces.
  assert.equal(classifyServer('10.11.6', 'mariadb.org binary distribution').kind, 'mariadb');
  assert.equal(classifyServer('10.11.6', 'MariaDB Server').kind, 'mariadb');

  // Confirm the trap it guards against: without the comment, this passes.
  assert.equal(classifyServer('10.11.6', 'MySQL Community Server').kind, 'ok');
});

test('MariaDB detection is case-insensitive', () => {
  for (const c of ['MARIADB', 'mariadb', 'MariaDB']) {
    assert.equal(classifyServer(`11.4.2-${c}`, '').kind, 'mariadb', `${c} should be detected`);
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
test('looksLikeConnectionFailure matches the errors a MariaDB host produces', () => {
  // Both captured from real runs against MariaDB 11.8.9 and an unreachable host.
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
