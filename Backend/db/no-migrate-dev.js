#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * `prisma migrate dev` interceptor (SPEC-1A B3)
 * =============================================================================
 * Bound to the npm script name `prisma:migrate:dev` and to a `migrate` script
 * that shadows the habitual invocation. Its only job is to refuse, loudly, and
 * point at the hand-written migration process.
 *
 * Assume an outside contributor runs `migrate dev` from habit. On this schema
 * that is destructive in a way no error message from Prisma would reveal:
 * Prisma diffs the database against schema.prisma, and everything the Prisma
 * schema language cannot express reads to it as drift to be removed.
 * =============================================================================
 */

'use strict';

const RULE = `
========================================================================
  DO NOT RUN 'prisma migrate dev' IN THIS REPOSITORY
========================================================================

  It would generate a migration that SILENTLY DROPS security controls.

  Prisma cannot express five things db/schema.sql depends on, so it reads
  every one of them as drift and removes it:

    1. All six CHECK constraints. A category could then be priced at
       zero and a donation recorded for zero rupees.

    2. users.email / pending_signups.email COLLATE utf8mb4_0900_as_ci.
       Reverting to the table default makes the column accent-INSENSITIVE,
       which MERGES jose@x.com with jose@x.com (accented) - two distinct
       people collapsed into one account.

    3. The table default collation itself (utf8mb4_0900_ai_ci ->
       utf8mb4_unicode_ci).

    4. ON UPDATE CURRENT_TIMESTAMP(3) on every updated_at column, so raw
       SQL and ETL corrections stop bumping the timestamp.

    5. Every column COMMENT, i.e. all the rationale.

  None of that appears as an error. The migration applies cleanly and the
  guarantees are just gone.

  THE SUPPORTED PROCESS
  ---------------------
    1. Edit db/schema.sql first. It is the source of truth.
    2. Hand-author a migration directory under prisma/migrations/ whose
       migration.sql matches.
    3. Apply it with:   npm run db:migrate     (prisma migrate deploy)
    4. Verify with:     npm run test:schema
       The suite asserts the checks, collations and ON UPDATE clauses are
       still present, and fails if they have been flattened.

  See docs/decisions.md ADR-002 and CONTRIBUTING.md.

  If you genuinely need to inspect what Prisma WOULD generate, without
  applying it:

    npx prisma migrate diff --from-empty \\
      --to-schema-datamodel prisma/schema.prisma --script

========================================================================
`;

console.error(RULE);
process.exit(1);
