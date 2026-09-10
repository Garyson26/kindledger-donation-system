# Phase 2 readiness note

**Purpose** Input to SPEC-2. Enumerates the MongoDB surface that Phases 2 and 3
must replace, classifies it against the proposed Phase 2/3 boundary, and flags
the cases the boundary does not resolve.

**Status** Analysis only. No code was changed to produce this.

**Measured against** `origin/main` at `58bdadf`.

---

## 1. The headline numbers

| Measure | Count |
|---|---|
| Files importing `mongoose` directly | 7 |
| Files importing a model | 20 |
| Model query/write call sites (`findById`, `findOne`, `create`, `aggregate`, …) | **83** |
| Document-instance calls (`.save()`, `.toObject()`) | **26** |
| `.populate()` calls (ORM-side joins) | 8 |
| `.aggregate()` pipelines | 3 |
| Files with raw Mongo `$`-operator query objects | 5 |

So the surface is roughly **109 call sites across 20 files**, not counting the
four model definitions themselves. That is the number nobody had.

---

## 2. Complete inventory

### 2.1 Connection and schema definition — the data layer itself

| File | Touchpoints |
|---|---|
| `config/db.js` | `mongoose.connect` (L5). The entire connection layer, 13 lines. Calls `process.exit(1)` on failure |
| `models/User.js` | Schema, 2 `schema.index()`, `mongoose.model` |
| `models/Donation.js` | Schema, 2 `Types.ObjectId` refs, 4 `schema.index()`, `mongoose.model` |
| `models/Category.js` | Schema, `mongoose.model` |
| `models/PendingSignup.js` | Schema, `expires: 86400` TTL, 2 `schema.index()`, `mongoose.model` |

### 2.2 Consumers, by call-site count

| File | Query/write sites | `.save()`/`.toObject()` | Notes |
|---|---|---|---|
| `routes/admin.js` | 16 | 4 | Largest single consumer |
| `routes/auth.js` | 15 | 18 | Most `.save()` calls in the codebase |
| `routes/donations.js` | 13 | 1 | All 8 `populate()`, both `aggregate()`, the only `distinct()` |
| `routes/categories.js` | 8 | 1 | |
| `routes/payment.js` | 7 | 1 | The SEC-01 path |
| `services/dataCleanupService.js` | 5 | 0 | Retention purge (BUG-04, never runs) |
| `controllers/authController.js` | 2 | 1 | **Dead code — see 4.2** |
| `middleware/authMiddleware.js` | 1 | 0 | `User.findById().select("name role")` |
| `middleware/adminAuth.js` | 1 | 0 | `User.findById().select("name role")` |
| `routes/users.js` | 1 | 0 | `findByIdAndUpdate` |
| `scripts/seedDatabase.js` | 13 | 0 | Own `mongoose.connect`. **Delete, not migrate — see 4.3** |
| `checkOrder.js` | 1 | 0 | Own `mongoose.connect`. One-off CLI — see 4.4 |

---

## 3. Classification against the proposed boundary

> Phase 2 = the data layer and the runtime that supports it.
> Phase 3 = the routes that consume it.

### Phase 2 — unambiguous

- `config/db.js` — replaced by Prisma connection management, pooling, health check.
- `models/User.js`, `Donation.js`, `Category.js`, `PendingSignup.js` — superseded
  by `Backend/prisma/schema.prisma`, which already exists and already models all
  four entities. Phase 2 is not designing this, it is switching to it.

That is **5 files and zero route changes.**

### Phase 3 — unambiguous

`routes/admin.js`, `routes/auth.js`, `routes/donations.js`,
`routes/categories.js`, `routes/payment.js`, `routes/users.js` —
**60 query/write sites and 25 instance calls.**

### Phase 2 by the file-based split, Phase 3 by the principle

`services/dataCleanupService.js`, `middleware/authMiddleware.js`,
`middleware/adminAuth.js`. See 4.1 — this is the boundary case that matters.

---

## 4. Cases the boundary does not resolve

### 4.1 Middleware is a *consumer* that lives outside `routes/`

The Y1 wording puts "config, middleware or services" in Phase 2. The Y1
*principle* — data layer versus its consumers — puts middleware in Phase 3,
because `authMiddleware.js` and `adminAuth.js` do not define or manage data
access, they query it (`User.findById(userId).select("name role")`).

Only 2 call sites, so the cost either way is small. **But it must be ruled on
explicitly, because SEC-05 lands in exactly those two files.** Enforcing
`isActive` and checking `tokenVersion` are changes to `authMiddleware.js` and
`adminAuth.js`. Whoever owns middleware owns SEC-05, and SEC-05 is one of the
four open High findings.

The same tension applies to `services/dataCleanupService.js`: it is a service,
but it consumes three models and its purpose (the retention purge, BUG-04) is
a behaviour, not a data layer.

**Recommendation:** rule by principle, not directory — consumers are Phase 3 —
but pull SEC-05 forward into Phase 2 explicitly if the middleware rewrite is
where the data-access change lands anyway. Either way, name it in the spec.

### 4.2 `controllers/authController.js` is dead code, and it is dangerous

**It is imported nowhere.** Verified: no file in `Backend/` references
`authController`. It is not routed.

It should be **deleted, not migrated** — and it should be deleted regardless of
Phase 2, because of what it contains:

```js
const { name, email, password, role } = req.body;
...
const newUser = new User({ name, email, password: hashedPassword, role });
```

It takes `role` **straight from the request body** with no
`ADMIN_CREATION_KEY` check and no OTP verification. `routes/auth.js` guards
both of those; this file guards neither. Wired up — by anyone adding "a simple
signup endpoint" and finding a ready-made controller — it is immediate
self-service privilege escalation to `role: "admin"`.

This is not currently exploitable, because nothing routes to it. It is a loaded
gun in the repository, and it is more permissive than the SEC-21 path already
recorded. **Recommend deleting it in Phase 2** as part of removing the old data
layer, and recording it as a finding rather than a cleanup item.

### 4.3 `scripts/seedDatabase.js` — supersede, do not port

13 call sites and its own `mongoose.connect`. Phase 1a already delivered
`Backend/db/seed.js` for MySQL, with the random-password and refuse-in-production
guards. Porting the Mongo seeder would duplicate that work.

It cannot be deleted in Phase 2, because it is still the seeder for the live
MongoDB stack until cutover — the `npm run seed` script deliberately still
points at it. **Phase 4 deletes it.** Needs stating so it is not counted as
Phase 2 or 3 scope.

### 4.4 `checkOrder.js` — a one-off CLI at `Backend/` root

One `Category.find()`, its own connection, prints category display order. Not
imported by anything. Delete or port; either is a few minutes. Flagged only so
it is not discovered late and treated as a surprise.

### 4.5 `app.js` calls `connectDB()`

Replacing the data layer changes this line. `app.js` is not `routes/`,
`middleware/` or `config/`, so the boundary does not name it. Minor, but it is
where the health check and the Prisma client lifecycle will be wired, so the
spec should say Phase 2 owns `app.js`.

### 4.6 The test suites import the Mongoose data layer — this one has teeth

`Backend/test/payment-callbacks.test.js` and `Backend/test/auth-reset.test.js`
(on branch `test/payment-callbacks`) import `mongoose` and the models directly
inside their `store` seam:

```
test/payment-callbacks.test.js:76  require('../models/Donation')
test/payment-callbacks.test.js:77  require('../models/Category')
test/auth-reset.test.js:46         require('../models/User')
```

Those 23 tests are the regression net for SEC-01, SEC-02 and SEC-04. **If
Phase 2 removes the models, both suites stop running at the end of Phase 2 and
do not run again until Phase 3 has rewritten both the routes and the test
seam.** The riskiest stretch of the migration would then have no coverage over
its most security-sensitive path — which is the gap the suites were written to
close.

This is the strongest argument against a replace-in-place Phase 2, and it is
the subject of the boundary comment in section 6.

---

## 5. Mongoose behaviour with no direct SQL equivalent

Beyond the TTL index already recorded in ADR-033.

| Behaviour | Where | What Phase 2/3 must do |
|---|---|---|
| **`.populate()`** — ORM-side join by ref | 8 sites, all in `routes/donations.js` and `routes/payment.js` | Prisma `include`/`select`. Semantics differ: `populate` silently yields `null` for a dangling ref, a SQL join with a `NOT NULL` FK cannot have one. Any code branching on a null populated field changes meaning |
| **`.aggregate()` pipelines** | `routes/donations.js:145,148`; `scripts/seedDatabase.js:341` | Rewrite as SQL `GROUP BY`. The two in `donations.js` back `GET /filter-options` — `$group` with `$min`/`$max`/`$sum` |
| **`.distinct()`** | `routes/donations.js:144` | `SELECT DISTINCT`. Trivial, but note it currently returns values *present in data*, whereas the MySQL `ENUM` has a fixed member list — the filter dropdown's contents change from "what exists" to "what is possible" unless deliberately preserved |
| **`Types.ObjectId` refs** | `models/Donation.js:17,26` | `BIGINT UNSIGNED` FKs. Already designed; the ETL maps via `legacy_id` |
| **Untyped `$`-operator queries** | 5 files, ~39 occurrences | Prisma's typed query API. This is where the SEC-03 NoSQL-injection class disappears — but only if no raw string interpolation replaces it |
| **`runValidators: false`** | `routes/payment.js:283` | No equivalent and none needed: MySQL enforces `ENUM` and `CHECK` unconditionally. This is BUG-02 dying at migration |
| **Schema-level `default`** | throughout the models | Column `DEFAULT` in `db/schema.sql` — already mirrored. Worth verifying each one matches rather than assuming |
| **`.toObject()` then `delete obj.password`** | `routes/admin.js:144,199` | Prisma `select` — omit the column instead of fetching and deleting it. Strictly better: the hash never leaves the database |
| **Implicit collection creation** | everywhere | MySQL requires the migration to have run. The server guard and drift gate already cover this |
| **Mongo's lack of transactions in this codebase** | no `session`/`startTransaction` anywhere | Nothing currently relies on multi-document atomicity, so nothing breaks — but ADR-012's read-then-write race becomes *fixable* with a transaction, which it was not before |

---

## 6. Comment on the proposed boundary

**The principle is right.** "Data layer versus its consumers" is a cleaner line
than any directory-based split, and it correctly rejects patching `db.js` — that
file is MongoDB connection code Phase 3 deletes anyway, and patching it to boot
without `MONGODB_URI` would breach the SPEC-1A fence for no lasting gain.

**The concern is "replace" rather than "add".** Under a replace-in-place
Phase 2:

- The 60 route call sites still reference Mongoose models that no longer exist,
  so every data-backed endpoint is broken from the end of Phase 2 until Phase 3
  completes.
- More seriously, per 4.6, **the SEC-01/02/04 regression net goes dark for the
  whole of Phase 3.**

That second point is the problem. The suites exist precisely so the Phase 3
rewrite has a net; losing them at the start of Phase 3 inverts their purpose.

**An additive Phase 2 avoids both** and costs little:

1. Phase 2 **adds** the Prisma data layer — client, pooling, health check — and
   a repository module, without removing `config/db.js` or the models.
2. Both layers coexist. The app keeps working, the existing suites keep passing,
   and the container boots on a real MySQL data layer as intended.
3. Phase 3 switches consumers over **one route file at a time**, running the
   suites after each, and deletes Mongoose only once the last consumer is off it.

The repository interface is already specified, which is the part that makes this
cheap: the test suites' `store` seam — `createDonation`, `readDonation`,
`seedPaymentDetail`, `createUserWithResetCode`, `readUser` — is the shape of a
minimal donation/user repository, written deliberately so its body could be
reimplemented against Prisma without touching a single assertion. Phase 2
building the real thing to that shape means Phase 3's test migration is
swapping five function bodies, not rewriting 23 tests.

**One consequential side effect to note either way:** under this boundary,
`/api/health` and removing the compose `profiles:` key move from Phase 3 to
**Phase 2**, because that is where the working data layer arrives. ADR-006
assigns both to Phase 3. SPEC-2 should either reassign them explicitly or
amend ADR-006, so the compose stack does not end up with two owners.
