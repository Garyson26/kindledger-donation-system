#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * Schema drift gate (SPEC-1A B2) - FAILS THE BUILD ON ANY DRIFT
 * =============================================================================
 *   node db/check-drift.js        # exit 0 = no drift, exit 1 = drift
 *
 * ADR-002 documents the hazard that Prisma cannot express CHECK constraints,
 * per-column collation, the table default collation or ON UPDATE
 * CURRENT_TIMESTAMP. A documented hazard is not a control. This is the control.
 *
 * TWO INDEPENDENT COMPARISONS
 *
 *   1. STRUCTURAL - `prisma migrate diff` from the applied database to
 *      prisma/schema.prisma. A non-empty diff means the live schema and the
 *      ORM model disagree about something Prisma CAN see: a table, column,
 *      type, index or foreign key.
 *
 *   2. INVARIANT - direct information_schema assertions for the four things
 *      Prisma CANNOT see. `migrate diff` is blind to these by construction,
 *      so a Prisma-generated migration that dropped every CHECK constraint
 *      would produce an EMPTY structural diff. Comparison 1 alone would pass
 *      it. These are the security-relevant ones.
 *
 * Both must be clean. Run against a database that has had the migrations
 * applied - in CI, a fresh mysql:8.4 service with db/schema.sql loaded.
 * =============================================================================
 */

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCHEMA = path.join(__dirname, '..', 'prisma', 'schema.prisma');

const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

// -----------------------------------------------------------------------------
// 1. Structural diff: applied database -> Prisma datamodel
// -----------------------------------------------------------------------------
function structuralDiff() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('DATABASE_URL is not set, so the structural diff could not run.');
    return;
  }

  // Invoke the Prisma CLI's JS entry point with the current node binary
  // rather than shelling out to `npx`. On Windows, Node 20.12+ refuses to
  // spawnSync a .cmd shim without shell: true (EINVAL), and enabling a shell
  // to interpolate DATABASE_URL - which contains a password - is not worth
  // it. This also skips npx's resolution step entirely.
  let prismaBin;
  try {
    prismaBin = require.resolve('prisma/build/index.js');
  } catch {
    fail('the prisma CLI is not installed; run npm install before the drift gate.');
    return;
  }

  let out;
  try {
    out = execFileSync(
      process.execPath,
      [
        prismaBin,
        'migrate',
        'diff',
        '--from-url',
        url,
        '--to-schema-datamodel',
        SCHEMA,
        '--script',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    fail(`prisma migrate diff failed to run: ${(err.stderr || err.message || '').trim()}`);
    return;
  }

  // Prisma emits a comment line when there is nothing to do.
  const meaningful = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--') && !/^this is an empty migration/i.test(l));

  if (meaningful.length > 0) {
    fail(
      'The applied database and prisma/schema.prisma disagree structurally.\n' +
        '    prisma migrate diff would generate:\n' +
        out
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => `      ${l}`)
          .join('\n')
    );
  } else {
    notes.push('structural diff clean (no table/column/index/FK drift)');
  }
}

// -----------------------------------------------------------------------------
// 2. Invariants Prisma cannot express - the ones that matter
// -----------------------------------------------------------------------------
async function invariants() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const EXPECTED_CHECKS = [
    'ck_categories_amount_positive',
    'ck_donations_quantity_min',
    'ck_donations_amount_positive',
    'ck_branding_settings_singleton',
    'ck_branding_settings_primary_colour',
    'ck_branding_settings_secondary_colour',
  ];

  try {
    // --- 2a. CHECK constraints ---------------------------------------------
    const checks = await prisma.$queryRawUnsafe(
      'SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()'
    );
    const found = new Set(checks.map((c) => c.name));
    const missing = EXPECTED_CHECKS.filter((c) => !found.has(c));
    if (missing.length > 0) {
      fail(
        `${missing.length} CHECK constraint(s) missing: ${missing.join(', ')}\n` +
          '    Without these a category can be priced at zero, a donation can be\n' +
          '    recorded for zero rupees, and branding_settings can hold >1 row.'
      );
    } else {
      notes.push(`all ${EXPECTED_CHECKS.length} CHECK constraints present`);
    }

    // --- 2b. Per-column email collation ------------------------------------
    const emails = await prisma.$queryRawUnsafe(
      "SELECT TABLE_NAME AS t, COLLATION_NAME AS c FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'email' " +
        "AND TABLE_NAME IN ('users','pending_signups')"
    );
    if (emails.length !== 2) {
      fail(`expected an email column on users and pending_signups, found ${emails.length}`);
    }
    for (const e of emails) {
      if (e.c !== 'utf8mb4_0900_as_ci') {
        fail(
          `${e.t}.email collation is ${e.c}, expected utf8mb4_0900_as_ci.\n` +
            '    An accent-INSENSITIVE collation MERGES distinct accounts\n' +
            '    (jose@x.com and the accented form become the same address).'
        );
      }
    }
    if (emails.every((e) => e.c === 'utf8mb4_0900_as_ci')) {
      notes.push('email columns still accent-sensitive, case-insensitive');
    }

    // --- 2c. Table default collation ---------------------------------------
    const tables = await prisma.$queryRawUnsafe(
      "SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
        "AND TABLE_NAME <> '_prisma_migrations'"
    );
    const wrongCollation = tables.filter((t) => t.c !== 'utf8mb4_0900_ai_ci');
    if (wrongCollation.length > 0) {
      fail(
        `${wrongCollation.length} table(s) not on utf8mb4_0900_ai_ci: ` +
          wrongCollation.map((t) => `${t.t}=${t.c}`).join(', ') +
          '\n    utf8mb4_unicode_ci is what Prisma emits, so this is the\n' +
          '    fingerprint of a Prisma-generated migration having been applied.'
      );
    } else {
      notes.push(`all ${tables.length} tables on utf8mb4_0900_ai_ci`);
    }

    // --- 2d. ON UPDATE CURRENT_TIMESTAMP -----------------------------------
    const touched = await prisma.$queryRawUnsafe(
      "SELECT TABLE_NAME AS t, EXTRA AS e FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'updated_at'"
    );
    const notMaintained = touched.filter((c) => !/on update current_timestamp\(3\)/i.test(c.e || ''));
    if (notMaintained.length > 0) {
      fail(
        `${notMaintained.length} updated_at column(s) lack ON UPDATE CURRENT_TIMESTAMP(3): ` +
          notMaintained.map((c) => c.t).join(', ')
      );
    } else {
      notes.push(`all ${touched.length} updated_at columns maintained by the database`);
    }
  } catch (err) {
    fail(`invariant checks could not run: ${err.message}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

// -----------------------------------------------------------------------------
async function main() {
  console.log('\nSchema drift gate');
  console.log('-'.repeat(72));

  structuralDiff();
  await invariants();

  for (const n of notes) console.log(`  ok    ${n}`);

  if (failures.length === 0) {
    console.log('-'.repeat(72));
    console.log('  No drift. db/schema.sql, prisma/schema.prisma and the database agree.\n');
    process.exit(0);
  }

  console.error('-'.repeat(72));
  console.error(`  DRIFT DETECTED - ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}\n`);
  console.error('-'.repeat(72));
  console.error('  db/schema.sql is the source of truth. Correct the database or the');
  console.error('  Prisma schema to match it, and never run `prisma migrate dev`');
  console.error('  (see CONTRIBUTING.md and docs/decisions.md ADR-002).\n');
  process.exit(1);
}

main().catch((err) => {
  console.error('Drift gate failed unexpectedly:', err);
  process.exit(1);
});
