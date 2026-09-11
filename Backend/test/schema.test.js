/**
 * =============================================================================
 * KindLedger - schema conformance tests
 * =============================================================================
 * NOT a unit test of application code. This asserts that the database actually
 * carries the constraints db/schema.sql declares, because several of them are
 * security controls expressed as schema and a later migration silently
 * dropping one is exactly the regression worth catching (SPEC-1A deliverable 9).
 *
 *   Requires: a MySQL 8.4 instance with the schema applied, reachable at
 *             DATABASE_URL.
 *
 *   docker compose up -d db
 *   DATABASE_URL='mysql://kindledger:pass@127.0.0.1:3306/kindledger' \
 *     node --test test/schema.test.js
 *
 * Note that reaching the database from the host needs the commented-out port
 * mapping in docker-compose.yml, or run this from inside the compose network.
 *
 * The destructive assertions all run inside a transaction that is
 * unconditionally rolled back, so the tests leave no rows behind and are safe
 * to run against a seeded demo database.
 * =============================================================================
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

test.after(async () => {
  await prisma.$disconnect();
});

/** information_schema returns COUNT as BigInt through Prisma. */
const num = (v) => Number(v);

/**
 * Runs `fn` inside a transaction that always rolls back, so assertions may
 * insert freely. The sentinel is thrown to abort; any other error propagates.
 */
const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Asserts a statement is rejected by the database. */
async function expectRejected(tx, sql, what) {
  let rejected = false;
  try {
    await tx.$executeRawUnsafe(sql);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, `${what} should have been rejected by the database but was accepted`);
}

// =============================================================================
// Storage conventions
// =============================================================================
test('every table is InnoDB with DYNAMIC row format', async () => {
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, ENGINE, ROW_FORMAT
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'
  `;

  assert.ok(rows.length >= 7, `expected at least 7 application tables, found ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.ENGINE, 'InnoDB', `${r.TABLE_NAME} is not InnoDB`);
    assert.equal(r.ROW_FORMAT, 'Dynamic', `${r.TABLE_NAME} is not DYNAMIC`);
  }
});

test('no TIMESTAMP columns exist anywhere', async () => {
  // DATETIME(3) is mandated over TIMESTAMP because TIMESTAMP has a 2038 range
  // limit and performs implicit session-timezone conversion.
  const [{ n }] = await prisma.$queryRaw`
    SELECT COUNT(*) AS n
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'timestamp'
      AND TABLE_NAME <> '_prisma_migrations'
  `;
  assert.equal(num(n), 0, 'found TIMESTAMP columns; the convention is DATETIME(3)');
});

test('all datetime columns have millisecond precision', async () => {
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, COLUMN_NAME, DATETIME_PRECISION
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'datetime'
      AND TABLE_NAME <> '_prisma_migrations'
  `;
  assert.ok(rows.length > 0, 'no datetime columns found at all');
  for (const r of rows) {
    assert.equal(num(r.DATETIME_PRECISION), 3, `${r.TABLE_NAME}.${r.COLUMN_NAME} is not DATETIME(3)`);
  }
});

test('no approximate or decimal numeric types are used for money', async () => {
  // Money is integer minor units in BIGINT UNSIGNED. DECIMAL is exact in the
  // database but the mysql2 driver surfaces it as a string or a lossy Number,
  // and the application then compares currency in a language with no decimal
  // type. See SPEC-1A section 4.2.
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND DATA_TYPE IN ('float', 'double', 'decimal', 'newdecimal')
      AND TABLE_NAME <> '_prisma_migrations'
  `;
  assert.deepEqual(
    rows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}:${r.DATA_TYPE}`),
    [],
    'found float/double/decimal columns; money must be integer minor units'
  );
});

test('every _minor column is BIGINT UNSIGNED', async () => {
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME LIKE '%\\_minor'
  `;
  assert.ok(rows.length >= 5, `expected at least 5 _minor columns, found ${rows.length}`);
  for (const r of rows) {
    assert.match(
      r.COLUMN_TYPE,
      /^bigint unsigned$/i,
      `${r.TABLE_NAME}.${r.COLUMN_NAME} is ${r.COLUMN_TYPE}, expected bigint unsigned`
    );
  }
});

// =============================================================================
// Collation - the case-insensitive email uniqueness control
// =============================================================================
test('email columns are accent-sensitive, case-insensitive', async () => {
  // This collation is what makes the unique index itself prevent the
  // duplicate-account gap where Alice@x.com and alice@x.com are two users.
  // Prisma cannot express per-column collation, so `migrate dev` would reset
  // these to the table default - which is precisely why this test exists.
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, COLLATION_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'email'
      AND TABLE_NAME IN ('users', 'pending_signups')
  `;

  assert.equal(rows.length, 2, 'expected email columns on users and pending_signups');
  for (const r of rows) {
    assert.equal(
      r.COLLATION_NAME,
      'utf8mb4_0900_as_ci',
      `${r.TABLE_NAME}.email is ${r.COLLATION_NAME}; expected utf8mb4_0900_as_ci ` +
        '(accent-sensitive, case-insensitive)'
    );
  }
});

test('every table uses the utf8mb4_0900_ai_ci default collation', async () => {
  // Prisma's derived DDL emits utf8mb4_unicode_ci (UCA 5.2.0), not
  // utf8mb4_0900_ai_ci (UCA 9.0.0). Confirmed by `prisma migrate diff`. If a
  // Prisma-generated migration is ever applied, this test is what catches it.
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, TABLE_COLLATION
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'
  `;

  for (const r of rows) {
    assert.equal(
      r.TABLE_COLLATION,
      'utf8mb4_0900_ai_ci',
      `${r.TABLE_NAME} is ${r.TABLE_COLLATION}; expected utf8mb4_0900_ai_ci. ` +
        'utf8mb4_unicode_ci means a Prisma-generated migration was applied.'
    );
  }
});

test('updated_at is maintained by the database, not only the client', async () => {
  // Prisma's @updatedAt is client-side, so its derived DDL omits ON UPDATE
  // CURRENT_TIMESTAMP. The DDL keeps it so raw SQL and ETL corrections also
  // bump the timestamp. Asserted here so nobody "fixes" the drift.
  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, EXTRA
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'updated_at'
  `;

  assert.ok(rows.length >= 4, `expected updated_at on at least 4 tables, found ${rows.length}`);
  for (const r of rows) {
    assert.match(
      r.EXTRA,
      /on update CURRENT_TIMESTAMP\(3\)/i,
      `${r.TABLE_NAME}.updated_at lacks ON UPDATE CURRENT_TIMESTAMP(3)`
    );
  }
});

test('B1(a) users.email collation is COLUMN-level, proven by behaviour', async () => {
  // The column is utf8mb4_0900_as_ci (accent-SENSITIVE, case-insensitive).
  // The table default is utf8mb4_0900_ai_ci (accent-INSENSITIVE). The two
  // differ, so accent-sensitive behaviour cannot have been inherited from the
  // table - observing it IS the proof that the column carries its own
  // collation. Prisma cannot express this, so this test is the only guard.
  const [col] = await prisma.$queryRaw`
    SELECT c.COLLATION_NAME AS col_collation, t.TABLE_COLLATION AS table_collation
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'users' AND c.COLUMN_NAME = 'email'
  `;
  assert.equal(col.col_collation, 'utf8mb4_0900_as_ci');
  assert.notEqual(
    col.col_collation,
    col.table_collation,
    'column and table collation are identical, so this test cannot distinguish inherited from explicit'
  );

  await inRollback(async (tx) => {
    // 1. jose@x.com inserts.
    await tx.$executeRawUnsafe(
      `INSERT INTO users (uuid, name, email, password_hash) VALUES (UUID(), 'Jose', 'jose@x.com', 'x')`
    );

    // 2. jose@x.com with an accent is a DIFFERENT address and must also insert.
    //    Under the table's _ai_ci default this would have collided.
    await tx.$executeRawUnsafe(
      `INSERT INTO users (uuid, name, email, password_hash) VALUES (UUID(), 'Jose accented', 'josé@x.com', 'x')`
    );

    const [{ n }] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM users WHERE email IN ('jose@x.com', 'josé@x.com')`
    );
    assert.equal(num(n), 2, 'accented and unaccented emails were merged; collation is accent-insensitive');

    // 3. JOSE@x.com is the SAME address and must be refused.
    await expectRejected(
      tx,
      `INSERT INTO users (uuid, name, email, password_hash) VALUES (UUID(), 'Jose upper', 'JOSE@x.com', 'x')`,
      'the case-variant duplicate JOSE@x.com'
    );
  });
});

test('B1(d) updated_at actually changes on UPDATE', async () => {
  // ON UPDATE CURRENT_TIMESTAMP(3) is maintained by the database. Prisma's
  // @updatedAt is client-side only and its derived DDL omits the clause, so
  // an information_schema lookup is not enough - this proves the behaviour.
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Touch Test', 'before', 100)
    `);
    const [before] = await tx.$queryRawUnsafe(
      `SELECT updated_at FROM categories WHERE name = 'ZZ Touch Test'`
    );

    // DATETIME(3) is millisecond-resolution; leave a gap wider than that.
    await new Promise((r) => setTimeout(r, 25));

    // Deliberately a raw SQL UPDATE, i.e. the path Prisma's client-side
    // @updatedAt would NOT cover.
    await tx.$executeRawUnsafe(
      `UPDATE categories SET short_description = 'after' WHERE name = 'ZZ Touch Test'`
    );
    const [after] = await tx.$queryRawUnsafe(
      `SELECT updated_at FROM categories WHERE name = 'ZZ Touch Test'`
    );

    assert.ok(
      new Date(after.updated_at).getTime() > new Date(before.updated_at).getTime(),
      `updated_at did not advance: ${before.updated_at} -> ${after.updated_at}`
    );
  });
});

test('B1(c) branding_settings refuses a second row', async () => {
  // CHECK (id = 1) makes the singleton an invariant rather than a convention.
  await inRollback(async (tx) => {
    await expectRejected(
      tx,
      `INSERT INTO branding_settings (id, organisation_name) VALUES (2, 'Second Tenant')`,
      'a second branding_settings row with id 2'
    );
    // Also refuse id 0, which a naive "id != 1" guard would let through.
    await expectRejected(
      tx,
      `INSERT INTO branding_settings (id, organisation_name) VALUES (0, 'Zeroth Tenant')`,
      'a branding_settings row with id 0'
    );
  });
});

test('case-variant emails collide on the unique index', async () => {
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO users (uuid, name, email, password_hash)
      VALUES (UUID(), 'Lower', 'collide.test@example.org', 'x')
    `);
    await expectRejected(
      tx,
      `INSERT INTO users (uuid, name, email, password_hash)
       VALUES (UUID(), 'Upper', 'Collide.Test@example.org', 'x')`,
      'a case-variant duplicate email'
    );
  });
});

test('accent-variant emails do NOT collide', async () => {
  // jose@ and its e-with-acute variant are different addresses and must
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO users (uuid, name, email, password_hash)
      VALUES (UUID(), 'Plain', 'jose.accent@example.org', 'x')
    `);
    await tx.$executeRawUnsafe(`
      INSERT INTO users (uuid, name, email, password_hash)
      VALUES (UUID(), 'Accented', 'josé.accent@example.org', 'x')
    `);
    const [{ n }] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM users WHERE email LIKE '%.accent@example.org'`
    );
    assert.equal(num(n), 2, 'accented and unaccented emails were treated as the same address');
  });
});

// =============================================================================
// mihpayid uniqueness - a data-integrity control (ADR-026), not the replay
// defence. mihpayid is unsigned by PayU; the replay defence is the state
// transition on signed fields. These assertions still matter: the index keeps
// one gateway payment id from being recorded against two donations.
// =============================================================================
test('donation_payment_details.mihpayid carries a UNIQUE index', async () => {
  const rows = await prisma.$queryRaw`
    SELECT INDEX_NAME, NON_UNIQUE
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'donation_payment_details'
      AND COLUMN_NAME = 'mihpayid'
  `;

  assert.ok(rows.length > 0, 'no index on donation_payment_details.mihpayid at all (ADR-026 integrity control missing)');
  assert.ok(
    rows.some((r) => num(r.NON_UNIQUE) === 0),
    'the index on mihpayid exists but is not UNIQUE; one gateway payment id could be recorded against two donations'
  );
});

test('a duplicate mihpayid is rejected, but multiple NULLs are allowed', async () => {
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Replay Test', 'test', 100)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Replay Test'`);

    const mkDonation = (n) => `
      INSERT INTO donations
        (uuid, transaction_ref, donor_name, donor_email, category_id,
         base_amount_minor, amount_minor, donated_at)
      VALUES (UUID(), UUID(), 'Donor ${n}', 'd${n}@example.org', ${cat.id}, 100, 100, NOW(3))
    `;
    await tx.$executeRawUnsafe(mkDonation(1));
    await tx.$executeRawUnsafe(mkDonation(2));
    await tx.$executeRawUnsafe(mkDonation(3));

    const ds = await tx.$queryRawUnsafe(
      `SELECT id FROM donations WHERE donor_email LIKE 'd%@example.org' ORDER BY id`
    );

    // Two unpaid donations, both with a NULL mihpayid - must be permitted.
    await tx.$executeRawUnsafe(
      `INSERT INTO donation_payment_details (donation_id, mihpayid) VALUES (${ds[0].id}, NULL)`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO donation_payment_details (donation_id, mihpayid) VALUES (${ds[1].id}, NULL)`
    );

    // The same PayU payment identifier recorded twice - must be refused.
    await tx.$executeRawUnsafe(
      `UPDATE donation_payment_details SET mihpayid = 'PAYU-REPLAY-1' WHERE donation_id = ${ds[0].id}`
    );
    await expectRejected(
      tx,
      `INSERT INTO donation_payment_details (donation_id, mihpayid)
       VALUES (${ds[2].id}, 'PAYU-REPLAY-1')`,
      'a replayed PayU mihpayid'
    );
  });
});

// =============================================================================
// Foreign key referential actions
// =============================================================================
test('foreign keys carry the specified ON DELETE actions', async () => {
  const expected = {
    fk_donations_user: 'SET NULL',
    fk_donations_category: 'RESTRICT',
    fk_category_descriptions_category: 'CASCADE',
    fk_donation_payment_details_donation: 'CASCADE',
    fk_branding_settings_updated_by: 'SET NULL',
  };

  const rows = await prisma.$queryRaw`
    SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
    FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
  `;
  const actual = Object.fromEntries(rows.map((r) => [r.CONSTRAINT_NAME, r.DELETE_RULE]));

  for (const [name, rule] of Object.entries(expected)) {
    assert.equal(actual[name], rule, `${name} has ON DELETE ${actual[name] ?? '(missing)'}, expected ${rule}`);
  }
});

test('deleting a category that has donations is refused', async () => {
  // ON DELETE RESTRICT. Financial records must not lose the category that
  // priced them - which is why the delete endpoint becomes a soft delete.
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Restrict Test', 'test', 500)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Restrict Test'`);
    await tx.$executeRawUnsafe(`
      INSERT INTO donations
        (uuid, transaction_ref, donor_name, donor_email, category_id,
         base_amount_minor, amount_minor, donated_at)
      VALUES (UUID(), UUID(), 'Donor', 'restrict@example.org', ${cat.id}, 500, 500, NOW(3))
    `);

    await expectRejected(
      tx,
      `DELETE FROM categories WHERE id = ${cat.id}`,
      'deleting a category with donations'
    );
  });
});

test('deleting a user preserves their donations as guest donations', async () => {
  // ON DELETE SET NULL. A financial record is not deleted because an account
  // was; donor_name and donor_email survive on the row.
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ SetNull Test', 'test', 700)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ SetNull Test'`);
    await tx.$executeRawUnsafe(`
      INSERT INTO users (uuid, name, email, password_hash)
      VALUES (UUID(), 'Doomed', 'doomed@example.org', 'x')
    `);
    const [usr] = await tx.$queryRawUnsafe(`SELECT id FROM users WHERE email = 'doomed@example.org'`);
    await tx.$executeRawUnsafe(`
      INSERT INTO donations
        (uuid, transaction_ref, donor_name, donor_email, user_id, category_id,
         base_amount_minor, amount_minor, donated_at)
      VALUES (UUID(), UUID(), 'Doomed', 'doomed@example.org', ${usr.id}, ${cat.id}, 700, 700, NOW(3))
    `);

    await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = ${usr.id}`);

    const [row] = await tx.$queryRawUnsafe(
      `SELECT user_id, donor_name, donor_email FROM donations WHERE donor_email = 'doomed@example.org'`
    );
    assert.ok(row, 'the donation was deleted along with the user');
    assert.equal(row.user_id, null, 'user_id was not set to NULL');
    assert.equal(row.donor_name, 'Doomed', 'donor_name was lost');
  });
});

// =============================================================================
// ENUM value sets - these close BUG-02, BUG-03 and SEC-16
// =============================================================================
test('ENUM value sets match the specification exactly', async () => {
  const expected = {
    'donations.status': "enum('Pending','Approved','Rejected')",
    'donations.payment_status': "enum('Pending','Paid','Failed','Cancelled')",
    'users.role': "enum('user','admin')",
    'pending_signups.role': "enum('user','admin')",
  };

  const rows = await prisma.$queryRaw`
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'enum'
  `;
  const actual = Object.fromEntries(rows.map((r) => [`${r.TABLE_NAME}.${r.COLUMN_NAME}`, r.COLUMN_TYPE]));

  for (const [col, type] of Object.entries(expected)) {
    assert.equal(actual[col], type, `${col} is ${actual[col] ?? '(missing)'}, expected ${type}`);
  }
});

test('a lowercase donation status is CANONICALISED, not stored as written', async () => {
  // BUG-02 / BUG-03: Mongoose let findByIdAndUpdate write 'approved' past its
  // enum, so the collection held both casings and every status filter missed
  // half the rows.
  //
  // MySQL does NOT reject the lowercase form. ENUM assignment is subject to
  // the column's collation, and utf8mb4_0900_ai_ci is case-insensitive, so
  // 'approved' is matched to the defined member and stored as 'Approved'.
  // Verified: HEX(status) reads 417070726F766564.
  //
  // That closes the bug more robustly than rejection would: a legacy caller
  // sending lowercase still succeeds, AND the stored value is canonical, so a
  // query for 'Approved' finds it. If this column's collation ever becomes
  // _bin or _cs, the write starts failing instead - which is why the
  // collation assertions above matter to this behaviour too.
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Enum Test', 'test', 300)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Enum Test'`);

    await tx.$executeRawUnsafe(`
      INSERT INTO donations
        (uuid, transaction_ref, donor_name, donor_email, category_id,
         base_amount_minor, amount_minor, status, donated_at)
      VALUES (UUID(), UUID(), 'D', 'enum@example.org', ${cat.id}, 300, 300, 'approved', NOW(3))
    `);

    const [row] = await tx.$queryRawUnsafe(
      `SELECT status, HEX(status) AS hex FROM donations WHERE donor_email = 'enum@example.org'`
    );
    assert.equal(row.status, 'Approved', `lowercase 'approved' was stored as ${row.status}, not canonicalised`);
    assert.equal(row.hex, '417070726F766564', 'stored bytes are not the canonical "Approved"');

    // The point of BUG-03: a query for the canonical form must find it.
    const [{ n }] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM donations WHERE donor_email = 'enum@example.org' AND status = 'Approved'`
    );
    assert.equal(num(n), 1, "a row written as 'approved' is not found by status = 'Approved'");
  });
});

test('C3 the server runs in strict SQL mode', async () => {
  // The ENUM rejection asserted below DEPENDS on this. Without
  // STRICT_TRANS_TABLES the same INSERT succeeds and stores the empty string.
  // STRICT_TRANS_TABLES is a MySQL 8 default, but sql_mode is settable and
  // managed providers ship their own defaults.
  const [row] = await prisma.$queryRaw`
    SELECT @@SESSION.sql_mode AS session_mode, @@GLOBAL.sql_mode AS global_mode
  `;

  for (const [scope, mode] of [['SESSION', row.session_mode], ['GLOBAL', row.global_mode]]) {
    assert.match(
      String(mode),
      /STRICT_TRANS_TABLES|STRICT_ALL_TABLES|TRADITIONAL/,
      `${scope} sql_mode is "${mode}" - not strict. An out-of-set ENUM value ` +
        'would be stored as the empty string with only a warning.'
    );
  }
});

test('C3 without strict mode an out-of-set ENUM becomes the EMPTY STRING', async () => {
  // Demonstrates the dependency rather than asserting it: strict mode is
  // relaxed for one transaction, the same INSERT is retried, and the result
  // is inspected. This is the corruption the server guard exists to prevent -
  // a donation whose payment_status matches no filter and therefore vanishes
  // from every report.
  //
  // sql_mode is a session variable and is NOT rolled back with the
  // transaction, so it is restored explicitly.
  const [{ session_mode: original }] = await prisma.$queryRaw`
    SELECT @@SESSION.sql_mode AS session_mode
  `;

  try {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
        VALUES (UUID(), 'ZZ Lax Mode', 'test', 100)
      `);
      const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Lax Mode'`);

      await tx.$executeRawUnsafe(`SET SESSION sql_mode = ''`);

      // The very insert that errors under strict mode.
      await tx.$executeRawUnsafe(`
        INSERT INTO donations
          (uuid, transaction_ref, donor_name, donor_email, category_id,
           base_amount_minor, amount_minor, status, payment_status, donated_at)
        VALUES (UUID(), UUID(), 'D', 'lax@example.org', ${cat.id}, 100, 100,
                'banana', 'nonsense', NOW(3))
      `);

      const [row] = await tx.$queryRawUnsafe(
        `SELECT status, payment_status, LENGTH(status) AS len
           FROM donations WHERE donor_email = 'lax@example.org'`
      );
      assert.equal(row.status, '', 'expected the invalid ENUM to be stored as the empty string');
      assert.equal(num(row.len), 0);
      assert.equal(row.payment_status, '');

      // And the row is invisible to every status filter - the actual harm.
      const [{ n }] = await tx.$queryRawUnsafe(
        `SELECT COUNT(*) AS n FROM donations
          WHERE donor_email = 'lax@example.org'
            AND payment_status IN ('Pending','Paid','Failed','Cancelled')`
      );
      assert.equal(num(n), 0, 'the corrupted row should match no valid payment_status');
    });
  } finally {
    await prisma.$executeRawUnsafe(`SET SESSION sql_mode = '${String(original).replace(/'/g, "''")}'`);
  }

  // Confirm the restore worked, so no later test inherits a lax session.
  const [{ session_mode: after }] = await prisma.$queryRaw`
    SELECT @@SESSION.sql_mode AS session_mode
  `;
  assert.match(String(after), /STRICT_TRANS_TABLES|STRICT_ALL_TABLES|TRADITIONAL/, 'sql_mode was not restored');
});

test('an out-of-set donation status is rejected outright', async () => {
  // SEC-16: PUT /donations/:id writes req.body.status straight through
  // findByIdAndUpdate, which does not run Mongoose validators. MySQL refuses
  // anything that is not a member of the ENUM, case-folding aside.
  await inRollback(async (tx) => {
    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Enum Junk', 'test', 300)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Enum Junk'`);

    await expectRejected(
      tx,
      `INSERT INTO donations
         (uuid, transaction_ref, donor_name, donor_email, category_id,
          base_amount_minor, amount_minor, status, donated_at)
       VALUES (UUID(), UUID(), 'D', 'junk@example.org', ${cat.id}, 300, 300, 'banana', NOW(3))`,
      "the out-of-set status 'banana'"
    );
  });
});

// =============================================================================
// CHECK constraints - present AND enforced
// =============================================================================
test('all expected CHECK constraints exist', async () => {
  const expected = [
    'ck_categories_amount_positive',
    'ck_donations_quantity_min',
    'ck_donations_amount_positive',
    'ck_branding_settings_singleton',
    'ck_branding_settings_primary_colour',
    'ck_branding_settings_secondary_colour',
  ];

  const rows = await prisma.$queryRaw`
    SELECT CONSTRAINT_NAME
    FROM information_schema.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
  `;
  const found = new Set(rows.map((r) => r.CONSTRAINT_NAME));

  for (const name of expected) {
    assert.ok(found.has(name), `CHECK constraint ${name} is missing (Prisma migrate dev drops these)`);
  }
});

test('B1(e) every CHECK constraint rejects a violating value', async () => {
  // Below MySQL 8.0.16 a CHECK clause parses and is then silently IGNORED, so
  // "the constraint exists in information_schema" proves nothing about
  // enforcement. Each of the six is exercised with a value it must refuse.
  //
  // ck_branding_settings_singleton is covered by its own test above; the two
  // colour checks and the three numeric checks are covered here, so all six
  // named constraints in db/schema.sql are empirically enforced.
  await inRollback(async (tx) => {
    // 1. ck_categories_amount_positive
    await expectRejected(
      tx,
      `INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
       VALUES (UUID(), 'ZZ Zero Price', 'test', 0)`,
      'ck_categories_amount_positive: a category priced at zero'
    );

    // 2. ck_branding_settings_primary_colour
    await expectRejected(
      tx,
      `UPDATE branding_settings SET primary_colour = 'notahex' WHERE id = 1`,
      'ck_branding_settings_primary_colour: a malformed hex colour'
    );
    // ...and the near-miss forms a loose regex would wave through.
    await expectRejected(
      tx,
      `UPDATE branding_settings SET primary_colour = '05699E' WHERE id = 1`,
      'ck_branding_settings_primary_colour: a colour missing its leading #'
    );

    // 3. ck_branding_settings_secondary_colour
    await expectRejected(
      tx,
      `UPDATE branding_settings SET secondary_colour = '#12345' WHERE id = 1`,
      'ck_branding_settings_secondary_colour: a 5-digit hex colour'
    );

    // A well-formed colour must still be accepted - a check that rejects
    // everything would pass all the assertions above.
    await tx.$executeRawUnsafe(
      `UPDATE branding_settings SET primary_colour = '#05699E', secondary_colour = '#044d73' WHERE id = 1`
    );
    const [b] = await tx.$queryRawUnsafe(`SELECT primary_colour, secondary_colour FROM branding_settings WHERE id = 1`);
    assert.equal(b.primary_colour, '#05699E', 'a valid uppercase hex colour was not accepted');
    assert.equal(b.secondary_colour, '#044d73', 'a valid lowercase hex colour was not accepted');

    await tx.$executeRawUnsafe(`
      INSERT INTO categories (uuid, name, short_description, donation_amount_minor)
      VALUES (UUID(), 'ZZ Check Test', 'test', 400)
    `);
    const [cat] = await tx.$queryRawUnsafe(`SELECT id FROM categories WHERE name = 'ZZ Check Test'`);

    // 4. ck_donations_quantity_min
    await expectRejected(
      tx,
      `INSERT INTO donations
         (uuid, transaction_ref, donor_name, donor_email, category_id,
          quantity, base_amount_minor, amount_minor, donated_at)
       VALUES (UUID(), UUID(), 'D', 'q@example.org', ${cat.id}, 0, 400, 400, NOW(3))`,
      'ck_donations_quantity_min: a donation with quantity 0'
    );

    // 5. ck_donations_amount_positive
    await expectRejected(
      tx,
      `INSERT INTO donations
         (uuid, transaction_ref, donor_name, donor_email, category_id,
          base_amount_minor, amount_minor, donated_at)
       VALUES (UUID(), UUID(), 'D', 'z@example.org', ${cat.id}, 0, 0, NOW(3))`,
      'ck_donations_amount_positive: a donation of zero'
    );
  });
});

// =============================================================================
// Singleton invariant
// =============================================================================
test('branding_settings holds exactly one row, with id 1', async () => {
  // db/schema.sql seeds this so the application never handles a missing row.
  const [{ n }] = await prisma.$queryRaw`SELECT COUNT(*) AS n FROM branding_settings`;
  assert.equal(num(n), 1, `branding_settings has ${num(n)} rows, expected exactly 1`);

  const [{ id }] = await prisma.$queryRaw`SELECT id FROM branding_settings`;
  assert.equal(num(id), 1, 'the branding_settings row does not have id 1');
});

// =============================================================================
// External identifiers
// =============================================================================
test('every externally exposed entity has a unique uuid', async () => {
  const tables = ['users', 'pending_signups', 'categories', 'donations'];
  const rows = await prisma.$queryRaw`
    SELECT s.TABLE_NAME, s.NON_UNIQUE
    FROM information_schema.STATISTICS s
    WHERE s.TABLE_SCHEMA = DATABASE() AND s.COLUMN_NAME = 'uuid'
  `;

  for (const t of tables) {
    const idx = rows.filter((r) => r.TABLE_NAME === t);
    assert.ok(idx.length > 0, `${t} has no index on uuid`);
    assert.ok(idx.some((r) => num(r.NON_UNIQUE) === 0), `${t}.uuid is not UNIQUE`);
  }
});

test('donations.transaction_ref is unique and 36 characters wide', async () => {
  // Replaces the guessable TXN<epoch><rand> scheme behind SEC-06.
  const [col] = await prisma.$queryRaw`
    SELECT COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations'
      AND COLUMN_NAME = 'transaction_ref'
  `;
  assert.ok(col, 'donations.transaction_ref is missing');
  assert.equal(num(col.CHARACTER_MAXIMUM_LENGTH), 36, 'transaction_ref is not 36 characters (UUID)');

  const rows = await prisma.$queryRaw`
    SELECT NON_UNIQUE FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations'
      AND COLUMN_NAME = 'transaction_ref'
  `;
  assert.ok(rows.some((r) => num(r.NON_UNIQUE) === 0), 'transaction_ref is not UNIQUE');
});

// =============================================================================
// Retention and expiry support
// =============================================================================
test('pending_signups.expires_at is indexed (replaces the MongoDB TTL index)', async () => {
  const rows = await prisma.$queryRaw`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pending_signups'
      AND COLUMN_NAME = 'expires_at'
  `;
  assert.ok(rows.length > 0, 'no index on pending_signups.expires_at; the cron sweep would table-scan');
});

test('the retention purge index on users exists', async () => {
  const rows = await prisma.$queryRaw`
    SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
      AND INDEX_NAME = 'ix_users_created_at_role'
    ORDER BY SEQ_IN_INDEX
  `;
  assert.deepEqual(
    rows.map((r) => r.COLUMN_NAME),
    ['created_at', 'role'],
    'ix_users_created_at_role is missing or has the wrong column order'
  );
});
