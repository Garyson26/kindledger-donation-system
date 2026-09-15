# Entity ownership audit (AR1)

**Run at the end of package 3.3, before 3.4.** Mechanical, and never run before.
It exists because ADMIN-01 was created by package 3.2 and found by package 3.3's
severity pass — three packages and two merges later — for the single reason that
`admin.js` was out of scope and therefore out of mind.

## The rule being applied

> For each entity, list every file that **writes** it and every file that
> **reads** it. Where those sets cross package boundaries, those packages are
> one merge unit.

**Sharpened by what the enumeration found.** "Writer" and "reader" is not quite
the right axis, because two files can both be writers and still be a crossing if
they write *different stores*. The operative question is:

> **Which STORE does each call site touch, and is any file reading a store that
> a different package's file is not writing?**

Every table below therefore records the store, not only the operation.

**Scope: every file under `Backend/`, not only `routes/`.** Middleware, services,
the ETL, the scripts, and the unreferenced developer file at the repo root.

---

## Summary

| Entity | Stores in use | Crossings | Verdict |
|---|---|---|---|
| **User** | MongoDB + MySQL | **3** | 3.2 and 3.5's user operations are one merge unit (ADMIN-01) |
| **Donation** | MongoDB + MySQL | **3** | 3.3, 3.4 and 3.5's `/stats` counts are one merge unit (ADR-057) |
| **Category** | MongoDB + MySQL | **2** | both are `scripts/` and `checkOrder.js`, not route packages |
| **PendingSignup** | MySQL only | **0** | clean — and the reason is instructive |
| **BrandingSettings** | MySQL only | **0** | **no caller of any kind exists** |

**Nine crossings in total. Two were already known (ADMIN-01, ADR-057). Seven are
new, and two of them are destructive operations.**

---

## 1. User

| File | Package | Ops | Lines | Store |
|---|---|---|---|---|
| `routes/auth.js` | 3.2 | **R** findByEmail, findById | 156, 293, 357, 378, 391, 420, 443, 497, 537, 564 | MySQL |
| | | **W** createFromPendingSignup, setVerified, setLoginOtp, clearLoginOtp, incrementLoginOtpAttempts, setResetCode, clearResetCode, incrementResetAttempts, setPassword | 228, 331, 334, 366, 369, 377, 394, 423, 466, 475, 505, 510, 518, 544 | MySQL |
| `routes/users.js` | 3.2 | **W** updateProfile | 40 | MySQL |
| `middleware/authMiddleware.js` | 3.2 | **R** resolveAuthUser | via `userBridge` | MySQL first, Mongo fallback |
| `middleware/adminAuth.js` | 3.2 | **R** resolveAuthUser | 33 | MySQL first, Mongo fallback |
| `services/userBridge.js` | bridge (dies 3.5/3.6) | **R** repository, then model | 103, 110 | **both** |
| `services/scheduler.js` | Phase 2 | **R** countInactiveOlderThan / **W(DELETE)** deleteInactiveOlderThan | 124, 131 | MySQL |
| **`routes/admin.js`** | **3.5** | **R** countDocuments, find, findOne, findById | 26, 96, 99, 134, 201, 259, 264 | **MongoDB** |
| **`routes/admin.js`** | **3.5** | **W** new User, findByIdAndUpdate ×2, findByIdAndDelete | **143, 182, 234, 270** | **MongoDB** |
| `etl/migrate.js` | 4a | **R** Mongo → **W** MySQL | 153 | both, by design |
| `etl/preflight.js` | 4a | **R** aggregate | 120 | MongoDB |
| **`scripts/seedDatabase.js`** | **unassigned** | **W** deleteMany, insertMany / **R** countDocuments | **106, 177**, 335 | **MongoDB** |

### Crossings

**U-X1 — `admin.js` (3.5) writes MongoDB; `auth.js` and both middlewares (3.2)
read MySQL. = ADMIN-01, High, already recorded and measured.**

**U-X2 — `services/scheduler.js` (Phase 2) DELETES users from MySQL while
`admin.js` (3.5) deletes them from MongoDB.** Two packages hold a destructive
operation on the same entity in different stores. An account deleted through the
admin console still exists in MySQL and remains eligible for — or exempt from —
the retention purge independently of what the admin did. Latent only because
`SCHEDULER_ENABLED` defaults to false. *(This is the crossing the plain
writer/reader framing would have missed: both files are writers.)*

**U-X3 — `scripts/seedDatabase.js` writes MongoDB users.** Seeded accounts
cannot log in, because `auth.js` reads MySQL. Guarded — it requires
`NODE_ENV !== 'production'` **and** `ALLOW_SEED=true`, which is a real double
guard — so this is a developer-experience crossing, not a production one. It is
listed because "the seeder produces a database nobody can log into" is exactly
the symptom that gets diagnosed as a broken login.

---

## 2. Donation

| File | Package | Ops | Lines | Store |
|---|---|---|---|---|
| `routes/donations.js` | 3.3 | **R** findByLegacyId/findById, list ×2, listPaymentStatusesInUse, countsByPaymentStatus, countsByUserPresence, dateRange, listForStats | 120, 121, 171, 206–209, 266, 351 | MySQL |
| | | **W** setStatus | 396, 435 | MySQL |
| **`routes/payment.js`** | **3.4** | **W** new Donation + save, findByIdAndUpdate ×4 | **141, 157, 279, 373, 439, 581** | **MongoDB** |
| | | **R** findById, findOne transactionId | 235, 617 | **MongoDB** |
| **`routes/admin.js`** | **3.5** | **R** countDocuments, countDocuments({status:"approved"}) | **27, 32** | **MongoDB** |
| `services/scheduler.js` | Phase 2 | **R** countImplausibleDates, countOlderThan / **W(DELETE)** deleteOlderThan | 79, 81, 102 | MySQL |
| `etl/migrate.js` | 4a | **R** Mongo → **W** MySQL | 194 | both, by design |
| `etl/preflight.js` | 4a | **R** aggregate, cursor ×2, distinct, countDocuments ×3 | 144, 183, 227, 265, 280, 283, 309 | MongoDB |
| **`scripts/seedDatabase.js`** | **unassigned** | **W** deleteMany({}), insertMany / **R** counts | **107, 327**, 336–341, 356 | **MongoDB** |

### Crossings

**D-X1 — `payment.js` (3.4) writes MongoDB; `donations.js` (3.3) reads MySQL.
= ADR-057, already recorded.** Every donation taken between the two merges is
invisible to the admin console. This is the crossing that produced the rule.

**D-X2 — `admin.js` (3.5) reads MongoDB donation counts.** `GET /admin/stats`
returns `donations` and `approved` from MongoDB. **NEW — and it bears directly
on AR3; see the recommendation below.**

Measured against the stack rather than asserted, and the measurement is more
interesting than the claim:

```
GET /api/admin/stats -> 200 {"users":1,"donations":5,"categories":2,"approved":1}

  MySQL   donations total = 5     <- where donations live after 3.3
  MongoDB donations total = 5     <- what the tile reports
  tile "donations"        = 5     <- AGREES, today

  MySQL   status=Approved = 2     <- the truth
  MongoDB status=approved = 1     (lowercase - what the query matches)
  MongoDB status=Approved = 1     (canonical - what the callbacks write)
  tile "approved"         = 1     <- WRONG, today
```

**The `donations` tile is correct today and becomes wrong at the first new
donation.** The ETL copied MongoDB to MySQL, so the two agree until something
writes. A crossing that reads correctly in every test and diverges only in
production under real traffic is the worst kind to leave open, and it is
invisible to exactly the check anyone would run.

**The `approved` tile is already wrong, and BUG-03's description is wrong about
how.**

**D-X3 — `services/scheduler.js` (Phase 2) DELETES donations from MySQL while
`payment.js` (3.4) writes them to MongoDB.** The retention purge would delete
ETL-migrated history from MySQL while live donations accumulate in MongoDB where
the purge cannot see them. The organisation would satisfy its retention
obligation against the wrong copy. Latent only because `SCHEDULER_ENABLED`
defaults to false — **which means the guard that makes this safe is an
environment variable, not the code.** Same shape as U-X2.

---

## 3. Category

| File | Package | Ops | Lines | Store |
|---|---|---|---|---|
| `routes/categories.js` | 3.1r | **R** findByLegacyId, findByName, list ×2, count | 106, 145, 173, 184, 185 | MySQL |
| | | **W** create, setDisplayOrder, update, archive | 150, 221, 262, 291 | MySQL |
| `services/categoryBridge.js` | bridge (dies 3.5) | **R** only | — | MySQL first, Mongo fallback |
| `routes/payment.js` | 3.4 | **R** resolveCategory, attachCategories | 127, 622 | via bridge |
| `routes/admin.js` | 3.5 | **R** countCategories | 31 | via bridge → MySQL |
| `routes/donations.js` | 3.3 | **R** via the donation join | — | MySQL |
| `etl/migrate.js` | 4a | **R** Mongo → **W** MySQL | 111 | both, by design |
| `etl/preflight.js` | 4a | **R** exists | 273 | MongoDB |
| **`scripts/seedDatabase.js`** | **unassigned** | **R** find / **W** create | 112, **116** | **MongoDB** |
| **`checkOrder.js`** | **unassigned, UNREFERENCED** | **R** find | 9 | **MongoDB** |

### Crossings

**C-X1 — `scripts/seedDatabase.js` creates MongoDB categories; `categories.js`
reads MySQL.** A seeded category is invisible to the category list — ADR-056's
exact failure, reachable from an `npm` script. Same double guard as U-X3.

**C-X2 — `checkOrder.js` reads MongoDB categories.** A developer diagnostic at
the repo root, referenced by nothing: no import, no npm script. It prints the
category ordering from a store that stopped being authoritative at package 3.1.
Trivial in impact and listed because **it is the purest example of what this
audit is for** — a file nobody would think to check, reporting confidently from
the wrong database. It should be deleted or repointed in 3.6.

**Note the route packages do NOT cross on Category.** Every route reader goes
through `categoryBridge`, which is MySQL-first. That is ADR-050 working exactly
as designed, and it is the only entity where the bridge is carrying its full
intended load.

---

## 4. PendingSignup — NO CROSSINGS

| File | Package | Ops | Lines | Store |
|---|---|---|---|---|
| `routes/auth.js` | 3.2 | **R** findByEmail ×2, verifyOtp, verifyPassword | 212, 215, 277, 279 | MySQL |
| | | **W** upsert, remove ×2, incrementOtpAttempts, setOtp ×2 | 173, 186, 218, 224, 247, 283 | MySQL |
| `services/scheduler.js` | Phase 2 | **R** countExpired / **W(DELETE)** deleteExpired | 143, 147 | MySQL |
| `etl/migrate.js` | 4a | **R** countDocuments only — deliberately NOT migrated (SPEC-1A §5.2) | 296 | MongoDB |

**Clean, and the reason is worth stating: its writer and all its readers landed
in the same package by accident of scope, not by design.** Nobody checked. It is
the control case for the whole audit — the entity that came out clean did so
without anyone having reasoned about it, which is precisely why the other four
could not be assumed clean either.

Note the scheduler holds a **destructive** operation on this entity too, and it
does not cross only because `auth.js` writes the same store.

---

## 5. BrandingSettings — NO CALLER OF ANY KIND

| File | Ops | Store |
|---|---|---|
| `repositories/brandingSettings.js` | R/W | MySQL |
| `db/seed.js:199` | **W** update | MySQL |
| `test/data-layer.test.js`, `test/schema.test.js` | R/W | MySQL |
| **nothing else in the codebase** | | |

**There is no route, no middleware, no service and no frontend reference.**
Searched `Backend/routes`, `Backend/config`, `Backend/app.js` and
`Frontend/src`: zero matches for `branding` outside the data layer, the schema
and the tests.

What exists for it: a Prisma model, a table, a `ck_branding_settings_singleton`
CHECK plus two colour-format CHECKs, entries in the drift gate
(`db/check-drift.js:121-123`), coverage in two test suites, and a seeded row.

**A complete, constrained, gated, tested data layer that nothing calls.** This
is ADR-042's observation generalised — *the store existing and the store being
used are different claims* — and here the second claim has no evidence at all.

It is **not** a defect and should not be filed as one: it is a Phase 2 entity
built ahead of a Phase 5 feature. It is recorded because **an entity with no
caller cannot be verified by any test of behaviour**, so it will reach whatever
consumes it in Phase 5 with only its constraints proven and none of its
semantics. Whoever wires it up should know they are its first caller.

---

## Conclusions

### The merge unit

Already decided by AR2 and AR3: **3.2 + 3.3 + 3.4 + `admin.js`'s user
operations.** The audit confirms that and adds exactly one item to report.

### Reporting before widening, per AR3

**`admin.js`'s CATEGORY operation is not entangled.** One call,
`categoryBridge.countCategories()` at `admin.js:31`, already resolving to MySQL.
Nothing to do.

**`admin.js`'s DONATION operations are entangled, but not equally** — and the
difference is the whole point of grading by outcome:

| | ADMIN-01 (user ops) | D-X2 (donation counts) |
|---|---|---|
| Operation | writes — create, update, disable, delete | **reads only** — two `countDocuments` |
| Failure | a control reports success and does not act | a dashboard tile stops growing |
| Visible? | **no** — the admin is told it worked | yes, eventually, to whoever reads the tile |

**They are two `countDocuments` calls in `GET /admin/stats`, lines 27 and 32.**
Not a control, not a write, no false success. My recommendation, and it is a
recommendation because AR3 reserved the decision:

**Include them.** Three reasons, in order of weight:

1. **They sit in the same handler as the user count** (`admin.js:26`), which is
   already in scope. Migrating the user count and leaving the donation counts
   produces one handler reading two databases — which is the condition this
   audit exists to eliminate, newly created by the fix for it.
2. **It closes BUG-03 for free, and BUG-03 is worse than recorded.** The map
   says the counter is "always 0". Measured: **it returned 1 when the true
   figure was 2.** It matches only the lowercase subset, so it reads zero only
   in a system where no admin ever used `PATCH /:id/status` — and reads a
   plausible-looking fraction in any system where some did. **A tile showing 0
   is visibly broken; a tile showing 1 of 2 is believed.** Migrating these two
   lines makes the repository's canonicalisation apply and the count correct.
3. It is two lines.

If you would rather hold the line at user operations only, the cost is a stale
`donations`/`approved` tile until 3.5, which is honest and survivable — but the
mixed-store handler in point 1 should then be commented as deliberate.

### The two destructive crossings deserve their own attention

**U-X2 and D-X3 were not found by the writer/reader framing** — both sides are
writers, so neither is a "reader reading the wrong store". They were found by
recording the STORE at each call site.

`services/scheduler.js` holds `DELETE` on donations and on users, against MySQL,
while the live writer for both is still MongoDB. The only thing preventing the
retention purge from acting on the wrong copy of the data is `SCHEDULER_ENABLED`
defaulting to false. **That guard is correct and it is an environment variable.**
It should not be the only thing standing between a half-migrated system and a
retention purge — recommend the scheduler additionally refuses to run while any
route file still imports Mongoose, which is a condition the code can check and
which becomes vacuously true at 3.6.

### What the audit says about the method

**Nine crossings. Two were known. Of the seven new ones, four are in files that
are not route files at all** — `scheduler.js`, `seedDatabase.js` ×2,
`checkOrder.js`. The package sequence is organised around `routes/`, so those
four were never going to surface from reading it.

**And the one clean entity is clean by accident.** PendingSignup's writer and
readers share a package because nobody split them, not because anyone checked.
That is the finding that justifies re-running this audit rather than treating it
as done: it would have come out clean at 3.1 too, and ADMIN-01 was created at
3.2.

**Re-run it at the end of every package that moves an entity.** It took under an
hour and it is a grep.
