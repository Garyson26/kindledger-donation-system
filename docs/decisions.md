# Architectural decision records

Decisions taken while executing SPEC-1A (Phase 1a, foundation work package).
Each entry records what was decided, why, and what it changes for anyone working
on the system afterwards. Newest phase last.

Status values: **Accepted**, **Superseded**, **Open**.

---

## ADR-001 — The backend leaves serverless for a container stack

**Status** Accepted (recorded in SPEC-1A section 3.2, restated here for the record)

MongoDB Atlas plus Vercel serverless functions is replaced by MySQL 8.4, Redis,
Nginx and a long-lived Node container, orchestrated by `docker-compose.yml`.

**Why**

1. A self-hosted open-source project must run with `docker compose up`. A
   platform-specific database driver is a vendor dependency baked into the
   product.
2. One process, one connection pool. Serverless MySQL connection exhaustion
   stops being a problem rather than being worked around with a proxy tier.
3. `node-cron` becomes viable, which is the precondition for fixing BUG-04
   (the retention purge never runs), SEC-11 (the stale `Pending` donation
   sweep), and the `PendingSignup` expiry that replaces MongoDB's TTL index.
4. SEC-04 (rate limiting non-functional) becomes fixable. A single process with
   an in-memory store already works; Redis covers multi-replica deployments.
5. CI gets a real MySQL to run integration tests against, which the security
   review specifically asks for on the payment callbacks.

**Consequences** The team now owns TLS, backups, patching and uptime, which
Vercel previously handled. The frontend stays on Vercel and is unaffected.

---

## ADR-002 — Prisma as the ORM, with the DDL kept normative

**Status** Accepted (blocking decision D-01)

Prisma was chosen over Knex, Sequelize and raw `mysql2`. `db/schema.sql`
remains the source of truth; `Backend/prisma/schema.prisma` is generated to
match it.

**Why** `prisma migrate deploy` gives self-hosting NGOs a supported upgrade
path once this repository is public. That was judged to matter more than
developer preference or dependency weight.

**Consequences, and they are not small.** Prisma cannot express five things the
DDL relies on. All five were confirmed empirically by diffing the two with
`prisma migrate diff --from-empty --to-schema-datamodel`:

| Cannot express | Effect if Prisma generates a migration |
|---|---|
| `CHECK` constraints | All six are silently dropped |
| Per-column collation | The email columns lose `utf8mb4_0900_as_ci`, and case-variant duplicate accounts become possible again |
| Table default collation | Emits `utf8mb4_unicode_ci` instead of `utf8mb4_0900_ai_ci` |
| `ON UPDATE CURRENT_TIMESTAMP(3)` | `updated_at` stops being maintained by the database |
| Column `COMMENT`s | All rationale is lost |

From Prisma's point of view every one of those is *drift*, so `prisma migrate
dev` will helpfully offer to remove them. The workflow is therefore:

- Schema changes go into `db/schema.sql` first.
- A migration is hand-authored under `Backend/prisma/migrations/` to match.
- `prisma migrate deploy` applies it. **`migrate dev` is never used.**
- `Backend/test/schema.test.js` asserts the checks, collations and `ON UPDATE`
  clauses still exist, and fails if a Prisma-generated migration has flattened
  them.

Verified as *not* drift: every column type, nullability and default; every
`ENUM` value set; every index and its column order; every foreign key and its
referential actions; and all unique index names, which required adding an
explicit `map:` to each `@unique`.

---

## ADR-003 — Deleting a user preserves their donations

**Status** Accepted — **behaviour change**

`donations.user_id` carries `ON DELETE SET NULL`.

**What changes** `DELETE /api/admin/users/:id` currently hard-deletes the user
and leaves their donation documents pointing at an ObjectId that no longer
resolves. Under a real foreign key the donation survives as a guest donation,
with `donor_name` and `donor_email` preserved on the donation row itself.

**Why** A financial record must not be deleted because an account was. The
donation actually happened, the money was actually received, and the reporting
totals must continue to reflect it.

**Consequences** Admin-facing: deleting a user no longer removes them from
donation reports; their past donations appear as guest donations. Anyone
expecting user deletion to be a privacy erasure mechanism needs to know that it
is not — the donor's name and email remain on every donation row. If actual
erasure is required (a DPDP Act request, say), that is a separate operation
that must scrub `donor_name`, `donor_email` and `donor_phone` explicitly. Not in
scope for this phase; flagged for whoever owns DEF-02.

---

## ADR-004 — Category deletion becomes a soft delete

**Status** Accepted — **behaviour change**

`categories.deleted_at` is added, and `donations.category_id` carries
`ON DELETE RESTRICT`.

**What changes** `DELETE /api/categories/:id` currently hard-deletes. With the
foreign key in place, deleting a category that has ever received a donation
would now fail at the database. So in Phase 3 the endpoint becomes a soft
delete, and every read path must filter `deleted_at IS NULL`.

**Why** Financial records must not lose the category that priced them. A
donation of ₹1,500 is only interpretable next to the category that cost ₹1,500
at the time.

**Consequences** The admin UI must say "archive", not "delete", because the
category will still exist and still be referenced by historic donations. A
soft-deleted category must disappear from the public category list and from the
donation form, but must still resolve when rendering an old donation or receipt.
Note also that `uq_categories_name` is a plain unique index, so an archived
category continues to occupy its name — an admin cannot archive
"Ocean Cleanup Drive" and then create a new category with the same name. If that
turns out to matter, the fix is to include `deleted_at` in the uniqueness, which
is a schema change and therefore a new migration.

---

## ADR-005 — Category descriptions stay a child table

**Status** Accepted

`category_descriptions` is a normalised child table rather than a `JSON` column
on `categories`.

**Why** SPEC-1A section 5.4 permitted collapsing this to a `JSON` column *if*
the descriptions turned out never to be individually addressed anywhere in the
frontend. They are: `Frontend/src/components/AddCategoryForm.jsx` adds, removes
and edits them by index, and the category list already has a drag-to-reorder
pattern for `display_order`. The condition for the simplification was therefore
not met.

**Consequences** Reading a category with its descriptions is a join or a second
query. The current API replaces the whole array on every category update, so
Phase 3's update path will be a delete-and-reinsert of the child rows inside a
transaction; that is acceptable given the row counts involved (single digits per
category). `UNIQUE (category_id, position)` means reinsertion must not
transiently collide — delete first, then insert, in that order, in one
transaction.

---

## ADR-006 — The `api` and `nginx` services are profile-gated

**Status** Accepted — **deviation from the spec, needs review**

In `docker-compose.yml`, `api` and `nginx` sit behind the `app` compose profile.
`docker compose up` starts only `db` and `redis`; `docker compose --profile app
up` starts everything.

**Why** SPEC-1A section 10 requires that `docker compose up` produce "an API
container that starts and passes its healthcheck". That is not achievable in
this phase, and the spec contradicts itself on the point:

- `Backend/config/db.js` calls `process.exit(1)` when it cannot reach
  `MONGODB_URI`, and deliverable 7 removes `MONGODB_URI`. The container would
  exit immediately on every start.
- Section 3.3 specifies a healthcheck on `/api/health`, and then notes that the
  endpoint is "to be added in Phase 3". It does not exist today — verified
  against source.
- Section 1 forbids touching route handlers or middleware, which is what fixing
  either of those would require.

Gating the two services keeps the default stack green and honest rather than
shipping a restart loop that a reviewer would have to diagnose. The service
definitions themselves are complete and correct; only their default startup is
suppressed.

**Consequences** Acceptance criterion 1 is met only in part: MySQL comes up with
the full schema applied, but no API container runs. Phase 3 must remove the
`profiles:` key from both services and replace the api healthcheck — currently a
TCP connect probe against port 5000 — with a real `/api/health` request once
that endpoint exists.

---

## ADR-007 — Where the Phase 1a artefacts live

**Status** Accepted — **deviation from the spec**

The spec named `db/seed.js` and `test/schema.test.js`. They ship as
`Backend/db/seed.js` and `Backend/test/schema.test.js`.

**Why** Both need `@prisma/client` at runtime. Node resolves modules from the
importing file's directory upward, so a script at the repository root would look
in `./node_modules` and never find `Backend/node_modules`. The alternatives were
a second root-level `package.json` — two manifests for one Node application — or
a brittle `require('../Backend/node_modules/@prisma/client')`. Placing them
beside the dependencies they use is the least bad option.

`db/schema.sql` **does** stay at the repository root as specified: it is plain
SQL with no Node dependency, it is the normative artefact for the whole project,
and it is mounted into the MySQL container's `docker-entrypoint-initdb.d` by
`docker-compose.yml`.

**Consequences** There is one `db/` directory at the root holding only
`schema.sql`, and another at `Backend/db/` holding the seeder. That is mildly
confusing and worth revisiting if Phase 3 restructures the repository.

---

## ADR-008 — The root `.env.example` supersedes `Backend/.env.example`

**Status** Accepted

A new root-level `.env.example` configures the compose stack.
`Backend/.env.example` is left untouched.

**Why** The compose stack reads a single `.env` at the repository root, and it
now needs MySQL and Redis settings that have no meaning in the serverless
deployment. Meanwhile the serverless deployment is still production until the
Phase 4 cutover, and D-02 was answered "proceed with Phase 1a, hotfix
separately" — so the file describing the live system must keep describing it
accurately.

**Consequences** Two `.env.example` files coexist and disagree, which is
confusing. The root file carries a header saying which is which. Phase 4 should
delete `Backend/.env.example` at cutover.

---

## ADR-009 — `docs/decisions.md` is exempt from the `docs/` exclusion

**Status** Accepted

`.gitignore` excludes `docs/*` but re-includes `docs/decisions.md`.

**Why** The `docs/` directory was excluded from version control in a prior
change because `docs/SECURITY-REVIEW.md` contains exploit-level detail that
should not be published alongside the code. But this file is a required
deliverable of SPEC-1A and explains why the schema and topology look the way
they do — a future contributor needs it, and a gitignored deliverable is not a
deliverable.

Note the mechanism: the rule is `docs/*`, not `docs/`. Git cannot re-include a
file whose parent *directory* is itself excluded, so the directory-form
exclusion would have made the negation silently ineffective. Verified with
`git add --dry-run`: only `docs/decisions.md` is picked up.

**Consequences** Anyone adding a document to `docs/` must decide whether it is
internal (default, ignored) or part of the repository (needs an explicit
negation). `docs/PROJECT.md` remains untracked.

---

## ADR-010 — Money is stored as integer minor units

**Status** Accepted (recorded in SPEC-1A section 4.2, restated for the record)

All monetary values are `BIGINT UNSIGNED` columns of integer paise, suffixed
`_minor`. No `FLOAT`, `DOUBLE` or `DECIMAL` anywhere.

**Why** The reason is JavaScript, not MySQL. `DECIMAL` is exact in the database,
but the `mysql2` driver surfaces it as either a string or a lossy `Number`, and
the application then does arithmetic and comparison in a language with no native
decimal type. The security review's proposed SEC-01 fix compares
`Number(paymentData.amount) !== Number(donation.amount)`, which is float
equality on currency and will eventually reject a legitimate payment or accept a
wrong one. Integer paise makes that comparison exact.

**Consequences** Phase 3 must implement a single parse helper converting a PayU
amount string to minor units without passing through a float, rejecting anything
that is not a well-formed amount with at most two decimal places:

```
"1500.00"  -> 150000
"1500"     -> 150000
"1500.5"   -> 150050
"1500.005" -> reject
"1e3"      -> reject
```

Prisma surfaces `BIGINT` as a JavaScript `BigInt`, which does not serialise to
JSON automatically — `JSON.stringify` throws on it. Every API response carrying
an amount must convert explicitly. `Backend/test/schema.test.js` asserts that no
`float`, `double` or `decimal` column exists anywhere in the schema, so this
decision cannot be quietly reversed.

---

## ADR-011 — The demo seeder generates a random password per run

**Status** Accepted

`Backend/db/seed.js` generates one random password per run, prints it once to
stdout, and refuses to run unless `NODE_ENV` is not `production` **and**
`--i-understand-this-drops-the-database` is passed.

**Why** The previous seeder gave all 1000 demo users the password
`Password@123`, hardcoded in the script and printed in its README. Anyone who
ran it against a database that later became production, or against a shared
staging database, left a thousand accounts with a publicly known password. This
was raised in the security review and was still open.

**Consequences** There is no password recovery path — if the operator loses the
printed value they re-run the seeder. Seeded accounts all share the one
password, which is acceptable for demo data but means the seeded database must
never be exposed publicly. The seeder also deliberately disables roughly one in
twenty accounts so that `is_active` has non-uniform data to exercise the SEC-05
fix against.

---

## ADR-012 — SEC-01 idempotency is a read-then-write and is not atomic

**Status** Accepted — recorded deliberately, **not fixed in Package A**

The `/api/payment/success` handler added by the Package A hotfix
(`hotfix/payment-and-reset`) guards against replay by loading the donation and
returning early when `paymentStatus` is already `'Paid'`. That is a
read-then-write with no lock and no atomic compare-and-set.

**The race.** PayU delivers a browser callback to `/success` *and* a
server-to-server callback to `/webhook` for the same transaction. Both can read
`paymentStatus: 'Pending'` before either writes, and both then proceed to write.

**Why it is benign today.** Both paths write the same terminal values —
`status: 'Approved'`, `paymentStatus: 'Paid'` — from the same signed payload, so
the interleaving is idempotent in effect even though the mechanism is not. The
observable damage is limited to `paymentDetails.paymentDate` being set twice,
and possibly a duplicate log line.

**Why it is not fixed here.** A correct fix is either a conditional update
(`updateOne({_id, paymentStatus: 'Pending'}, ...)` and inspect `modifiedCount`)
or a unique index. Widening a production hotfix to change the concurrency model
of the payment path is exactly the risk the hotfix exists to avoid.

**Where the real fix lands.** `UNIQUE (mihpayid)` on
`donation_payment_details` (SPEC-1A section 5.6, in this work package). InnoDB
permits multiple `NULL`s in a unique index — unpaid donations have no
`mihpayid` — while any given PayU payment identifier can be recorded exactly
once. The second concurrent writer then fails with a duplicate-key error
instead of racing.

**This is why that index is a security control and not housekeeping.** Phase 3
must treat its duplicate-key error as a successful idempotent no-op, never as a
failure. `test/schema.test.js` asserts both halves of the behaviour: a duplicate
non-`NULL` value is rejected, and multiple `NULL`s are permitted.

---

## ADR-013 — The Phase 4 ETL must never use INSERT IGNORE or UPDATE IGNORE

**Status** Accepted — recorded for Phase 4, nothing built

The migration ETL must not use `INSERT IGNORE`, `UPDATE IGNORE`, or
`REPLACE INTO` under any circumstances.

**Why.** MySQL's `IGNORE` modifier downgrades errors to warnings and **skips the
offending row**. Applied to this schema that means:

- A `CHECK` violation — a zero-priced category, a zero-rupee donation, a second
  `branding_settings` row — becomes a warning and the row is silently dropped.
- A unique-index collision — the case-variant duplicate emails the ETL is
  specifically meant to surface (SPEC-1A section 8.1), or a duplicate
  `mihpayid` — is silently skipped.
- A foreign key violation — a donation pointing at a category that no longer
  exists (section 8.5) — is silently skipped.

Every one of those is a case where the load **must fail loudly**. Bad data being
dropped without a trace is far worse than a failed migration: the load reports
success, the row counts look plausible, and the missing donations are discovered
months later, if ever. For a financial record that is unacceptable.

**What to do instead.** Let the insert fail, and let the ETL abort. Pre-flight
every condition in SPEC-1A section 8 with a counting query first, report the
counts for a human decision, and only then load. The ETL's job is to surface
corruption, not to absorb it.

**One correction to section 8.2 while we are here.** It states that the `ENUM`
will reject mixed-case status values, so the ETL must normalise them or the load
fails. That is wrong — verified against mysql:8.4.11. `ENUM` assignment is
subject to the column's collation, and `utf8mb4_0900_ai_ci` is case-insensitive,
so `'approved'` is silently **canonicalised** to `'Approved'` (confirmed via
`HEX(status)`). An out-of-set value such as `'banana'` *is* rejected, with
`ERROR 1265`.

The consequence is the opposite of what section 8.2 assumed: the ENUM will
quietly repair the BUG-02 corruption rather than surface it. If its scale is to
be on record — and it should be, since it tells us how long the dashboard
counter has been wrong — the ETL must `COUNT` mixed-case values *before* insert
and report them explicitly. Nothing downstream will notice.

---

## ADR-014 — The drift gate needs two independent comparisons

**Status** Accepted

`Backend/db/check-drift.js` runs two comparisons and requires both to be clean:
a structural `prisma migrate diff` against the applied database, and direct
`information_schema` assertions for the invariants Prisma cannot express.

**Why both.** The structural diff alone is not a control. It was demonstrated
empirically: dropping `ck_donations_amount_positive` and re-running the gate
produced `structural diff clean` — Prisma cannot see CHECK constraints, so it
had nothing to report — while a zero-rupee donation was then accepted by the
database. A gate built on `migrate diff` alone would have passed that change.

The invariant half covers the four blind spots from ADR-002: the six CHECK
constraints, the per-column email collation, the table default collation, and
`ON UPDATE CURRENT_TIMESTAMP(3)`.

**Demonstrated, not asserted.** Each drift class was injected against a live
mysql:8.4.11 and the gate's exit code recorded, then the schema restored and the
gate confirmed clean again. The table-collation check in particular looks for
`utf8mb4_unicode_ci`, which is precisely what Prisma emits — it is the
fingerprint of a Prisma-generated migration having been applied.

**Consequences** The gate needs a live database, so it is a CI job
(`.github/workflows/schema.yml`) rather than a pre-commit hook. CI also applies
the hand-written Prisma migration to a *separate* database and re-runs the gate
against it, which is the only thing that would catch
`prisma/migrations/*/migration.sql` drifting away from `db/schema.sql` — the two
are duplicated by necessity, since Prisma requires migration SQL to live inside
the migration directory.

---

## ADR-015 — MySQL 8.4 removed the authentication plugin flag the spec prescribed

**Status** Accepted — **correction to SPEC-1A section 3.3**

`docker-compose.yml` passes `--authentication-policy=caching_sha2_password`, not
`--default-authentication-plugin=caching_sha2_password` as SPEC-1A section 3.3
specified.

**Why.** `--default-authentication-plugin` was deprecated in MySQL 8.0.27 and
**removed in 8.4**. On `mysql:8.4.11` it aborts startup with
`[ERROR] [MY-000067] unknown variable
'default-authentication-plugin=caching_sha2_password'`, and the container
crash-loops. The spec's own directive made the stack unstartable.

Found by running it. This is precisely the class of defect that no amount of
review catches and one `docker compose up` finds immediately — which is the
argument for the amended acceptance criterion requiring the stack to actually
come up.

`authentication_policy` is the replacement. `caching_sha2_password` is already
the 8.4 default, so the flag pins existing intent rather than changing
behaviour; it is kept explicit for self-hosters reading the compose file.

---

## ADR-016 — The MariaDB guard branch is unit tested, not integration tested

**Status** Accepted — with a stated gap

`Backend/db/require-mysql-version.js` exposes
`classifyServer(version, comment)` as a pure function, tested in
`Backend/test/server-guard.test.js` against real version strings captured from
live servers.

**Why not an end-to-end test.** A live MariaDB was started
(`11.8.9-MariaDB-ubu2404`) and the guard pointed at it. The guard did refuse and
exit 1 — but for the *wrong reason*: no authenticated connection could be
established from the host, so the failure came from the connection path rather
than from MariaDB detection. Since the version query never ran, the run proves
nothing about the detection logic.

**The honest position.** MariaDB does not slip through — an unreachable or
unidentifiable server is refused, and the refusal message states the
requirement. But the `mariadb` branch has not been exercised against a live
MariaDB server. Extracting the pure classifier gives that logic genuine
coverage, including the load-bearing case: MariaDB 10.x reports
`VERSION() = '10.11.6'`, which would classify as supported on version number
alone since 10 > 8, so detection depends on `@@version_comment`. That case is
tested explicitly.

**Consequences** If someone can get Prisma to authenticate against MariaDB, the
end-to-end path is worth confirming. Until then the connection-failure message
notes that an auth error does not rule MariaDB out.

---

## ADR-017 — Package A's hotfix does not appear on this branch

**Status** Accepted

`phase-1a-schema` is branched from `main` and contains none of the Package A
changes to `Backend/routes/payment.js`, `Backend/routes/auth.js` or
`Backend/app.js`. Those live solely on `hotfix/payment-and-reset`, also branched
from `main`.

**Why.** The two work packages have deliberately opposed scope rules — Package A
must modify route handlers, Package B must not touch them — and each rule
applies only on its own branch. Keeping them independent means the production
hotfix can be reviewed and merged on payment-security grounds alone, without
waiting on a schema review, and neither branch inherits the other's risk.

**Consequences** Both branches touch `Backend/package.json`, and both this
branch and the earlier documentation branch touch `.gitignore` and `README.md`.
Those conflicts are expected and textual; resolve them by taking both sets of
changes. Note in particular that the licence change to `Backend/package.json`
(ISC to GPL-3.0-only) belongs to the documentation branch and is deliberately
absent here — this branch adds only the Prisma dependency and scripts.

---

## ADR-018 — The Phase 4 ETL must count mixed-case status values before insert

**Status** Accepted — recorded for Phase 4, nothing built. **Replaces SPEC-1A
section 8.2.**

Section 8.2 assumed the `ENUM` would reject mixed-case `status` values, so the
ETL had to normalise them or the load would fail. ADR-013 removed that claim as
incorrect. This records the requirement that claim was protecting, because
removing it leaves a real gap.

**The gap.** MySQL does not reject `'approved'` — it silently canonicalises it
to `'Approved'` (ADR-013, verified via `HEX(status)`). So BUG-02's corruption
will **migrate invisibly**. The load will succeed, the row counts will
reconcile, and every trace of how much data BUG-02 damaged will be gone. The
database will no longer surface it, because the database will have quietly
fixed it.

**Requirement.** Before inserting anything, the ETL MUST count the mixed-case
values in the source collection and report them with counts. Against MongoDB
that is:

```js
db.donations.aggregate([
  { $group: { _id: '$status', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);
// and the same for paymentStatus
```

Anything whose `_id` is not exactly `Pending`, `Approved` or `Rejected` — a
lowercase variant, a stray value, `null`, a missing field — is a damaged row.
Report the full distribution, not just a total, and record it in the cutover
runbook.

**Why this matters beyond tidiness.** That count is the only remaining record
of BUG-02's blast radius. It tells us how many donations were mis-filed, and by
implication how long the admin dashboard's "approved" counter has been wrong
and by how much — which is a reporting-integrity question a donor-facing
organisation may have to answer. Once the ETL runs, the evidence is
unrecoverable.

Note also that the same reasoning applies to any value the ENUM would coerce
rather than reject. Count first, load second, always.

---

## ADR-019 — Strict SQL mode is a hard requirement, checked at startup

**Status** Accepted

`Backend/db/require-mysql-version.js` refuses to proceed unless **both**
`@@SESSION.sql_mode` and `@@GLOBAL.sql_mode` include `STRICT_TRANS_TABLES` (or
`STRICT_ALL_TABLES`, or the `TRADITIONAL` composite).

**Why.** Every ENUM guarantee in `db/schema.sql` depends on it. ADR-013
established that an out-of-set value such as `'banana'` is rejected with error
1265 — but that rejection is a *strict mode* behaviour, not an ENUM behaviour.
Verified against mysql:8.4.11 with `sql_mode = ''`:

```
INSERT ... status='banana', payment_status='nonsense'
  -> Warning 1265, NOT an error
  -> stored as '' / '', LENGTH(status) = 0
  -> SELECT ... WHERE payment_status = 'Paid'  finds nothing
  -> SELECT ... WHERE payment_status IN (all four valid values)  finds nothing
```

A donation then exists whose `payment_status` matches no filter. It is invisible
to the admin donation list, to the charts endpoint, to every report and to
reconciliation — while sitting in the table. That is BUG-02 and BUG-03
recreated exactly, by configuration rather than by code.

`STRICT_TRANS_TABLES` is a MySQL 8 default, so this is not a likely
misconfiguration in the bundled stack. But `sql_mode` is settable per server,
per session and per connection string, and once this repository is public NGOs
will run it against managed instances with provider defaults. An assumption
this load-bearing has to be checked rather than trusted.

**Both scopes are checked deliberately.** `SESSION` governs writes on the
connection doing the work; `GLOBAL` is what every *new* connection inherits,
including the application's pool, the Phase 4 ETL, and anyone at a `mysql`
prompt. A non-strict `GLOBAL` is a loaded gun even when this particular session
happens to be strict.

**Verified in both directions.** A MySQL 8.4.11 started with `--sql-mode=""` is
refused with exit 1 and an explanation; the default configuration passes. The
classifier `hasStrictMode()` is a pure function with unit tests, including that
it is not fooled by a substring such as `NOT_STRICT_TRANS_TABLES_X`.
`test/schema.test.js` asserts strict mode is active, and separately
*demonstrates* the dependency by relaxing `sql_mode` for one transaction,
retrying the same insert, and observing the empty string — then restoring
`sql_mode`, since it is a session variable and is not rolled back with the
transaction.

---

## ADR-020 — The licence decision is withdrawn and DEF-01 remains open

**Status** Accepted — supersedes the licence change previously made on the
documentation branch

The documentation branch briefly set both `package.json` files to
`GPL-3.0-only`, on the reasoning that `LICENSE` already contained the GPL v3
text and the manifests should agree with it. That change has been withdrawn.
`Backend/package.json` is back to `ISC` and the field added to
`Frontend/package.json` is removed, so that branch no longer touches licensing
at all.

**Why consistency was the wrong reason.** Making the manifests agree with
`LICENSE` looked like a tidy-up, but it had the effect of settling the licence
by default — and GPL-3.0 is probably the wrong choice for this project:

- **GPL-3.0 copyleft triggers on conveying**, i.e. distributing the code.
  Hosting a modified web application for network users is generally *not*
  conveying. A forker could therefore take KindLedger, modify it, run it as
  their own donation platform, and publish nothing. For software whose entire
  deployment model is "an NGO hosts it", that is close to no copyleft at all.
- **AGPL-3.0 section 13** is the clause that closes the gap, extending the
  source obligation to users who interact with the software over a network.
- **Neither protects the attribution footer.** "Powered by KindLedger" is a
  separate question, and a licence term forbidding its removal would not be
  open source by the OSI definition. That tension has to be resolved
  deliberately, not inherited.

**Consequences** The repository is currently inconsistent — GPL v3 text in
`LICENSE`, `ISC` in `Backend/package.json`, nothing in
`Frontend/package.json` — and that inconsistency is now deliberate and
documented in the README rather than silently resolved. No licence change is to
be merged until DEF-01 is decided together with the attribution question.
Anyone reading the repository in the meantime should treat its licensing as
unsettled.

---

## ADR-021 — PayU's `status` vocabulary, and why the production query is corroboration only

**Status** Accepted — closes A1

### The documented vocabulary (primary evidence)

From PayU's own documentation, fetched via the `llms.txt` index:

- **`status`** takes **`"success"` or `"failure"`**. Nothing else appears in the
  sample payloads for either the redirect callbacks or the webhooks. For refund
  webhooks it is likewise `"success"` or `"failure"`.
  Source: <https://docs.payu.in/docs/webhook-events-and-sample-payloads.md>
- **`unmappedstatus`** carries the gateway detail and has the wide vocabulary:
  `dropped, bounced, captured, auth, failed, usercancelled, pending`, plus
  `initiated`, `in progress` and `autoRefund` in the classification table. PayU
  maps those to Success / Failure / Pending itself.

So the mapped field the hotfix gates on has a two-value vocabulary, and every
messy value lives in the field the hotfix does **not** read. That is the right
way round: gating on `unmappedstatus` would have rejected `captured` and `auth`,
both of which PayU classifies as Success.

### The response hash formula matches the published spec exactly

Worth recording because it disposes of the original circularity objection from
a second, independent direction. PayU documents the reverse hash as:

```
sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
```

Source: <https://docs.payu.in/docs/hashing-request-and-response.md>

`verifyHash()` in `Backend/routes/payment.js` builds precisely that string,
field for field and delimiter for delimiter, and it uses `status` — not
`unmappedstatus`. The harness was self-consistent by construction, but the
formula it was consistent *with* is the documented one.

### Two documented variations the code does not support

PayU alters the formula in two cases:

- **`additional_charges`** is prepended: `additional_charges|SALT|status|...`
- **split transactions** insert `splitInfo` after `status`.

`verifyHash()` implements neither, so such a response would fail verification
and the donation would be redirected to the failure page with
`error=invalid_hash`. This is **pre-existing** and unchanged by the hotfix —
the same response failed verification before it. Neither feature is used by
`/initiate` today, so the practical risk is nil until someone enables one.
Phase 3 should either implement the variants or assert they are disabled on the
merchant account.

### Why the production aggregation is corroboration and not proof

`paymentDetails.status` is **not a clean record of what PayU sent**. Verified
against the hotfix branch:

| Handler | What it writes to `paymentDetails.status` |
|---|---|
| `/success` | **nothing — the field is never written** |
| `/failure` | `paymentData.status \|\| paymentData.STATUS \|\| 'failure'` |
| `/cancel` | `paymentData.status \|\| paymentData.STATUS \|\| 'cancelled'` |
| `/webhook` | `paymentData.status` — verbatim, no fallback |

Three consequences:

1. **The successful population is invisible.** `/success` writes a
   `paymentDetails` object containing only `mihpayid`, `amount`, `mode`,
   `bank_ref_num` and `paymentDate`. Every donation whose last writer was
   `/success` has no `paymentDetails.status` at all. That is precisely the
   population whose vocabulary mattered most.
2. **`'failure'` and `'cancelled'` are contaminated.** Those exact strings are
   our own hardcoded fallbacks, indistinguishable in the data from PayU having
   sent them.
3. **Only `/webhook` rows are authoritative** — and only where the webhook ran
   last, since `/success` overwrites the whole subdocument and drops the field.

So the query is partly circular and blind exactly where it counts. It can still
*corroborate* — an unexpected value appearing there would be real evidence of a
value outside `{success, failure}` — but it cannot establish the vocabulary,
and its silence proves nothing. The documented set is the primary evidence.

### Follow-up for Phase 3

`/success` should write `paymentDetails.status` verbatim from the payload, and
the hardcoded `'failure'` / `'cancelled'` fallbacks in `/failure` and `/cancel`
should be dropped in favour of storing exactly what arrived, or nothing.
Without that, the system cannot ever be asked what PayU actually sends.
Deliberately not done in the hotfix: it changes stored data shape and is not
needed for the security fix.

### Also noted, pre-existing and out of scope

`/webhook` switches on `paymentData.status?.toLowerCase()` with cases for
`'pending'`, `'in progress'`, `'cancelled'` and `'cancel'`. Per the
documentation those values belong to `unmappedstatus`, not `status`, so those
branches are most likely unreachable and the webhook can never record a Pending
state from a `status` value alone. Phase 3 should read `unmappedstatus` for that
purpose. Unchanged by the hotfix.

---

## ADR-022 — The Phase 4 ETL must re-check strict SQL mode in its own preflight

**Status** Accepted — recorded for Phase 4, nothing built

The C3 guard (`Backend/db/require-mysql-version.js`, ADR-019) checks
`sql_mode` at **boot**, in both `SESSION` and `GLOBAL` scope. That leaves a
residual gap: `sql_mode` is settable at runtime.

A managed provider — or an administrator — changing `GLOBAL sql_mode` after the
API has started is **undetected until the next restart**. A long-running API
process would keep its own strict `SESSION` mode, so its own writes stay safe,
while every *new* connection quietly inherits the relaxed global. The ETL is
exactly such a new connection.

**Requirement.** The ETL must re-check strict mode in its own preflight,
immediately before it begins loading, rather than relying on the API's boot
check. It must check the mode on **its own connection**, because that is what
governs its own inserts.

The stakes are higher for the ETL than for the API: it performs the single
largest write in the project's life, and under a relaxed mode every out-of-set
`status` value in ten years of legacy data would be silently stored as the
empty string (ADR-019) instead of failing the load. That is the one moment where
this misconfiguration would do maximum, irreversible damage.

Reuse the exported `hasStrictMode()` helper rather than reimplementing the
parse.

---

## ADR-023 — PayU's verify_payment API is the strongest SEC-01 fix, for Phase 3

**Status** Accepted — recorded as a Phase 3 candidate, deliberately not in the
hotfix

The hotfix trusts the callback's **signed** `status`, having verified the hash.
That is a large improvement on trusting the callback's mere arrival, but it is
still trust in a payload delivered through the donor's browser.

PayU exposes a **`verify_payment`** API for authoritative transaction status.
The strongest form of the SEC-01 fix does not trust the callback's status at
all: on receiving a callback it calls PayU server-to-server with the `txnid` and
marks the donation according to PayU's own answer. The callback becomes a
notification that something happened, not evidence of what happened.

**Why this is strictly better.** It removes the browser from the trust path
entirely. Even granting a signed payload, the current design depends on the
salt staying secret and on the hash formula being implemented correctly — and
ADR-021 notes two documented formula variants the code does not implement. A
server-to-server confirmation is immune to all of that.

**Why not now.** It adds an outbound HTTP dependency inside the callback path,
which needs timeout handling, retry policy, and a decision about what to do
when PayU is unreachable mid-callback. Getting that wrong turns a payment-
recording bug into a payment-recording outage. That is not a change to make in
a hotfix whose purpose is to stop a live exploit.

**Phase 3 shape.** Verify asynchronously — record the callback, mark the
donation from the signed status as now, then reconcile against
`verify_payment` out of band and alert on any disagreement. That keeps the
donor's redirect fast while making the money trail authoritative. It also gives
the reconciliation job the security review asked for.

---

## ADR-024 — Open questions in the payment callback design, for Phase 3

**Status** Accepted — recorded for Phase 3, nothing built

Three findings that fall out of ADR-021's documented vocabulary. None is fixed
in the hotfix; all three need deciding in Phase 3.

### 1. It is unclear how a donation legitimately reaches `Cancelled`

`paymentStatus` carries a `Cancelled` member, and `/cancel` is the only handler
that writes it. But PayU's `status` vocabulary is `success` or `failure` only
(ADR-021) — there is no cancel value. A user cancellation arrives as
`status=failure` with `unmappedstatus=usercancelled`.

So `Cancelled` is only reachable if PayU actually posts to the configured
`curl`. Verified by test that the handler *accepts* such a payload — a
realistic cancellation (`status=failure`, `unmappedstatus=usercancelled`) sent
to `/cancel` is accepted and marked `Cancelled`, and the same payload sent to
`/failure` is accepted and marked `Failed`. Both paths work. What is *not*
established is which one PayU uses.

**Phase 3 must establish whether PayU posts to `curl` at all.** If it does not,
`/cancel` is dead code, every cancellation lands at `/failure` as `Failed`, and
`paymentStatus.Cancelled` is a state nothing writes. An enum member that no code
path can produce is worse than absent: it shows up in filter dropdowns, invites
reports that always return zero, and implies a distinction the data does not
make. Either confirm `curl` fires and keep the state, or drop it and migrate the
existing rows.

Note the schema in `db/schema.sql` retains `Cancelled` deliberately: whatever
the answer, historic MongoDB rows already carry it and the ETL must be able to
load them.

### 2. `/success` destroys `paymentDetails` written by the webhook

A genuine data-loss bug, independent of the observability gap in ADR-021.

`/success` assigns a whole new object to `paymentDetails`:

```js
paymentDetails: { mihpayid, amount, mode, bank_ref_num, paymentDate }
```

Mongoose replaces the entire subdocument. If `/webhook` ran first — it writes
`status`, `error_Message` and a real `paymentDate` — then `/success` arriving
afterwards **wipes those fields**. The two callbacks race (ADR-012), so which
one lands last is not under our control.

The fix is a field-level update (`$set` on individual paths) rather than
replacing the subdocument, so the two writers merge instead of clobbering. Not
done in the hotfix: it changes write semantics on the payment path, and the
hotfix's job was to stop the exploit.

### 3. `unmappedstatus` is not covered by the response hash

Worth recording as a security fact, because it settles the field choice
permanently. PayU's documented reverse-hash formula is:

```
sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
```

`unmappedstatus` does not appear in it. It is therefore **unsigned and
attacker-mutable** — a donor can edit it in the payload their own browser
posts, and the hash still verifies.

So gating on `unmappedstatus` would not merely have been wrong about the
vocabulary (rejecting `captured` and `auth`, which PayU classifies as Success).
It would have moved the security decision onto an unauthenticated field. Any
Phase 3 work that reads `unmappedstatus` — for the Pending classification, say
— must treat it as untrusted detail, never as the authority for a state
transition. `status` is the signed field and must remain the gate.

---

## ADR-025 — `gateway_status` will be NULL for the entire paid population at cutover

**Status** Accepted — recorded for the Phase 4 verification harness

`donation_payment_details.gateway_status` holds PayU's raw status string.
Because `/success` never writes `paymentDetails.status` (ADR-021), that column
will be **NULL for every migrated donation whose last writer was `/success`** —
which is essentially the entire successfully-paid population.

`db/schema.sql` section 5.6 already declares the column nullable, so the schema
holds and the load will not fail. The requirement is on the **verification
harness**: it must not treat NULL `gateway_status` as a load failure or as
evidence of a dropped field. For the paid population, NULL is the expected and
correct outcome, and a harness that flags it will generate noise proportional to
the entire donation history.

What the harness *should* assert instead:

- **`mihpayid` is populated** for paid donations. `/success` does write it, so
  the SEC-01 replay guard has data to work with and the unique index is
  meaningful from day one. A paid donation with a NULL `mihpayid` is a genuine
  anomaly worth flagging.
- **`gateway_status` is populated where it was present in the source**, i.e.
  for rows the webhook wrote last. Those are the only rows that carry it.
- The **count** of paid donations with NULL `gateway_status` should be reported
  as an expected figure, not an error — it quantifies how much of the paid
  history has no gateway record, which is useful context for any future
  reconciliation against PayU's dashboard.

After the E5 observability fix lands, newly written rows will carry the field,
so this gap is bounded to donations recorded before that change.
