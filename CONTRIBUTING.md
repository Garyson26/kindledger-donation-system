# Contributing to KindLedger

## Database requirements

**MySQL 8.0.16 or later. MariaDB is not supported.**

The server must also run in **strict SQL mode** (`STRICT_TRANS_TABLES`).

All three are enforced, not merely requested — `npm run db:migrate` and
`npm run db:seed` run `Backend/db/require-mysql-version.js` first and refuse to
proceed otherwise.

Strict mode is load-bearing: without it MySQL does not reject an out-of-set
`ENUM` value, it stores the **empty string** with a warning. A donation whose
`payment_status` is `''` then matches no filter and vanishes from every report
while still sitting in the table — BUG-02 and BUG-03 recreated by
configuration. It is a MySQL 8 default, but `sql_mode` is settable and managed
providers ship their own defaults.

The floor is 8.0.16 because that is where MySQL began **enforcing** `CHECK`
constraints. Below it the syntax in `db/schema.sql` parses and is then silently
ignored, so the schema applies without a single error and without any of its
guarantees: a category could be priced at zero, a donation recorded for zero
rupees, and `branding_settings` could hold more than one row.

MariaDB is excluded because it has no `utf8mb4_0900_*` collations at all. The
email uniqueness guarantee depends on `utf8mb4_0900_as_ci`, and a silent
fallback to another collation either merges distinct donor accounts or permits
duplicate ones.

The bundled `docker-compose.yml` provides a correctly configured `mysql:8.4`:

```bash
cp .env.example .env     # fill in the required values
docker compose up -d     # db + redis
```

---

## NEVER run `prisma migrate dev`

This is the single most important rule in the repository, and running it from
habit is the most likely way to break the system silently.

`db/schema.sql` is the **source of truth**. `Backend/prisma/schema.prisma` is
generated to match it. Prisma cannot express five things the DDL depends on, so
it reads every one of them as drift to be removed:

| What Prisma cannot express | Consequence of losing it |
|---|---|
| All six `CHECK` constraints | A category can be priced at zero; a donation recorded for zero rupees; `branding_settings` can hold multiple rows |
| `users.email` / `pending_signups.email` `COLLATE utf8mb4_0900_as_ci` | The column becomes accent-**insensitive**, which **merges** `jose@x.com` with `josé@x.com` — two distinct people collapsed into one account |
| The table default collation | Reverts to `utf8mb4_unicode_ci` (UCA 5.2.0) |
| `ON UPDATE CURRENT_TIMESTAMP(3)` | Raw SQL and ETL corrections stop bumping `updated_at` |
| Column `COMMENT`s | All the rationale is lost |

None of it raises an error. The migration applies cleanly and the guarantees
are simply gone.

The habitual invocations are shadowed and exit non-zero with an explanation:

```
npm run migrate            # refuses
npm run migrate:dev        # refuses
npm run prisma             # refuses
npm run prisma:migrate:dev # refuses
```

To inspect what Prisma *would* generate, without applying it:

```bash
npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma --script
```

---

## Changing the schema

1. **Edit `db/schema.sql` first.** It is normative; nothing else is.
2. **Hand-author a migration.** Create
   `Backend/prisma/migrations/<UTC timestamp>_<name>/migration.sql` containing
   the SQL for your change. Never edit a migration that has been applied
   anywhere.
3. **Update `Backend/prisma/schema.prisma`** to match, so the ORM model and the
   database agree on everything Prisma *can* see. Give every `@unique` an
   explicit `map:` so index names match the DDL rather than Prisma's
   `*_key` convention.
4. **Apply it**: `npm run db:migrate` (which is `prisma migrate deploy`).
5. **Verify**:

```bash
npm run test:schema      # asserts the constraints are present AND enforced
npm run db:check-drift   # fails on any drift, structural or invariant
```

Both run in CI on every pull request that touches the schema
(`.github/workflows/schema.yml`). The drift gate is a merge gate.

### Two constraints to know about before you edit the DDL

- MySQL prohibits a `CHECK` constraint on a column used in a foreign key's
  referential action, and vice versa. No column currently carries both; the
  disjoint sets are listed in the header of `db/schema.sql`. A change that
  crosses them will be rejected at DDL time.
- Money is **integer minor units** (`BIGINT UNSIGNED`, `_minor` suffix). Never
  `FLOAT`, `DOUBLE` or `DECIMAL`. `test:schema` asserts that no approximate or
  decimal column exists anywhere, so this cannot be quietly reversed. The
  reason is JavaScript, not MySQL: the driver surfaces `DECIMAL` as a string or
  a lossy `Number`, and the application then compares currency in a language
  with no decimal type.

---

## Seeding demo data

```bash
npm run db:seed -- --i-understand-this-drops-the-database
npm run db:seed -- --i-understand-this-drops-the-database --users=100
```

Destructive by design: it empties every application table. It refuses to run
when `NODE_ENV=production`, and it refuses without the flag. It generates a
random password per run and prints it **once** — there is no recovery path, so
re-run it if you lose the value.

---

## Tests

| Command | Needs a database | Covers |
|---|---|---|
| `npm run test:guard` | no | The MySQL/MariaDB version classifier |
| `npm run test:schema` | yes | Constraints, collations, foreign key actions, ENUM sets — present *and* enforced |
| `npm run db:check-drift` | yes | Structural drift plus the four invariants Prisma cannot see |

There is no application test suite yet; `npm test` still exits 1. Adding one —
starting with the PayU callback handlers — is the highest-value gap.
