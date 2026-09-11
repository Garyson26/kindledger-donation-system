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

**Amended by SPEC-2 section 0.2 (Phase 2). The gating is removed.** Both
`profiles: ["app"]` keys are gone from `docker-compose.yml` and the api
healthcheck is now a real request:
`curl --fail --silent http://127.0.0.1:5000/api/health`.

The three reasons the gate existed have each been answered, and it is worth
being precise about which, because two of them were answered and one was
side-stepped:

| Reason for the gate | What changed |
|---|---|
| `config/db.js` exits on an unreachable database | **Answered.** `config/prisma.js` reports failure through a return value instead (ADR-039). `config/db.js` is untouched and still exits — see the consequence below. |
| `/api/health` does not exist | **Answered.** `Backend/routes/health.js` (ADR-038). |
| Section 1 forbids touching routes or middleware | **Side-stepped, deliberately and narrowly.** SPEC-2 keeps the fence and names one exception: a new route file that imports no Mongoose. Nothing under `Backend/middleware/` was touched at all. |

**Consequence, and it is the one to carry into Phase 3.** `MONGODB_URI` is still
passed to the api container, because the additive model leaves Mongoose serving
every existing route. So the container starts on its own merits *only while that
variable is present and valid*: `config/db.js:process.exit(1)` is still there,
still reachable, and still the reason a bad Mongo credential produces an exited
container rather than an unhealthy one. Acceptance criterion 1 is now met for
real, but by supplying Mongo rather than by no longer needing it. Phase 3 closes
this properly when it deletes `config/db.js`.

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

**Status** Accepted, but its conclusion is **SUPERSEDED BY ADR-026**. The race
described below is real and still unfixed. The claim that `UNIQUE (mihpayid)`
is where the real fix lands is WRONG: `mihpayid` is not covered by PayU's
response hash, so it is attacker-mutable and cannot be a security boundary.
Read ADR-026 for the corrected rationale.

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

---

## ADR-026 — Only hashed PayU fields may carry a security decision

**Status** Accepted — **corrects SPEC-1A section 5.6 and supersedes the
conclusion of ADR-012**

### What is actually signed

PayU's documented reverse hash covers exactly these fields:

```
sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
```

So the signed set is: **`status`, `udf1`–`udf5`, `email`, `firstname`,
`productinfo`, `amount`, `txnid`** (plus the key and salt, which are ours).

**Every other field in the callback is unsigned and attacker-mutable**, because
the payload arrives as a form POST through the donor's own browser. That
includes `mihpayid`, `mode`, `bank_ref_num`, `net_amount_debit`, `addedon`,
`error_Message`, `phone`, `unmappedstatus`, and the `fieldN` values. A donor can
edit any of them and the hash still verifies.

### The correction

SPEC-1A section 5.6 claimed the `UNIQUE` index on
`donation_payment_details.mihpayid` was the SEC-01 replay defence. **That was
wrong.** ADR-012 repeated the error, saying the index was "where the real fix
lands". Both are corrected here.

`mihpayid` is unsigned, so an attacker can:

- **vary it freely** on each replay, so uniqueness never trips and the index
  stops nothing; or
- **collide it deliberately** with a value already recorded, so a *legitimate*
  payment fails to record — the index becomes a denial-of-recording tool
  pointed at other donors.

### What actually defends against replay

The **donation state transition**, keyed on signed fields only:

1. `verifyHash()` establishes the payload came from PayU.
2. The signed `status` must match the endpoint (`success` at `/success`; not
   `success` at `/failure` and `/cancel`).
3. The donation is identified by `udf4` — signed — and cross-checked against the
   signed `amount` in integer minor units.
4. A donation whose `paymentStatus` is already `'Paid'` is not re-processed.

Every input to that chain is inside the hash. The Package A hotfix implements
it, and it is the load-bearing control.

Verified for F2: the amount comparison reads `paymentData.amount`, the signed
field, **not** `net_amount_debit`, which is never referenced anywhere in the
codebase.

### What the index is still for

Keep it. It is a **data-integrity control and a secondary defence**: it stops
the same gateway payment identifier being recorded against two different
donations, which catches double-processing by our own code or by a retrying
webhook — neither of which is adversarial. That is a real property worth
having. It is simply not a security boundary.

`Backend/test/schema.test.js` still asserts the index exists, rejects a
duplicate non-`NULL` value, and permits multiple `NULL`s. Those assertions are
unchanged and still correct; only the stated rationale was wrong.

### The standing rule

**Phase 3 must not build any security decision on an unsigned field.** When a
handler needs gateway detail — the Pending classification from
`unmappedstatus`, say — it may *record* it, but the state transition must key on
the signed set above.

One incidental property worth knowing: `verifyHash()` reads only the canonical
lowercase field names, so the alternate-case fallbacks scattered through the
handlers (`paymentData.AMOUNT`, `.STATUS`, `.TXNID`, `.MIHPAYID`, and
`udf_4` / `udf[4]`) are unreachable with a valid hash — a payload lacking the
lowercase form hashes a different string and is rejected before those
fallbacks are consulted. They are dead code rather than a hole. But that
safety is incidental, not designed: adding an uppercase variant to
`verifyHash()` would make them live. Phase 3 should delete them.

---

## ADR-027 — Unsigned PayU fields are persisted and rendered: treat as untrusted at every sink

**Status** Accepted — standing constraint

`error_Message`, `mode` and `bank_ref_num` are **attacker-controlled text**
(ADR-026) that the callbacks persist verbatim to the database and that then
appears in admin views and donation receipt PDFs. `failureReason`, taken from
the equally unsigned `fieldN` values, is in the same category.

The path is: donor edits the field in the callback their browser posts → hash
still verifies because the field is not covered → stored verbatim → rendered.

**Not exploitable today**, and that is worth stating precisely rather than
implying a live hole: React escapes interpolated text by default, and the
security review found no XSS sinks anywhere in the frontend — no
`dangerouslySetInnerHTML`, no `innerHTML`, no `eval` — and the frontend CSP
sets `script-src 'self'` with `object-src 'none'`.

**The risk is that none of those protections are properties of the data.** They
are properties of one particular render path. The moment the same text reaches
a sink that does not escape, it becomes live:

- **jsPDF is not React.** `Backend`-generated and client-generated receipt PDFs
  draw these strings directly. PDF is a scripting-capable format.
- **A CSV export is not React.** A value beginning `=`, `+`, `-` or `@` is a
  formula-injection vector in Excel and Sheets, which is the obvious next
  request for an admin donation report.
- **An email template is not React.** The OTP and receipt emails build HTML by
  string interpolation. `config/email.js` escapes the fields it knows about;
  a template that later interpolates `errorMessage` would not be covered
  unless the author remembered.

**The constraint.** Treat every non-hashed PayU field as untrusted input **at
each render site**, not once at ingest. Escaping at ingest is the wrong layer:
the correct escaping differs per sink — HTML entities for email, formula
prefixing for CSV, plain-text coercion and length capping for PDF — and a
single ingest-time transform would be wrong for at least two of them.

Practical measures for Phase 3, in order of value:

1. Length-cap these fields on write. The schema already bounds them
   (`VARCHAR(500)` / `VARCHAR(1000)`), which limits the blast radius.
2. Escape or neutralise per sink, at the sink.
3. Prefix a leading `=`, `+`, `-` or `@` with `'` in any CSV export.
4. Never interpolate them into an HTML email without passing through the
   existing `escapeHtml()` helper.

---

# Phase 2 (SPEC-2) — additive MySQL data layer

Everything below was decided while executing SPEC-2. ADR-028 to ADR-037 are on
the `docs/incident-j1-j6` branch and are not yet merged, so this file currently
reads 027 then 038. **That gap is a merge-order dependency, not a numbering
error** — see ADR-046.

---

## ADR-038 — `routes/health.js` is the named exception to the routes fence, and it uses a shared secret rather than `adminAuth`

**Status** Accepted

SPEC-2 section 1 forbids modifying files under `Backend/routes/`. Section 2
names one exception: a new file, `Backend/routes/health.js`. It is added.

**Why the exception is not a hole in the fence.** The fence exists to stop
Phase 2 editing the six route files that consume Mongoose, because an additive
phase that quietly rewires a live route stops being additive. A *new* file that
imports only the new data layer creates none of that coupling. The property the
fence protects is "no existing route changed behaviour", and this file cannot
change any existing route's behaviour because nothing routes to it yet except
the compose healthcheck.

**Why a shared secret and not `adminAuth`.** SPEC-2 section 5 permits either.
`adminAuth` does `User.findById(...)` on a Mongoose model. Importing it into
`routes/health.js` would pull the old data layer into the one file whose purpose
is to demonstrate the new one works — and would mean a Mongo outage made the
MySQL health check unauthenticatable. The secret is compared with
`crypto.timingSafeEqual` and refused outright if it is shorter than 16
characters, so an unset or placeholder `HEALTH_DIAGNOSTIC_SECRET` fails closed
to the unauthenticated form rather than opening the diagnostics.

**The unauthenticated response carries a status string and nothing else.** Not
the error, not the latency, not whether Redis is configured, not the pool size.
An open endpoint that reports connection state tells an attacker exactly when
the database is down, which is when everything else is most likely to fail open.
`200`/`503` is all a load balancer needs.

**Consequences** Phase 3 may replace the secret with `adminAuth` once
`adminAuth` no longer touches Mongoose. Until then, whoever operates the stack
has one more secret to manage. The diagnostic form also reports `req.ip` and the
`X-Forwarded-For` it received, which is what makes the trust-proxy test in
ADR-043 observable end to end; that pair is behind the secret because together
they disclose the deployment's proxy-hop count.

---

## ADR-039 — Infrastructure failure is reported through a return value; the data layer never calls `process.exit`

**Status** Accepted

`Backend/config/prisma.js` has no `process.exit` anywhere in it, and says so in
a comment so the omission does not read as an oversight. `checkDatabase()`
returns `{ok, error, latencyMs}`. An unreachable database produces a `503` from
`/api/health` and an unhealthy container.

**Why.** `Backend/config/db.js` calls `process.exit(1)` when Mongo is
unreachable. On Vercel that is the direct cause of the
`FUNCTION_INVOCATION_FAILED` shape production has been in: the process dies
before it can answer, so every route returns a platform error with no
application log line, and the failure is indistinguishable from a code fault. In
a container it is worse, because `restart: unless-stopped` turns it into a
crash loop that buries the original error in restart noise.

A process that stays up and reports "the database is unreachable" is
diagnosable. A process that exited is a guess.

**This is a deliberate asymmetry, not consistency for its own sake.** The two
files now behave differently on the same class of failure, and that is the
intended state for the duration of the additive phase. `config/db.js` was not
touched: SPEC-2 section 1 fences it, and changing Mongo's startup behaviour
mid-migration would alter live production semantics for no Phase 2 benefit.

**Consequences** Anything added to this layer later inherits the rule. The tests
enforce it rather than trusting it: `data-layer.test.js` runs `checkDatabase()`
against a dead port **in a child process** and asserts the child exits `0`
having printed a verdict. If someone reintroduces the exit, that test fails
rather than the runner dying silently. The same reasoning drives the Redis
`'error'` handler in ADR-042 — an unhandled `'error'` event is `process.exit`
by another name.

---

## ADR-040 — Money and identifiers cross the repository boundary as plain JavaScript values, and the conversion refuses rather than rounds

**Status** Accepted

Every value a repository returns is a plain JS value. `BIGINT` columns come back
as `Number` via `fromBigInt()`; the external identifier is the `CHAR(36)` uuid,
exposed as `id`. The internal `BIGINT` primary key is never returned, and
`toMinorUnits()` is the only place a decimal string becomes minor units.

**Why not just return what Prisma returns.** Prisma maps `BIGINT` to `BigInt`,
which `JSON.stringify` throws on. Every route would need its own conversion, and
the first one that forgot would produce a `500` on a page that renders an amount
— discovered in production, on the receipt.

**Why `fromBigInt` throws instead of clamping.** Beyond
`Number.MAX_SAFE_INTEGER` a silent conversion loses the low digits of an amount.
A `RangeError` on a value that large is the correct outcome: it cannot be a real
donation, so it is either corruption or an attack, and both deserve a stack
trace rather than a plausible-looking number.

**Why `toMinorUnits` returns `null` for malformed input rather than `0`.** It
parses digit-wise from the string rather than multiplying a float, because
`1500.07 * 100` is `150006.99999999999`. Inputs it will not accept — more than
two decimal places, exponent notation, negatives, empty — return `null`. A
caller that treats `null` as `0` accepts a payment of nothing, which is at least
loud; returning `0` directly would make that silent. Phase 3 route code must
check.

**Why the internal key stays hidden.** Exposing a sequential `BIGINT` in an API
is an enumeration primitive: donation `#4102` implies `#4101` exists. The uuid
carries no such information, and `legacy_id` keeps the old ObjectIds resolvable
for receipts issued before the migration.

**Consequences** This is the seam. Phase 3 imports `Backend/repositories/` and
not `@prisma/client`, so a later ORM change stays behind this boundary. Calling
`getPrisma()` from a route defeats the point; it is exported for the health check
and the scheduler only, and labelled as such.

---

## ADR-041 — `distinct()` keeps DATA semantics, not enum semantics

**Status** Accepted

`donations.listPaymentStatusesInUse()` and `listStatusesInUse()` issue a
`distinct` query against the table. They do **not** return the ENUM's member
list.

**Why this needs writing down.** Returning the enum members is the obvious
implementation once the column is an ENUM: it is a compile-time constant, needs
no query, and produces a superset of the right answer. It is wrong. Mongoose's
`Donation.distinct('paymentStatus')` answered "which statuses exist in your
data". The enum answers "which statuses are theoretically possible". The values
feeding the admin filter dropdown would change from the first to the second, and
the filter would stop being able to show that, for instance, nothing has been
Cancelled all year — every option would always be present, and every option
would be selectable into an empty result.

That is a visible behaviour change in the admin UI, produced by a data-layer
refactor, with no line of route code altered. Exactly the class of regression an
additive phase is supposed to make impossible.

**Consequences** Two queries where a constant would do, on an indexed column.
Accepted. The test asserts the data semantics by construction: the fixtures
create only `Pending` and `Paid` rows, so a result containing all four members
would mean the enum was being read.

---

## ADR-042 — The Redis rate-limit store is built but not wired, so SEC-04 is NOT closed by this phase

**Status** Open — SEC-04 remains open

`Backend/config/rateLimiters.js` provides a Redis-backed limiter factory with
`authLimiter` at the same 5-per-minute budget as the live one. **Nothing imports
it.** The limiters actually in force are still the ones declared in
`Backend/routes/auth.js`, which SPEC-2 section 1 fences off.

**So SEC-04 is not closed.** The store existing and the store being used are
different claims, and only the second one closes the finding. Recorded
explicitly because "Redis rate limiting added" is how this would otherwise be
summarised in a changelog, and the next person to read that summary would
reasonably believe the finding was fixed. It closes when Phase 3 swaps the
import in `routes/auth.js`.

**Why parity on the numbers matters.** The new `authLimiter` is 5 per minute
because the old one is. A phase that silently tightened the limit would be
indistinguishable, from the outside, from a phase that broke something.

**Why the memory fallback is deliberate.** With `REDIS_URL` unset the limiters
use `express-rate-limit`'s memory store and announce
`[rateLimiters] store=memory (single replica only)` at boot. A self-hosting NGO
running one container should not be required to operate Redis, and one
long-lived process with a memory store already fixes most of what was broken on
Vercel — where each concurrent function instance had its own counter and a
cold start reset it, so an attacker with concurrency got five attempts *per
instance*. The memory store is correct for one replica and wrong the moment
there are two, which is why it warns rather than staying quiet.

**The `'error'` handler is load-bearing.** `node-redis` emits `'error'` on a
failed connection; unhandled, that is an uncaught exception and the process
dies, reintroducing precisely the behaviour ADR-039 exists to remove. The
handler logs, and the limiter degrades instead.

---

## ADR-043 — Nginx overwrites `X-Forwarded-For` with `$remote_addr`, and the `set_real_ip_from` block is removed

**Status** Accepted — **fixes a spoofing hole found during this phase**

Two changes in `docker/nginx/`:

1. `kindledger-proxy.conf` now sets
   `proxy_set_header X-Forwarded-For $remote_addr;` — previously
   `$proxy_add_x_forwarded_for`.
2. The `set_real_ip_from` / `real_ip_header` / `real_ip_recursive` block in
   `nginx.conf` is deleted, left commented for a future CDN deployment.

**The hole.** The removed block trusted `172.16.0.0/12`. The Docker bridge
gateway address sits inside that range. `real_ip_header X-Forwarded-For` with a
trusted source means Nginx *replaces* `$remote_addr` with the client-supplied
header value — so any request whose source address fell in the bridge range
could name its own client IP, and Nginx would believe it and pass it upstream as
authoritative. That covers host-local and inter-container traffic, and on a host
whose Docker network is reachable it is a straightforward rate-limit and
audit-log bypass: pick a fresh `X-Forwarded-For` per request and the `limit_req`
zone, keyed on `$binary_remote_addr`, never sees the same client twice.

**Why overwrite rather than append.** `$proxy_add_x_forwarded_for` appends to
whatever the client sent, so a request carrying `X-Forwarded-For: 1.2.3.4`
reaches Express as `1.2.3.4, <real>`. With `trust proxy: 1` Express takes the
last entry, which *is* correct — but correct by arithmetic. It stops being
correct the moment the hop count and the header disagree, and the hop count is a
deployment property that changes the day someone puts a CDN in front.
`$remote_addr` discards the client value outright, so `trust proxy: 1` is right
for a structural reason instead of a numerical one.

**How it is proved, and why the previous proof was not one.** Package A's test
set `X-Forwarded-For` directly on a request to Express with no proxy in front.
That shows Express *reads* the header; it cannot show Express reads it *safely*,
because the test passes identically whether the deployment discards a
client-supplied value or trusts it. `Backend/test/trust-proxy.test.js` therefore
issues its requests from throwaway containers on the compose network, through
the real Nginx, and asserts both halves: the spoofed value is absent from what
the app resolves *and* from the header it received, and two concurrently running
containers resolve to two distinct addresses. The second assertion is what makes
the first meaningful — if every client collapsed to the proxy's own address
the spoof would also be discarded, and five bad logins from anywhere would lock
out the world.

**Consequences** If a CDN or a second proxy is ever placed in front of Nginx,
both the commented block and `app.set('trust proxy', 1)` must be revisited
together. Uncommenting one without the other silently restores this hole.

---

## ADR-044 — The scheduler is double-guarded, and is deliberately not pointed at MongoDB

**Status** Accepted

`Backend/services/scheduler.js` registers two jobs — the ten-year retention
purge (BUG-04) and the hourly pending-signup expiry sweep, which replaces
MongoDB's TTL index. Registration requires `SCHEDULER_ENABLED=true`, and the
default is off.

**Why they are not pointed at MongoDB.** They are inert until Phase 4 loads
data, and that is correct rather than a limitation. Live data is still in Mongo,
so these jobs run against empty MySQL tables and delete nothing. Writing Mongo
versions would produce code thrown away at cutover, and would put a
*destructive* scheduled job against live production data into a phase whose
entire premise is that it does not touch live production data.

**Why the flag.** Without it, a Phase 3 deployment that shipped before the Phase
4 migration would begin deleting rows from a partially populated database on its
first 02:00 tick. An operator turns it on once, deliberately, after cutover.

**Why the purge takes `dryRun`.** BUG-04 means the retention purge has *never
executed*: it was declared as a Vercel cron against
`POST /api/admin/cleanup/trigger`, which sits behind `adminAuth`, so the cron
received a `401` every day. The first real run will therefore delete a decade of
accumulated rows in a single pass, and nobody currently knows how many that is.
The first post-migration run must be `dryRun: true`.

**Why the sweep is hourly and the purge daily.** The TTL index being replaced
was continuous. A daily sweep would let a pending signup — a row holding a
name, an email and a bcrypt hash — outlive its stated 24-hour lifetime by up
to a further day, which is a retention problem rather than a tidiness one.

**Consequences** Both jobs wrap their body in `try`/`catch`: a failed scheduled
job logs and the process survives, per ADR-039. Timezone is `Asia/Kolkata`,
matching the original `dataCleanupService.js` declaration.

---

## ADR-045 — `Backend/controllers/authController.js` is deleted — recorded as a finding, not as housekeeping

**Status** Accepted

The file is removed. A grep for `authController` across the repository returns no
importers; the result is stated in the Phase 2 report.

**Why this is a finding rather than a tidy-up.** It was not an unused stub. It
held a parallel implementation of signup and login — its own bcrypt hashing,
its own token issuance — sitting beside the live one in
`Backend/routes/auth.js`, unreferenced and unmaintained. And the copy was not
merely stale, it was **vulnerable**:

1. **Privilege escalation by mass assignment.** Its signup handler read
   `const { name, email, password, role } = req.body` and passed `role`
   straight into `new User(...)`. Any client could have registered itself as
   `admin` by adding one field to the request body. This is the substantive
   finding; the rest follows from it.
2. **No verification gate and a weaker hash.** It issued a usable account with
   no OTP step — bypassing the `PendingSignup` flow entirely — and hashed
   at bcrypt cost 10 against the live path's 12.
3. **It is a plausible target for a future wiring mistake.** A file named
   `authController.js` in a `controllers/` directory looks like the canonical
   place auth lives. Someone adding a route reasonably reaches for it, and gets
   that posture rather than the live one. None of the Package A hardening
   (SEC-01, SEC-02, SEC-04) was ever applied to it.
4. **It cost the security review real effort.** Every audit of the auth surface
   had to establish, again, that this copy was unreachable before it could
   discount the escalation path.

**It was not exploitable as it stood.** Nothing routed to it, so the escalation
required someone to wire it up first. That is what made it a latent defect
rather than an incident, and it is also exactly why deleting it is the fix:
leaving it with a warning comment relies on the next reader trusting the comment
more than the code.

`for_ocean_security_review.md` had already called for its deletion. Phase 2 is
simply the first work package with a legitimate reason to touch the file.

**Consequences** None at runtime — nothing imported it, and the
`Backend/controllers/` directory is now empty and removed with it. Recorded here
so the deletion is not mistaken for scope creep in the Phase 2 diff, and so the
reason survives beyond the commit message.

---

## ADR-046 — Phase 2 is branched from `chore/dependency-cleanup`, not from `main`, and the ADR numbering records a merge-order dependency

**Status** Accepted — **deviation from SPEC-2's stated baseline**

SPEC-2 states the baseline is `main`. The `phase-2-data-layer` branch is based
on `chore/dependency-cleanup` (`74d6c33`), which is itself based on `main`
(`58bdadf`).

**Why.** This phase must add `rate-limit-redis`, which means committing a
regenerated lockfile. Generating one on `main` would bake in the five unused
packages that `chore/dependency-cleanup` deletes, and the next merge of that
branch would then conflict on the lockfile in the least tractable way. Basing
Phase 2 on the cleanup produces one coherent lockfile instead of two competing
ones.

**Consequence: merging Phase 2 carries the dependency cleanup with it.** That is
not hidden, but it does mean the Phase 2 pull request is larger than its title
suggests, and the cleanup gets whatever review Phase 2 gets.

**Second consequence: this file has a ten-ADR gap.** ADR-028 to ADR-037 exist
only on `docs/incident-j1-j6`, which is unmerged. Phase 2 code cites two of them
— `repositories/pendingSignups.js` cites ADR-033 (duplicate index
declarations) and `repositories/users.js` cites ADR-034 (a correct reset code
must not clear the attempt counter). Those citations are dangling on this branch.

**So the merge order is: `docs/incident-j1-j6` first, then
`phase-2-data-layer`.** Reversed, `docs/decisions.md` ships reading 027 then
038, with two citations pointing at records that do not exist yet. Numbering
Phase 2 from 028 instead would have been worse: it would produce ten genuine
duplicate ADR numbers the moment both branches landed.

---

## ADR-047 — MongoDB is still required to boot, and it is supplied by a named override rather than by the deployment topology

**Status** Accepted — **transitional; delete at the Phase 3 cutover**

`docker-compose.legacy-mongo.yml` adds a throwaway `mongo:7` service and points
the api container at it. It is layered explicitly:

```
docker compose -f docker-compose.yml -f docker-compose.legacy-mongo.yml up
```

**Why it is needed at all.** ADR-006's amendment removed the profile gating on
the strength of three things being fixed. Two were fixed properly. The third was
not: `Backend/config/db.js` still calls `process.exit(1)` when it cannot reach
Mongo, and SPEC-2 section 1 fences that file. Because the migration is additive,
Mongoose still serves every existing route, so `connectDB()` still runs at boot.

The consequence is precise and worth stating plainly: **an absent or invalid
`MONGODB_URI` produces an EXITED api container, not an unhealthy one.** The
healthcheck never gets a chance to answer, so the failure looks like the
`FUNCTION_INVOCATION_FAILED` shape rather than like a database being down. That
is the exact behaviour ADR-039 removes from the new layer, still present in the
old one, and not fixable inside this phase's fence.

So SPEC-2's acceptance criterion — four services up, healthcheck passing —
is satisfiable only with a reachable MongoDB. Requiring production Atlas
credentials to watch the stack come up would be wrong on its own terms, and
those credentials are in any case currently rejected (`bad auth`).

**Why it is not in `docker-compose.yml`.** That file is the deployment topology,
and MongoDB is the thing this migration exists to remove. A `mongo` service in
it would put the source database permanently into the architecture diagram, and
the next reader would reasonably conclude the target system runs both. An
override that has to be named on the command line cannot be mistaken for the
target state.

**The container is deliberately austere.** No credentials, no volume, no
persistence. Each of those would imply the data is worth keeping, and under the
additive model nothing in Phase 2 writes to Mongo at all — it exists so that
`connectDB()` returns.

**Consequences** Anyone running the plain `docker compose up` without a
`MONGODB_URI` gets an exited api container, which is why `.env.example` now
carries the warning at the top rather than buried in a variable comment.

---

**AMENDMENT (AA2, accepted). SPEC-2 section 9 is amended at source.**

The conflict was in the spec, not in the implementation: section 1 fenced
`config/db.js`, section 9 required four healthy services, and `config/db.js`
exits without Mongo. Those cannot both hold. Same shape as the SPEC-1A
contradiction ADR-006 handled.

Section 9's acceptance criterion now reads:

> Four healthy services **with `docker-compose.legacy-mongo.yml` applied**:
>
> ```
> docker compose -f docker-compose.yml -f docker-compose.legacy-mongo.yml up
> ```

**DELETING `docker-compose.legacy-mongo.yml` IS A PHASE 3 EXIT CRITERION, NOT A
CLEANUP ITEM.** Phase 3 is not complete while it exists. It is not a tidiness
task to be carried into Phase 4 with the other leftovers, and it must not
quietly persist past cutover.

The distinction matters because a cleanup item that survives is untidy, whereas
this file surviving means something specific and testable is still true: that
`Backend/config/db.js` still runs, still exits on an unreachable Mongo, and
therefore that some route is still being served by Mongoose. The file is not a
convenience that outlived its purpose {D} it is an *observable* that reports
whether the cutover actually happened. Left in place after Phase 3 it would go
on supplying a Mongo the application no longer needs, so nothing would fail and
the leftover coupling would be invisible.

Phase 3 exit therefore requires all four of:

1. `docker-compose.legacy-mongo.yml` deleted.
2. `Backend/config/db.js` deleted, and with it the last `process.exit` on an
   infrastructure failure.
3. `MONGODB_URI` removed from `docker-compose.yml`, `.env.example` and the
   `trust-proxy` CI job.
4. `docker compose up` {D} plain, no override {D} bringing four services healthy.

Item 4 is the one that proves the other three, which is why the amended
criterion is worth restating rather than simply dropping.

---

## ADR-048 — Two security fixes that carried their own defects, and a test that passed for the wrong reason

**Status** Accepted — recorded as a finding in its own right (AA3)

Three related errors, all made during Phase 2, all in code whose entire purpose
was to close a security finding. Recorded together because the pattern is the
point: **the most dangerous place to introduce a vulnerability is inside the fix
for one.** Review attention has already been spent by the time the fix is
written, the surrounding commentary says the right things, and the tests are
written by the same person who made the error.

### 1. The limiter keyed IPv6 clients on the raw address

`config/rateLimiters.js` was written with:

```js
keyGenerator: (req) => `${name}:${req.ip}`,
```

**The effect.** Every IPv4 client is limited correctly. Every IPv6 client gets an
unlimited budget. A residential IPv6 allocation is a /64 or shorter, so one
client holds upwards of 18 quintillion addresses and can present a fresh one per
request; each lands in its own bucket, and the 5-per-minute auth limit never
engages. SEC-02's brute-force path reopens for anyone on IPv6.

**Why it is worse than having no limiter at all.** With no limiter, the exposure
is known and the dashboards say nothing reassuring. With this one, the counters
increment, the 429s fire for the IPv4 majority, and every metric reads healthy
while the control is absent for a class of client that is not small and is
growing. A control that reports success while not functioning is worse than an
acknowledged gap, because it ends the search.

**The fix.** `ipKeyGenerator(req.ip)` collapses IPv6 to its /56 network and
leaves IPv4 untouched, so the bucket is the allocation rather than the address.

**How it was caught, which is the uncomfortable part.** Not in review, not by
reasoning about the design — by `express-rate-limit` v8 emitting
`ERR_ERL_KEY_GEN_IPV6` during the SPEC-2 section 8 test run. The library's own
authors anticipated this mistake well enough to ship a detector for it. Without
that warning the code would have shipped: the surrounding comment block
discussed keying at length, and discussed the wrong risk.

### 2. The test for the fix passed for the wrong reason

The regression test written alongside the fix asserted that two addresses in one
allocation share a bucket and that two different networks do not. For the second
half it used `2001:db8:abcd:0012::1` against `2001:db8:abcd:0099::1`.

Those are the same /56. The prefix boundary falls INSIDE the fourth group —
only its high byte is in the prefix — so both collapse to
`2001:db8:abcd::/56`. The assertion was `notEqual` on two values that are equal
by construction, and it failed, which is the only reason it was noticed.

**Had it been written as `assert.equal`, it would have passed and asserted
nothing.** That is the instructive case, and it is more instructive than the
original bug:

- A wrong test that FAILS costs an hour and is self-announcing.
- A wrong test that PASSES is indistinguishable from a working control, forever.
  It occupies the slot where the real check was supposed to go, it is counted in
  the pass total, and it makes the next reader confident.

**A test that passes for the wrong reason is a control that is not there** —
with the additional cost that its presence discourages anyone from adding the
one that would have worked.

The corrected test pins the literal expected key (`auth:2001:db8:abcd::/56`) as
well as the relational assertions, so the boundary is stated rather than
implied, and it asserts the `:0099:` case as SAME-bucket, which is what it
actually is.

### 3. The Nginx fix for a spoofing gap contained a spoofing hole

SPEC-2 section 7.3 asked for `X-Forwarded-For` handling to be made correct. The
configuration written for it kept this block:

```
set_real_ip_from  172.16.0.0/12;
real_ip_header    X-Forwarded-For;
real_ip_recursive on;
```

`172.16.0.0/12` contains the Docker bridge gateway. `real_ip_header` with a
trusted source means Nginx REPLACES `$remote_addr` with the client-supplied
header value — so any request whose source address fell in the bridge range
could name its own client IP and be believed, then passed upstream as
authoritative. Host-local and inter-container traffic qualified. On a host whose
Docker network is reachable, it is a direct rate-limit and audit-log bypass: a
fresh `X-Forwarded-For` per request, and the `limit_req` zone keyed on
`$binary_remote_addr` never sees the same client twice.

A spoofing hole, inside the fix for a spoofing gap. Removed entirely (ADR-043),
and `X-Forwarded-For` is now overwritten with `$remote_addr` rather than
appended.

### The pattern, and what to do about it

**This is the second time in this project a security fix has carried its own
defect** (AA3). Two earlier episodes fit that description, and they fit it
differently, which is worth separating rather than collapsing:

- **ADR-012, superseded by ADR-026 — the closest match.** SPEC-1A section 5.6
  stated that the `UNIQUE` index on `donation_payment_details.mihpayid` was the
  SEC-01 replay defence. It is not: `mihpayid` is an UNSIGNED field in the PayU
  callback, so an attacker controls it and can vary it freely. The index is a
  data-integrity control and nothing more. The defect here was not in the
  mechanism but in the claim attached to it — and a fix documented as
  providing a protection it does not provide is worse than an absent one,
  because it closes the question. This was Gary's correction, not a finding of
  mine; ADR-012 repeated the error before ADR-026 fixed it.
- **ADR-034 — the same shape, caught one step earlier.** The natural
  implementation of the SEC-02 attempt cap, clearing the counter on a correct
  code at `/verify`, would have handed a lucky guesser a fresh budget of five at
  `/reset` and let them alternate endpoints to stay topped up. The distinction
  worth keeping is that the code was already correct: this was a gap in the
  SPECIFICATION that the obvious tidy-up during Phase 3 would have turned into a
  defect, not a defect that shipped. It is a near miss, recorded so the tidy-up
  does not happen.

If the intended precedent was a third episode, this list is wrong and should be
corrected here rather than reconciled in conversation.

What the three have in common is not carelessness. It is that each was written
while thinking about the attack the fix was FOR, and each defect lived in a
dimension the fix was not thinking about — address family, prefix arithmetic,
the trust source rather than the header. The mitigations that actually worked
here were mechanical, not attentional:

1. **Run the thing.** All three were found by execution — a library warning,
   an assertion failure, a request issued through the real proxy. None was found
   by reading.
2. **Test through the real topology.** Package A's `trust proxy` test set the
   header directly on Express with no proxy in front, which cannot distinguish a
   deployment that discards a client-supplied value from one that trusts it.
   The `set_real_ip_from` hole survived that test and could not survive
   `trust-proxy.test.js`.
3. **Pin literals, not just relations.** `notEqual(a, c)` encodes an assumption
   about IPv6 prefix arithmetic. `equal(a, 'auth:2001:db8:abcd::/56')` states
   the arithmetic, so being wrong about it is visible.

**Consequences** Both gates are now in CI (`app-tests.yml`, jobs `data-layer`
and `trust-proxy`) rather than local-only, because every one of these findings
depended on someone choosing to run a suite by hand.

---

## ADR-049 — The api image was built from the developer's `node_modules`; `Backend/.dockerignore` closes it

**Status** Accepted — **defect found while wiring the CI gates (AA1)**

`docker/api.Dockerfile` does:

```dockerfile
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
```

There was no `.dockerignore`. The second `COPY` therefore brought the whole
build context — including the developer's own `node_modules` — and Docker
merged it OVER the tree the `deps` stage had just built from the lockfile,
overwriting every file present in both.

**So the image did not contain the dependencies the lockfile describes. It
contained the developer's, layered on top of them.**

**How it surfaced, and why that is the interesting part.** It did not surface as
a build error. It surfaced as `503` from `/api/health` with
`@prisma/client did not initialize yet` — three weeks and one accepted phase
after it was introduced — the moment `npm ci` was run on the host while
verifying the new CI install step. `npm ci` replaces the GENERATED Prisma client
with the ungenerated stub, and the stub then overwrote the client the `deps`
stage had correctly generated for Linux.

Every earlier build worked purely because the host had at some point run
`prisma generate`. That is not a property of the repository. It is a property of
one machine, and it was the thing holding up the acceptance evidence for Phase
2.

**What was actually wrong, in ascending order of seriousness:**

1. **Not reproducible.** Two people building the same commit get different
   images, and neither matches what CI builds. The lockfile that
   `chore/dependency-cleanup` committed to make the dependency set exact was
   being overwritten at the last step.
2. **Wrong-platform binaries.** Prisma ships one query engine per platform
   (`query_engine-windows.dll.node` against
   `libquery_engine-debian-openssl-3.0.x.so.node`). Building on Windows put
   both in a Linux image. Because the filenames differ, nothing collided and
   nothing complained — which is precisely why it went unnoticed.
3. **A secret-leak path that happened not to be taken.** There is no
   `Backend/.env` today. Had there been, it would have been copied into the
   image and into every registry that image was pushed to. The absence of the
   file was the only control.

The image also shrank from 1.08GB to 695MB, which is the least important
consequence and the only visible one.

**Why CI would not have caught it.** A runner checks out a clean tree, so there
is no host `node_modules` for the second `COPY` to pick up and the image builds
correctly. This defect is invisible to CI BY CONSTRUCTION and only ever appears
on a developer machine — the inverse of the usual "works on my machine",
where the local build is the one that is wrong and CI is right. It was found by
building locally, which the new `trust-proxy` job does in CI and which nothing
had previously forced anyone to do.

**Consequences** `Backend/.dockerignore` now excludes `node_modules`, `.env*`,
`.git` and build debris, and carries the explanation inline so that deleting it
requires reading why it exists. `test/` is deliberately NOT excluded: the
container is where the data-layer and schema suites run against real MySQL.

Worth stating plainly against the Phase 2 report: the acceptance evidence given
for Phase 2 — `docker compose up`, api healthy — was obtained from an image
built this way. The application code was correct and all the suites genuinely
passed, but the image they passed in was not the image the Dockerfile
describes. The re-run recorded in AA1 was done on a clean image.