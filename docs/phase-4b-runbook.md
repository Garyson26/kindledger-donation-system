# Phase 4b — production cutover runbook

**Status: not yet executed. Blocked on read-only Atlas credentials.**

This is the document, not the run. Nothing in it has been performed against
production, and no step here should be taken from memory of this file — it is
written to be followed line by line on the day, by somebody who may not have
written any of the code.

> **THE ONE THING TO KNOW BEFORE STARTING.** The rollback boundary closes at the
> first real donation written into MySQL. Everything that could trigger a
> rollback must therefore complete **before donations reopen** — which means the
> freeze is as long as the verification takes, not as long as the ETL takes
> (R3). If you find yourself shortening verification to shorten the freeze, stop
> and reopen donations on MongoDB instead.

---

## 0. Roles

| Role | Who | Responsible for |
|---|---|---|
| **Cutover lead** | Gary | The go/no-go at §6. Owns the decision, not the keystrokes |
| Operator | Gary | Runs the commands |
| Verifier | Gary | Reads the output and says whether §5 passed |

Lead and verifier being the same person is acceptable for a project this size
and is worth naming as a known weakness: **nobody independent is reading the
verification output.** If a second pair of eyes is available on the day, put
them on §5.

---

## 1. Pre-cutover checklist — days before, not on the day

Each item is either **closed** or **must be closed before §3**. None of them
needs the freeze, so none of them belongs inside it.

### 1.1 PAY-03 — `firstname` is truncated to 20 characters in PayU's TEST environment

**Status: OPEN. Must be answered before the first sandbox payment.**

| Field | Production limit | TEST limit |
|---|---|---|
| `firstname` | 60 | **20** |

`firstname` is a **signed field** — it appears in both the request hash and the
response hash. If PayU's test environment stores a truncated value and signs its
response with that, the response hash is computed over a different string than
the one we sent, and `verifyHash` refuses it.

**Every sandbox payment would fail hash verification, and the symptom —
`invalid_hash` — points at the hashing code, which is correct.**

**Action:** run one sandbox payment with a `firstname` longer than 20 characters
and one shorter. If the long one fails hash verification and the short one
passes, the truncation is confirmed and the fix is to bound `firstname` to 20 in
the request when `PAYU_BASE_URL` is the test host.

Our own callback fixtures use `ZZZ SYNTHETIC TEST DO NOT PROCESS` — 33
characters — so this fires on the first real sandbox exercise.

### 1.2 `txnid` length — CLOSED, and recorded so nobody re-opens it

PayU documents a 25-character limit. `mintTransactionRef()` produces 23
(`TXN` + 20 hex). Two characters of headroom, asserted by `test:payment-char` so
it cannot be spent by somebody lengthening the reference for entropy.

**No action. Listed because it was carried as the only unverified claim on the
money path and its closure should be visible here rather than looked up.**

### 1.3 The match-rate floor is **1.0**, and the derivation is the point

`npm run etl:null-minted` refuses an apply run without `--min-match-rate`.

**For this cutover the value is `1.0`.** The derivation, because somebody seeing
0.98 will be tempted to lower it:

1. A minted `legacy_id` exists only because Phase 3 code fabricated one for a
   row created through the running application.
2. **That code has never been deployed.** Phase 3 runs in development only.
3. Production MySQL is therefore populated by the ETL and by nothing else.
4. Every `legacy_id` in it came from production MongoDB.
5. **So every one must resolve. The expected rate is exactly 1.0.**

A production rate below 1.0 cannot mean "some rows were minted" — that requires
undeployed code. It means **rows were deleted from MongoDB after the ETL ran**
(so the freeze was not held) **or this is not the database the ETL read.**

Both are stop conditions. **Lowering the floor to make a run succeed converts an
alarm into a permission**, and the run it permits destroys migration history
permanently, because after the cutover there is no oracle left to rebuild it.

### 1.4 Strict mode on the ETL's own connection

`sql_mode` is a session variable. The API checks it at boot; **that says nothing
about the connection the ETL opens.** Without `STRICT_TRANS_TABLES` an over-long
value is truncated and an out-of-range number clamped — silently, on the largest
write this system will ever perform, and it would look like a clean run.

The pre-flight checks this on its own connection and it is FATAL. **No action
beyond confirming the pre-flight ran** — but confirm it, because this is the one
finding whose absence from the report is indistinguishable from a pass if the
report was never read.

### 1.5 Environment

- `PAYU_MERCHANT_SALT` **must be set.** Without it the API refuses to build or
  verify a PayU hash (ENV-01) rather than computing one anybody could forge.
  Confirm the value is present before the freeze, not during it.
- `MONGODB_URI` must name **production**, and the ETL's Atlas guard must be
  deliberately lifted for this run. Confirm what it is set to by echoing it —
  this is the variable whose being wrong is the whole of §5.6's risk.

---

## 2. J3 — the read-only investigation, BEFORE the ETL

All three are **read-only** and all three run against production MongoDB with
the read-only Atlas user. **None of them modifies anything, and none needs the
freeze.** Run them days earlier if the credentials allow.

They are here, before the ETL, because each could change what the cutover does.

### 2.1 Admin account enumeration

```
db.users.find({ role: "admin" }, { email: 1, isActive: 1, createdAt: 1 })
```

**Why:** the migration carries every admin across. An account nobody remembers
creating is an account nobody is watching, and the cutover is the last cheap
moment to ask about it.

**Record the list.** If it contains an address that is not a current
administrator, that is a finding to resolve before §3 — not a row to migrate and
deal with later.

### 2.2 The `Password@123` check

```
db.users.find({}, { email: 1, password: 1 })
```

then, offline, for each hash:

```
bcrypt.compareSync("Password@123", hash)
```

**Why:** a default password in the production dataset survives the migration
intact — the ETL carries `passwordHash` verbatim, deliberately, because
re-hashing is impossible without the plaintext.

**If any account matches**, it is a live credential and the cutover must not
make it look newly blessed. Disable or force a reset **before** the ETL, so the
migrated state is the corrected one.

**Run the comparison on a machine you control, not in the Atlas console**, and
do not paste hashes into anything that logs.

### 2.3 The `PendingSignup` TTL index

```
db.pendingsignups.getIndexes()
```

**Why:** MySQL has no TTL. If MongoDB is expiring pending signups through an
index, that behaviour does not migrate, and rows holding a name, an email and a
bcrypt hash would accumulate for ever in MySQL.

`JOB_PENDING_SIGNUP_SWEEP` is the replacement, and it is **off by default**
(AT1). If the index exists, the sweep must be authorised as part of this
cutover; if it does not, the accumulation is pre-existing and is a finding of
its own.

---

## 3. The freeze

**The freeze begins here.** Its length is set by §5, not by §4.

1. **Disable donations at the frontend.** A maintenance state that explains
   itself — not an error. Donors seeing a failure will retry, and a retry during
   a cutover is the case nobody has tested.
2. **Drain the PayU session window.** A donor who reached PayU before the freeze
   can still complete, and their callback will arrive after it. PayU sessions
   are minutes, not hours; wait out the window rather than guessing.
3. **Reconcile remaining `Pending` rows.** Every donation still Pending at this
   point is either abandoned or in flight. Query PayU for each and settle it in
   MongoDB **before** the ETL, so the migrated state is the settled one.

   **This is the step most likely to be rushed.** A Pending row migrated as
   Pending is not wrong — but a callback arriving after the cutover, for a
   donation that exists only in MongoDB, is money received and not recorded.

4. **Confirm nothing is writing to MongoDB.** The API is the only writer, and it
   has stopped serving donations — but confirm rather than assume, because §5.6
   depends on the source being stable.

---

## 4. The ETL run

```
npm run etl:preflight          # reports only, writes nothing
```

**Read all eight checks.** They are `strict-sql-mode`, `case-variant-emails`,
`mixed-case-status`, `float-rounding`, `amount-consistency`, `orphaned-category`,
`implausible-dates`, `declaration-ahead-of-data`.

**Every BLOCKING finding must be resolved in the SOURCE DATA.** There is no
override and there will not be one: an override could only ever turn a clean
refusal into a partial load, because every blocking finding is one the load also
refuses (ETL-01). If a blocking finding appears that the loader would NOT refuse,
`finding()` throws at construction and this runbook is out of date — stop and
re-read `BLOCKING_BUT_LOADABLE`.

**`mixed-case-status` at RECORD severity is the one to write down rather than
fix.** Its count is the only record of BUG-02's blast radius; after the load,
MySQL canonicalises the casing and the two become indistinguishable for ever.
**Copy that number into the cutover log.**

Then:

```
npm run etl                    # the load
```

It is idempotent and resumable — it skips by `legacy_id`, never by `INSERT
IGNORE`. A partial load can be re-run. **A load that refuses has written
nothing.**

---

## 5. Verification — inside the freeze, all of it

> Everything here must pass **before donations reopen**, because after that the
> rollback boundary has closed.

### 5.1 AE1-a FIRST, and this is the irreversible step

```
npm run etl:null-minted -- --dry-run
npm run etl:null-minted -- --min-match-rate=1.0
```

**This runs before anything else in §5 and before §7, and the ordering has no
second chance.**

A minted `legacy_id` and a genuine one are the same 24 hex characters. The only
thing distinguishing them is whether a MongoDB document with that `_id` exists.
**Once MongoDB is gone that question is unanswerable for ever** — not expensive,
unanswerable.

- Run `--dry-run` first and **compare the per-entity counts against §1.3's
  expectation.** That comparison is the only check that can see a partially
  overlapping source.
- The apply run refuses without `--min-match-rate`. Use `1.0`.
- If it refuses with `ERR_SOURCE_MISMATCH` or `ERR_SOURCE_EMPTY`, **stop.**
  `MONGODB_URI` is not the database the ETL read.

### 5.2 Row counts

For each of users, categories, donations: MongoDB `countDocuments()` against
MySQL `COUNT(*)`. They must be equal. A donation in MongoDB with no MySQL row is
a donor's record that no longer exists.

### 5.3 Donation totals

Sum the donation amounts on both sides. MySQL stores integer minor units; MongoDB
stores a float major unit. **Compare in minor units** — comparing floats is how a
rounding error gets called a match.

A difference of even one paisa is a stop condition, not a tolerance.

### 5.4 The eight pre-flight checks, clean

Re-run `npm run etl:preflight` **after** the load. `declaration-ahead-of-data`
should now be silent — it reports rows present in MongoDB and absent from MySQL,
and running the load is its remedy. **If it still reports, the load did not
carry everything.**

### 5.5 A real read through the application

Log in as a migrated admin. Open the donation list, open one donation, download
one receipt. **Not a query — the application.** The row counts prove the rows
moved; this proves the application can read them.

### 5.6 The source is still the source

Confirm production MongoDB is unchanged since §3.4: same counts, same latest
`_id`. If it moved, something wrote to it during the freeze and §5.2's equality
was measured against a moving target.

---

## 6. Go / no-go

**Named decision, one person: the cutover lead.**

Reopen donations only when every §5 item has passed **and been read**. Record in
the cutover log, against each item, the actual number observed — not a tick.
A log of ticks is indistinguishable from a log nobody filled in.

**Any no-go: reopen donations on MongoDB and roll back.** That is a normal
outcome, not a failure, and it is available only while §7 has not happened.

---

## 7. The rollback boundary

> **The boundary CLOSES at the first real donation written into MySQL.**

Before it: MongoDB is still authoritative and untouched, MySQL can be truncated,
and reopening on the old stack costs a deployment.

After it: MySQL holds a donation that exists nowhere else. Rolling back would
discard a real donor's real payment. **There is no path but forward**, and every
subsequent problem is fixed in place.

This is why §5 is inside the freeze in its entirety. **The purpose of the freeze
is not to make the ETL safe — the ETL is idempotent and refuses rather than
half-loading. The purpose is to keep the rollback boundary open long enough to
verify.**

---

## 8. After the cutover

- MongoDB is **not deleted**. It stays read-only and untouched until Phase 4c,
  which is a separate decision with its own gate. The cost of keeping it is a
  monthly bill; the cost of deleting it early is unrecoverable.
- `JOB_PENDING_SIGNUP_SWEEP` is authorised here if §2.3 found a TTL index.
- Phase 4c removes `models/`, `scripts/seedDatabase.js`, the boot-registration
  gate, the `mongo` compose service and the `mongoose` dependency.
