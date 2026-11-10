# Remediation map

**Package 3.0 (SPEC-3 section 3).** Every known finding in one place: where it
lives, which phase closes it, by what mechanism, and how that is verified.

> **`[location redacted while open]` (CH6, 3 Nov 2026).** This repository is
> public. For every finding still open **in what production runs**, the file
> and line it was found at have been removed. 42 references, all in production's
> code or in the tests that point at it. Production serves `58bdadf`, so a
> finding fixed only on an unmerged branch is still open there, at that line,
> and counts as open here. **Closed findings keep full detail**, as do
> findings that only ever existed on the migration branches.
>
> **What the redaction does not do:** history keeps every earlier version of
> this file, so it slows a reader of the current file down and no more. **When
> a finding's fix is deployed**, restore its location from history
> (`git log -p -- docs/remediation-map.md`) in the same commit that records
> the closure. A finding still marked "open" here is always one somebody can
> go and look for.

This replaces the Phase 1b document that was deferred, and it is the artefact
every later package checks itself against. A package is not complete until the
findings assigned to its file are closed with evidence or explicitly deferred
with a reason, and until this file is updated in the same commit.

**Built from source, not from memory.** Enumerated from
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) and [`decisions.md`](decisions.md),
then **every open status re-verified against the code on `phase-2-data-layer`**
rather than trusted from the review, which is now several packages old. Where a
source document and a later ADR disagree, both are cited and the superseding one
is marked. SPEC-3's own list was used as a starting point to check against, not
as an inventory to copy.

Two statuses changed as a result of that re-verification, in opposite
directions, and both are called out in context below: **SEC-14 is still live**
(believed closed), and **ADR-024 item 2 is closed** (believed open).

---

## Provenance: how each finding was discovered

SPEC-3 asks for this split to be visible in the artefact rather than asserted in
a report, because it is the argument for the test suite.

The mark records how the finding **became known**, not how it was later proved.
SEC-01 was found by reading and the exploit was demonstrated afterwards; it is
marked **R**, because reading was sufficient to find it.

| Mark | Meaning |
|---|---|
| **R** | **Read.** Found by reading source. |
| **X** | **Executed.** Would not have been known without running something - a test, a request, a build, a query, a library warning. |

| | Count |
|---|---|
| **R** - found by reading | 29 |
| **X** - found by running | 15 |
| Status *corrections* forced by running (counted under their original mark) | 3 |

**The 15 X findings**, none of which any amount of reading would have produced:

| ID | What running it revealed |
|---|---|
| ADR-015 | `--default-authentication-plugin` was removed in MySQL 8.4; the container crash-looped. The spec prescribed it |
| ADR-013 | The ETL must not use `INSERT IGNORE` - found by a schema test |
| ADR-018 | MySQL does **not** reject mixed-case ENUM values. `_ci` collation canonicalises them silently, which is the opposite of what SPEC-1A assumed |
| ADR-032 | SEC-09 upgraded from inferred to observed - donor PII seen in actual log output |
| ADR-033 | Duplicate Mongoose index declarations - visible only as a boot warning |
| ADR-035 | react-router advisories unreachable - `npm audit` plus a reachability check |
| ADR-036 | The prisma advisory chain has no published fix |
| ADR-037 | The vite exposure is not build-time only, correcting an earlier triage |
| ADR-043 | `set_real_ip_from 172.16.0.0/12` covers the Docker bridge gateway - a live spoofing hole |
| ADR-048 | The limiter keyed IPv6 on the raw address; and `rateLimiters.js` opened Redis on `require`, so any importing process never exited |
| ADR-049 | The api image was built from the developer's `node_modules` |
| BUG-09 | `PUT /categories/:id` wipes `descriptions` on a partial update - found while writing the characterisation test |
| - | `categories.js` reorder is not atomic; a bad id mid-list leaves earlier writes applied |
| - | A malformed category id 500s where an unknown one 404s |
| ADR-050 | `categories.js` cannot be migrated in isolation - `Category` is read by three unmigrated route files, and `payment.js` prices every donation from it |

**The 3 corrections** are the sharper argument, because each overturned a status
that a document already asserted:

| Finding | Was believed | Running it showed |
|---|---|---|
| SEC-14 | Closed - `test:payment` passes | Still live. The test asserts the outcome; the mechanism is a thrown `RangeError` |
| SPEC-1A §8.2 | MySQL rejects mixed-case ENUMs | It canonicalises them. The ETL assumption was inverted (ADR-018) |
| Phase 2 acceptance | `docker compose up` healthy on a correct image | The image carried host `node_modules` (ADR-049) |

The reading review was good: it found 29 real defects including the critical
one, and reading remains the only way to find most of them. What reading cannot
do is distinguish code that is correct from code that merely looks correct.
Every entry in both tables above sat in that gap.

---

## The characterisation-test rule (AC1, SPEC-3 section 1 amendment)

**Every refusal path asserted in every Phase 3 package must assert the
MECHANISM as well as the outcome.** Concretely, three things:

1. the **status code**,
2. the **response shape**, and
3. that **no unhandled error was raised**.

Asserting only the outcome cannot distinguish *refused correctly* from *crashed
before deciding*. Both leave the database untouched, and "the database is
untouched" is what an outcome-only assertion checks.

**This rule is generalised from SEC-14, which is the worked example.**
[location redacted while open] posts a malformed hash and asserts the donation
stays `Pending`. It passes. The donation does stay `Pending` - because
`verifyHash()` throws a `RangeError` before it can decide anything, the route's
catch block turns that into a 500, and nothing is written. The test was correct
about the outcome and blind to the mechanism, and the mechanism was an
unauthenticated remote crash on a public endpoint. The finding sat behind a
green test.

The failure mode is specific to security gates and worth naming. For ordinary
business logic, "the right thing happened" is usually a sufficient assertion.
For a gate, *crashing* also produces the right visible outcome - fail-closed and
fail-by-exception are indistinguishable from the outside - so the outcome
assertion has no power to separate the code working from the code exploding.
A gate that crashes is still a denial-of-service primitive, and it stops being
fail-closed the moment someone adds a `catch` that returns 200.

This is the same family as ADR-048's wrong-reason test, inverted: there the
assertion was vacuous; here it was real but tested the wrong property.

**Retroactive application is deliberately deferred.** [location redacted while open]
should assert a 4xx and the absence of a thrown error rather than only the
donation state. That change belongs with **`payment.js`'s migration**, alongside the SEC-14
fix, not now - editing a regression suite before the code it guards is changed
would break the "suites pass unchanged" property that every package between here
and there depends on.

---

## Publication gate (AC3)

This map stays tracked - SPEC-3 section 5's "updated in the same commit"
requirement cannot be enforced on an untracked file. The exposure is handled by
a checkable condition rather than by a coupling to DEF-01:

> **Publication requires EITHER zero open findings, OR redaction of file and
> line for everything still open - in THIS MAP and in
> `docs/entity-ownership-audit.md`.**

**Recorded as a Phase 6 gate.**

### WHAT A GREEN `test:no-secrets` DOES AND DOES NOT MEAN (BQ1)

> **A passing `no-committed-secrets` run is NOT evidence that this repository
> contains no secrets, and must not be cited as such at this gate.**

It measures *"no tracked file assigns a non-placeholder value to a
CREDENTIAL-SHAPED NAME"*. A real secret committed as `FOO=8f3a...` is invisible
to it, and **no refinement of the name pattern can fix that** - the information
simply is not in the name.

It is a proxy, kept because the failure it catches is the one that actually
happens: somebody writes `JWT_SECRET=` followed by something that works. The
caveat is written HERE, in the gate, and not only in the test file, because
**the gate is where a green result gets read and a conclusion drawn from it.**
A limitation recorded only next to the code is a limitation the person doing
the release never sees.

**This gate therefore requires a human read of the tracked file list before
publication.** That is weaker than a check and is the strongest thing available,
and per AY1 it does not on its own carry a closure claim.

**THE AUDIT IS COVERED BY THE SAME GATE, added in AR1.** It is tracked for the
same reason - a per-package gate cannot be enforced on an untracked file - and
it carries the same exposure in a more concentrated form: it is an index of
exactly where each entity is written and read, by file and line, which is a
faster route to the seams than the finding list itself. **A file added to the
tracked set inherits the gate; it does not get a quiet exception for being new.**

The reasoning is worth keeping, because the obvious framing is wrong. A map of
**closed** findings with file and line is not an exposure at all - it is good
practice, and it is evidence. It tells a prospective self-hoster what was found,
where, and that it was fixed, which is more than most projects of this kind
offer. The exposure exists **only for open items**, where the same row is a
prioritised worklist for an attacker with the fix time still to run.

So the gate is not "hide the map" and it is not "wait for DEF-01". Coupling it
to the licence would have been convenient and wrong: the two become true at
roughly the same time, but for unrelated reasons, and a condition that happens
to coincide is not a condition.

## The six formerly unassigned findings - NOW ASSIGNED (AC2)

All six had no owning phase when this map was first produced. All six now do.
They stay in their own section rather than being folded into the table, because
four of them are decisions or production sessions rather than code, and folding
them in would make them look like ordinary work items.

| | Finding | Assigned to | Blocks |
|---|---|---|---|
| U-1 | Licence (DEF-01) | **Gary.** Recommendation: Apache-2.0 | Phase 6 |
| U-2 | `verify_payment` reconciliation | **3.4, DESIGN ONLY (re-homed by AT2)** - was 3.5, which no longer exists. The call itself is a later package | nothing |
| U-3 | The `Cancelled` state | **Code to 3.2; the data question to the J3 session** | nothing |
| U-4 | BUG-05 redirect URLs | **HALF CLOSED (AW3).** `.env.example` already matches `App.jsx`. The deployed values need one `vercel env pull` - not a session | nothing |
| U-5 | `for_ocean_security_review.md` at HEAD | **Done in package 3.0** - see below | nothing |
| U-6 | prisma advisory | **DONE (AW3).** 3 high, one chain, in the PRODUCTION tree via `@prisma/client`; not attacker-reachable. Fix deserves its own package | nothing |

### U-1. DEF-01 - the licence is undecided and blocks publication
**Source** ADR-020, ADR-029 (ADR-029 is on the unmerged `docs/incident-j1-j6`
branch). **Provenance R.**

ADR-029 records a three-way contradiction in the licence state on `main`. The
GPL-3.0-only change was withdrawn and is not approved. Until this is settled the
repository cannot be published, which makes it a blocker on the stated goal of a
self-hostable OSS release - not a documentation chore.

**ASSIGNED TO GARY. Blocks Phase 6.** Standing recommendation on file:
**Apache-2.0**. Permissive, so NGOs and integrators can deploy it freely; it
carries an express patent grant; and section 4(d)'s NOTICE clause requires
attribution notices to be preserved in derivative works, which is the closest a
mainstream OSI licence comes to enforceable attribution.

Two things it does **not** do, stated so the choice is not made on a
misunderstanding. It will not compel anyone to keep the footer - nothing short
of a non-OSI clause would, and adding one would cost the project the OSI status
that makes it adoptable. AGPL-3.0 would buy network copyleft, at the cost of
deterring exactly the integrators most likely to deploy this on behalf of NGOs.

Not legal advice; warrants proper review before it is settled.

### U-2. ADR-023 - `verify_payment` reconciliation was nominated for Phase 3 and SPEC-3 does not mention it
**Source** ADR-023. **Provenance R.**

ADR-023 records that the strongest form of the SEC-01 fix does not trust the
callback's signed `status` at all, but calls PayU server-to-server with the
`txnid` and marks the donation from PayU's own answer. Its status line reads
"recorded as a **Phase 3 candidate**". SPEC-3 does not assign it.

**RE-HOMED TO 3.4 BY AT2, DESIGN ONLY. The outbound call is a separate
post-Phase-3 package, gated on sandbox credentials. 3.4 must not block on it.**

**IT WAS ASSIGNED TO 3.5, AND 3.5 CEASED TO EXIST.** Collapsing a package
orphans everything parked against it, and an orphaned deferral is precisely the
U-2-through-U-6 pattern this map already names: a defensible deferral with no
owner. **The pattern recurred on U-2 itself**, which is as clear a demonstration
as the map is going to get that the failure is structural rather than a lapse of
attention.

Found by AL3's grep - the rule that the sequence is stated ONCE, and that every
statement of it must be checked before the order changes. It exists because this
document has contradicted itself before, and it earned its keep here.

What 3.4 owes is that the handler **records enough to reconcile later**:
`mihpayid`, `txnid`, the signed `amount`, and the raw `status` verbatim. All
four already have columns (`db/schema.sql`, `donation_payment_details`) and
`gateway_status` is deliberately stored verbatim rather than as an ENUM, so this
is a constraint on 3.4's handler rather than new schema.

The distinction matters: designing for reconciliation is cheap now and
expensive to retrofit, because a donation whose raw gateway status was never
recorded cannot be reconciled afterwards at all - there is nothing to compare
against. ADR-025 already notes that `gateway_status` will be NULL for the entire
pre-cutover paid population for exactly this reason.

### U-3. ADR-024 item 1 - how a donation legitimately reaches `Cancelled`
**Source** ADR-024. **Provenance R.**

The `Cancelled` payment status is written by `/payment/cancel`, but it is not
established what donor action produces that callback versus an ordinary failure,
and PayU's own vocabulary does not cleanly separate them - a realistic
cancellation arrives as `status=failure` with `unmappedstatus=usercancelled`
(ADR-021). Until it is settled, the meaning of the `Cancelled` enum member is
unclear, which affects the admin filter, the 4a ETL's status mapping, and
any report that counts cancellations.

**SPLIT (AC2). The code goes with `donations.js`; the data question goes to
the J3 session in 4b.** The code half said "3.2" when 3.2 meant donations; the
ADR-055 swap made 3.2 mean auth, and the assignment silently became wrong. A
trigger would not have moved.

PayU documents only `success` and `failure` as signed statuses. So the question
to settle from production data is narrow and answerable: **has any donation ever
actually reached `Cancelled`?** If none has, the enum carries a state nothing
writes, and the decision is whether to keep it for future use or drop it -
which is a 4a schema question, not a route-handler question.

3.2 therefore treats `Cancelled` as a value that may legitimately exist in the
data and must round-trip, and does not attempt to decide what produces it.

### U-4. BUG-05 - post-payment redirect URLs may not match any SPA route
**Source** PROJECT.md BUG-05. **Provenance R.**

`.env.example` used `/payment/success` and `/payment/failure`; `App.jsx` defines
`/payment-success` and `/payment-failure`. With the example values a paying
donor lands on a blank page. This cannot be closed by reading code: it depends
on **the values actually deployed**, which are in Vercel's environment settings
and have never been confirmed.

**HALF OF THIS IS ALREADY CLOSED, AND HAD BEEN FOR SEVERAL PACKAGES (AX5).**
`.env.example` lines 219-220 read `/payment-success` and `/payment-failure`,
which match `App.jsx:180-181` exactly. The documentation defect was fixed and
the finding was never updated - it has been describing a corrected file.

**WHAT REMAINS IS ONE COMMAND, NOT A SESSION.**

```
vercel env pull        # or one look at the dashboard
```

and compare two values against exactly:

```
/payment-success
/payment-failure
```

If they match, U-4 closes entirely. If they do not, every donor who has paid
since the values were set has landed on a blank page after a successful payment.

**The comparison is pre-computed, so whoever reads the values is CONFIRMING
rather than INVESTIGATING.** That is a materially smaller ask than "a production
session" and should be described as one.

Checked and not available from here, both reasons verified rather than assumed:
the Vercel tooling in this session can WRITE environment variables and not read
them, and the backend deployment is `BLOCKED` with `live: false`, answering 404 -
so behavioural probing is unavailable too. (The invalid-hash path would otherwise
have revealed `FRONTEND_FAILURE_URL` without any credential, since it redirects
before any hash check passes.)

### U-5. SEC-17 (second half) - `for_ocean_security_review.md` is tracked in the repository root
**Source** SEC-17; ADR-030. **Provenance R.**

It was a 984-line exploit-level vulnerability report, tracked at HEAD.

**CLOSED IN PACKAGE 3.0 (AC2).** `git rm`'d from HEAD. A copy is preserved at
`docs/for_ocean_security_review.md`, which `docs/*` already excludes, so the
content is not lost to the team; and `for_ocean_security_review.md` is now in
`.gitignore` so a `git add -A` from the repository root cannot quietly restore
it. **ADR-030 still owns the history scrub in Phase 6** - removing a file from
HEAD does not remove it from the history, and anyone with a clone still has it.

Three references existed. Two are prose in `decisions.md` and this map and are
correct as history. The third was in `README.md`, and dealing with it surfaced a
larger problem in the same file - see the note below.

The first half of SEC-17 (`Frontend/.env`, confirmed tracked) stays with Phase 5.

**The README was publishing what the review was being withheld to protect.**
Its security section stated that the review is "held outside version control on
purpose: it contains exploit-level detail that should not be published", and
then enumerated five findings with their mechanics - including, at the time of
writing, three that are still open. It also still described SEC-01 and SEC-02 as
open, which they have not been since `ad31074`. Rewritten in package 3.0 to name
only the closed findings and to point at this map; the open ones are no longer
described. The exclusion of `SECURITY-REVIEW.md` from version control had been
undone in the file most likely to be read first.

### U-6. ADR-036 - the prisma advisory has no published fix and no review trigger
**Source** ADR-036. **Provenance X** (found by `npm audit` against the committed
lockfile). **On the unmerged `docs/incident-j1-j6` branch.**

No published version fixes it; the decision was to monitor. "Monitoring" had no
owner, no cadence and no trigger condition, which in practice means it is
noticed when someone next runs `npm audit` by accident.

**ASSIGNED (AC2): a TRIGGER, not a cadence. Check at the start of every phase.**

A cadence would be wrong here. The thing being waited for is a publication event
that nobody controls, so a weekly check is mostly wasted and a monthly one is
mostly late. A phase boundary is when the answer can actually be acted on.

**A published prisma >= 8.1.0 is a TOOLCHAIN CHANGE, not a dependency bump.**
Prisma generates the client, owns the migration engine and is the subject of
ADR-002's five documented gaps. Taking it requires the full gate set re-run -
`test:schema`, `test:data-layer`, the drift gate, and the migration-reproduces-
the-schema check in `schema.yml` - not just a green `npm audit`. Budget it as a
package, not as a line in one.

Owner: whoever opens the next phase. Recorded here so the trigger has somewhere
to live.

---

## Findings that changed status during this package

### SEC-14 is NOT closed. A passing test was concealing it.

`verifyHash()` in [location redacted while open] guards with a **character**-length
comparison and then decodes as hex:

```js
if (expected.length !== received.length) return false;
return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
```

A 128-character non-hex value passes the guard and then decodes to **zero
bytes**, because `Buffer.from` stops at the first invalid pair. Verified by
execution:

```
expected chars 128 -> bytes 64
received chars 128 -> bytes 0
THROWS: RangeError: Input buffers must have the same byte length
```

[location redacted while open] sends exactly this (`'z'.repeat(128)`) and
passes, because it asserts the *outcome* - the donation stays `Pending` - and
the outcome is right. The request 500s, the throw is caught by the route's
handler, nothing is written. It fails closed.

**But it fails closed by crashing, not by returning `false`,** and the test
cannot tell those apart. So this is the same shape as ADR-048's wrong-reason
test, in the opposite direction: there the assertion was vacuous, here the
assertion is real but tests one property (no state change) while a second
property (the handler does not throw on unauthenticated input) silently
regressed and stayed regressed.

Not exploitable for payment fraud. It is an unauthenticated remote 500 on a
public endpoint, and it is the finding the review actually raised - "malformed
hash input crashes response verification" - still true.

**Trigger: `payment.js` migrates.** Fix: validate `/^[0-9a-f]{128}$/i` before decoding.
Verification: extend the existing test to assert the response status, not only
the donation state.

### ADR-024 item 2 IS closed, and the source document does not say so

ADR-024 records that `/success` replaced `paymentDetails` wholesale, destroying
whatever the webhook had written, whichever arrived second. Closed by
`a2b4556`, merged as `b201818`, and now covered by two tests
(`/success merges payment details instead of replacing them`, `a webhook
followed by /success preserves the webhook data`). **ADR-024 supersedes nothing
here - it is simply older than the fix. Marked closed below.**

---

## Closed findings

| ID | Severity | Finding | Closed by | Verified by | Prov |
|---|---|---|---|---|---|
| SEC-01 | Critical | Failed payment replayable as successful | `264ae25` / merge `ad31074` | `test:payment` 17/17; exploit reproduced before the fix (3/7 -> 7/7 -> 16/16) | **R** |
| SEC-02 | High | Reset code brute-forceable, no attempt cap | `264ae25` / merge `ad31074` | `test:auth` 6/6; cap verified at `auth.js:431,486` | **R** |
| SEC-12 | Medium | No dependency lockfiles committed | `74d6c33` | Both lockfiles tracked; CI now uses `npm ci` | **R** |
| ADR-024 §2 | - | `/success` destroyed webhook `paymentDetails` | `a2b4556` / merge `b201818` | 2 tests in `test:payment` | **R** |
| ADR-045 | - | `controllers/authController.js` took `role` from `req.body` | `476cf00` | File deleted; `grep` shows zero importers | **R** |
| ADR-043 | - | `set_real_ip_from 172.16.0.0/12` covered the Docker bridge | `476cf00` | `test:trust-proxy` 4/4; proven by injection - restoring the block made the spoof believed | **X** |
| ADR-048 | - | Limiter keyed IPv6 on the raw address | `476cf00` | `test:data-layer`; proven by injection | **X** |
| ADR-048 | - | Redis connected on `require`, so importers never exited | `476cf00` | Suite no longer hangs; store is lazy | **X** |
| ADR-049 | - | Image built from the developer's `node_modules` | `e85a173` | `Backend/.dockerignore`; image 1.08GB -> 695MB; clean rebuild healthy | **X** |

**SEC-04 is deliberately absent from this table.** Half of it is closed -
`app.set('trust proxy', 1)` is at `app.js:50` and proven through Nginx. The
limiter store is not wired; [location redacted while open] still constructs a default
in-memory limiter. Per ADR-042 the finding stays open until **`auth.js` migrates**
and swaps the import. Reporting it closed on the strength of the store existing is
precisely the error ADR-042 was written to prevent.

---

## Package 3.1r - COMPLETE. ADR-056 closed for categories.

**The specific thing ADR-056 demanded is proven.** A category that existed in
MongoDB BEFORE the ETL is now listed by `GET /api/categories`, updatable by
`PUT` using its original ObjectId, and deletable by `DELETE` - with the
migrated data, not with data the suite created after the switch.

The suite asserts the BEFORE state too: un-migrated, it is absent from the list.
That is the defect, demonstrated to have existed rather than merely described.

**AK3's fixture is structural, per AM1.** It is created AFTER the ETL run so no
hook ordering can migrate it, and the suite asserts POSITIVELY that it has no
MySQL row before exercising the route. Demonstrated by injecting the wrong
ordering: the control fires with its own message and only that scenario fails.

    SETUP ERROR: the AK3 fixture has a MySQL row, so it was migrated after
    all. The ordering in this test is wrong and every assertion below is
    vacuous.

**The injection also found a real bug in the setup**: `resetData()` never
cleared MySQL users, so rows accumulated across ETL runs and the next one
collided on `uq_users_email` - because `createUser` mints a fresh ObjectId each
time, giving a new `legacy_id` for an address that already existed. The
injection failed on that collision instead of on the assertion it was meant to
prove, which is how it was found.

25 scenarios. The original 3.1 closure notes follow.

### Superseded: Package 3.1 - NOT COMPLETE (re-opened by ADR-056)

**The route migration below is correct for records created in MySQL and WRONG
for every record that predates it.** A category that exists only in MongoDB is
invisible to `GET /api/categories` and 404s on edit and delete. Re-opened as
3.1r: once 4a can migrate the categories data locally, the route is re-verified
against it and an AK3 fixture is added. The findings it closed (SEC-19, BUG-08,
BUG-09, the falsy-amount check, ADR-004) are unaffected - they are properties of
the handler, not of where the data lives.

The original closure notes follow, and remain accurate about everything except
completeness.

`routes/categories.js` is migrated to MySQL and imports no Mongoose. The blocker
recorded here previously (ADR-050) was resolved by AD1: Option D, a read-through
bridge for the six unmigrated read sites.

**Delivered**

| | |
|---|---|
| `routes/categories.js` | rewritten against `repositories/categories`; no Mongoose |
| `services/categoryBridge.js` | temporary, deleted in 3.6 (the BRIDGE goes in 3.6; Mongoose itself survives in `etl/` until 4c - ADR-059); logs and counts every MongoDB fallback |
| `test/categories-characterisation.test.js` | 22 scenarios, green BEFORE and AFTER the migration |
| `test/category-bridge.test.js` | 11 scenarios, both paths plus twelve malformed inputs |
| six read sites | `payment.js` x2, `admin.js` x1, `donations.js` x4 |

**The characterisation evidence.** Twelve assertions passed untouched across the
migration. Ten changed, each marked `CHANGED IN 3.1` in the test file with the
finding that caused it. That ratio is the whole argument for writing them first:
without them, "the category endpoints still work" would have been an opinion.

**Findings closed in this package**

| ID | What changed | Verified by |
|---|---|---|
| SEC-19 | `err.message` no longer reaches the client from any of the five handlers | `SEC-19: no internal error text reaches the client` - three probes, asserting the body matches none of Cast/ObjectId/Prisma/mongo |
| BUG-08 | `limit` clamped to 100; non-numeric page/limit is a 400 instead of a 200 carrying nulls | two scenarios |
| BUG-09 | partial `PUT` no longer wipes `descriptions`; an explicit `[]` still clears them, because "omitted" and "set to empty" are different requests | `BUG-09: a partial PUT no longer wipes descriptions` |
| falsy-amount | `donationAmount: 0` is refused because it is not positive, not because it is "missing" | `donationAmount 0 is refused, and now says WHY` |
| malformed-id 500 | a malformed id is a 404 like any other unknown id (AD1b) | `a MALFORMED id is now a 404` |
| ADR-004 | delete is now archive; the category stays resolvable for the donations that reference it | two scenarios plus a bridge test |

**Deliberately NOT closed here (AD3)**

| | Why |
|---|---|
| reorder is not atomic | Needs `withTransaction` and belongs with the rest of the transaction work. The crash it used to cause IS fixed - an unresolvable entry is now skipped and counted rather than raising a CastError mid-batch - but the partial write remains, and the test pins it so that fixing it later requires a deliberate edit. |

**New in this package**

| | |
|---|---|
| ADR-051 | The external id stays a 24-hex ObjectId for the rest of Phase 3, because `Donation.category` is a required ObjectId ref. **The 4a ETL must not read `legacy_id IS NULL` as "created after cutover".** |
| ADR-050 exit condition | `categoryBridge.fallbackCount()` must be zero over a real run before the bridge is deleted in 3.6 |
| incidental | `donations.js:265` populated `"name description price"`; two of those three are not fields on the Category schema, so it only ever returned `name`. The bridge returns the whole category - a superset. Flagged for 3.2. |

---

## BUG-10 - a single authenticated admin request triggers a bulk delete, with no confirmation (AF4)

**Severity** Medium. **Provenance X** - found by the AD2 read-dependency
analysis, which enumerates callers rather than reasoning about purpose.
**Trigger: `dataCleanupService` is retired, which happens with `donations.js`.**

`POST /api/admin/cleanup/trigger` ([location redacted while open]) calls
`triggerManualCleanup()`, which deletes donations older than ten years, and
users older than ten years who have no donations.

**What is NOT wrong, checked rather than assumed:**

- **It is not reachable by a non-admin.** `router.use(adminAuth)` at
  [location redacted while open] guards every route in the file, including this one. A non-admin
  gets 403, an unauthenticated caller 401. This was the specific question asked,
  and the answer is no.
- **The blast radius today is zero rows.** Both deletes are bounded by a
  ten-year window and this project has no data that old. The finding is latent,
  not live, and saying otherwise would overstate it.

**What IS wrong:**

1. **No confirmation step.** One authenticated POST with an empty body starts an
   irreversible bulk delete. A `GET /cleanup/preview` dry run exists, but
   nothing requires it to be called first and nothing ties a trigger to a
   preview anyone actually read.
2. **It returns 200 immediately and deletes in the background.**
   `triggerManualCleanup().catch(...)` is not awaited, so the caller is told
   "started" and never learns the outcome. The response body says to check the
   server logs.
3. **Failures are swallowed.** Both functions `return 0` from their catch
   blocks, so a partial delete and a clean no-op are indistinguishable to every
   caller - including to the log line that is the only record.

Taken together: the one operation in the system that destroys donor records has
the weakest feedback of any endpoint in it.

**Mechanism.** Retire `dataCleanupService.js` with `donations.js` and repoint the
endpoint at `services/scheduler.js`, which already implements the same retention
rules against MySQL and takes a `dryRun` flag. Make the dry run the default, so
a real delete requires an explicit parameter. Return the counts rather than
logging them.

**Verification.** Characterisation test first, pinning current behaviour
including the immediate 200 and the empty body; then the same test edited
visibly.

**Why it sat unnoticed** is ADR-053: BUG-04 established that the CRON never
fires, and that was allowed to stand for "the code does not execute". Those are
statements about one caller and about all callers.

---

## BUG-11 (CLOSED) - a refused request named its reason under three different keys

**Severity** Low. **Provenance X** - found while writing package 3.2's
characterisation tests; the refusal helper had to be widened to accept a third
key name. **CLOSED** - fixed ahead of the reason-asserting suites, per AG2.

Route handlers answer `{error}`, `adminAuth` answers `{message}`, and
`authMiddleware` answers `{msg}`. Counted across the middleware and
`donations.js` alone: 12 `error`, 9 `message`, 4 `msg`.

A client that wants to show the user WHY a request was refused cannot read one
field. It has to try all three, which in practice means it reads none of them
and shows a generic failure - so every carefully worded refusal message in the
codebase is invisible to the person it was written for.

Assigned to 3.3 rather than 3.2 because two of the three names come from the
middleware, and changing the route file alone would leave the inconsistency
while looking like it had been fixed.

---

## BUG-12 - two endpoints disagree about what "not found" means (AG3)

**Severity** Low. **Provenance X** - found by the 3.2 characterisation baseline.
**Owning package: whichever migrates `donations.js`.**

`PUT /api/donations/:id` has no not-found branch. `findByIdAndUpdate` returns
null for a missing donation and the handler answers **200** with
`{ message: "Donation updated", donation: null }`. `PATCH /api/donations/:id/status`,
doing the same job on the same resource, returns a correct 404.

A caller integrating against the first has no way to tell a successful update
from an update of nothing: the status says success and the message says
"updated". Pinned as current behaviour in the baseline; the fix is a visible
edit to that assertion.

---

## BUG-11 compounds AC1 - the inconsistent error shape weakens the rule (AG2)

Recorded as a dependency rather than a second finding.

AC1 requires every refusal path to assert its MECHANISM, including the reason.
**A test asserting a reason has to know which key to read**, and this codebase
answers under `error`, `message` or `msg` depending on which layer refused.
Package 3.2's baseline hit this directly: the refusal helper accepted two of the
three and reported a real refusal as a malformed one.

The consequence is that the helper must accept all three, which means it can no
longer assert that a SPECIFIC key carries the reason - so it verifies less than
AC1 asks for. Every reason-asserting test written before BUG-11 is fixed is
weaker than it looks.

**BUG-11's fix is therefore a PREREQUISITE for the reason-asserting tests in the
packages that follow it, not a UX improvement.** It is assigned to the package
that owns the middleware, which under the ADR-055 order is now 3.2 - so the
dependency resolves before `donations.js`, `payment.js` and `admin.js` write
their characterisation suites. That is fortunate rather than planned, and worth
noting because the previous order would have had three suites written against
the inconsistent shape.

---

## A guest donation cannot be retrieved by the person who made it (AG4)

**Record, do not fix.** Product question for Phase 5, alongside U-3.

`GET /api/donations/:id` resolves ownership by comparing the caller's id to
`donation.userId`. For a guest donation that field is null, so `isOwner` can
never be true and only an admin can read it. The donor who made the donation
cannot retrieve their own record.

That is arguably correct - there is no authenticated identity to match against,
and matching on donor email instead would let anyone read any guest donation by
guessing an address. But it is currently **an accident of the data model rather
than a decision**, and the distinction matters: nobody chose it, so nobody has
weighed it against giving guests a receipt-lookup path.

Pinned in the 3.2 baseline so the behaviour cannot change silently while the
question is open.

---

## SEC-03 RECLASSIFIED - unauthenticated authentication bypass, and it is LIVE (AI1)

**Was** High - "NoSQL operator injection through JSON request bodies".
**Is** **CRITICAL - unauthenticated authentication bypass on the login path.**
**Provenance** R originally; the reclassification is **X**.

`POST /api/auth/login` with

```json
{"email": {"$ne": null}, "password": "<any password some user has>"}
```

matches the first user in the collection, passes `bcrypt.compare` against **that
user's** hash, and proceeds to generate and store a login OTP
([location redacted while open]). The attacker is **past the credential check**, holding a
pending OTP for an account whose address they never knew.

### Why the original classification understated it

**"Injection" named the MECHANISM and hid the OUTCOME.** It is an accurate
description of how the input is mishandled, and it invites the reader to picture
the usual consequence of query injection - data disclosure, or a malformed query
- rather than the actual one, which is that authentication does not hold. The
finding was filed with four others in the same band and read as one more input-
validation issue.

A severity derived from the mechanism is a guess at the outcome. This one was
wrong by a whole band, and it stayed wrong through a security review, a
remediation plan and a finding map, because every reader after the first
inherited the label rather than re-deriving it.

### IT IS LIVE IN PRODUCTION

The Package A hotfix closed SEC-01, SEC-02 and `trust proxy`. **It did not touch
SEC-03.** The deployed system carries this bypass today. It is currently
unreachable **only because MongoDB rejects the application's credentials** - an
availability failure standing in for an access control.

**HOTFIXED ON THE MONGO STACK (AN1).** Branch `hotfix/sec-03-auth-bypass`, off
`main`. The earlier instruction not to write one assumed package 3.2 would land
soon; Phase 3 now has four packages left plus 4b, and production returns to
service on MongoDB in the meantime. Weeks of a live unauthenticated auth bypass
on a public donation platform outweighs the duplicate-work argument.

The hotfix rejects non-scalar request bodies on every auth route. It is deleted
at the cutover: package 3.2 replaces the file with parameterised SQL, which
closes the CLASS rather than this instance.

**It is not closed in production until that branch merges AND DEPLOYS.** Until
then the deploy-before-restore ordering still guards it, along with SEC-01's
successor conditions.

**Do not write a Mongo-side hotfix for it.** Sanitising the query on the old
stack duplicates work the migration deletes, and parameterised SQL closes the
class rather than one instance of it. The correct response is to finish and
deploy 3.2, and until then to leave Atlas down.

---

## SEC-08 is CLOSED on /login, and is easy to reintroduce (AI4)

Both an unknown address and a wrong password return `400 {"error":"Invalid
credentials"}`, byte for byte ([location redacted while open]). I assumed otherwise and the
test showed it.

**The reintroduction risk is the useful half.** The natural repository
implementation returns `null` for a missing user and `false` for a bad password.
Reporting those separately - "no account with that address" and "incorrect
password" - **reads like better error handling**, and it is the change a
reviewer would approve without hesitating. It silently reopens user enumeration
across the whole login surface.

The warning is placed **next to `repositories/users.verifyPassword` and
`findByEmail`**, not only in the test, because the person about to make this
mistake is reading the repository and not the suite.

---

## Two method findings (AI3)

Both are evidence for rules already in force, recorded where a reader will meet
them rather than only in a commit message.

**SEC-03: the SMTP 500 would have read as a refusal.** The injected login
returns `500 {"error":"Failed to send OTP email"}` in any environment without
SMTP. An assertion checking only the OUTCOME - "the attacker did not get a
session" - passes, and the finding stays hidden behind it. It was found because
AC1 requires the MECHANISM to be asserted, and the mechanism here is that the
request reached the OTP-generation code at all. **AC1's case, found by AC1's
rule.**

**SEC-13: a probe aimed at the wrong place passed for the wrong reason.** Driven
through `/forgot-password`, the plaintext-storage check saw nothing - because
the email send fails first and the code is never written. It would have read as
"SEC-13 is already fixed". Driven through `/login`, where the OTP is saved
BEFORE the send, the plaintext is plainly visible.

Same shape as ADR-048's `:0099:` test: **a probe pointed at the wrong place
produces a green result that means nothing**, and a green result is the one
outcome nobody investigates. The difference between the two cases is only that
one asserted `notEqual` on equal values and this one asserted presence on a
field that was never written.

---

## BLOCKER - package 3.1 would empty the donation form (ADR-056)

**STOP. Read ADR-056 before any further route migration.**

Probed against the running stack: a category that exists only in MongoDB - which
is every category in production, since no ETL has run - is invisible to
`GET /api/categories` (it returns `[]`) and 404s on edit and delete.

**Deployed as it stands, package 3.1 empties the public donation form.** The
branch has never been deployed, so production is unaffected today.

The read-through bridge covers the wrong direction. It lets UNMIGRATED readers
resolve one record by id, which it does correctly. It does nothing for the
MIGRATED route's own list, update and delete paths, because those address a
STORE rather than a record.

**Third ordering constraint, and the one that governs:**

> A route's LIST and WRITE paths cannot migrate before that entity's DATA has
> migrated. Single-record reads can be bridged. Lists and writes cannot.

**Why 22 green characterisation scenarios missed it.** Every fixture was created
through the seam, which after the switch writes to MySQL. The suite migrated its
own data along with the route and then asserted the route works on it - 22
scenarios, green before and after, not one exercising a record that predated the
migration.

The coverage rule was followed to the letter and still missed this, because it
says to pin the endpoint's behaviour and says nothing about the PROVENANCE of
the data it is pinned against. AE3 made exactly this point about the fallback
check - "a database of only new records cannot take the fallback path, so it
proves nothing" - and it was not generalised to the suites. That generalisation
is the lesson, and it is cheap to apply: every characterisation suite needs at
least one fixture created in the OLD store.

Four options in ADR-056. The recommendation is C, one cutover before the route
migrations - which reorders two phases and makes J3 critical-path, so it is not
a package decision.

---

## Map maintenance: a sequence stated twice is a sequence that will contradict itself (AL3)

The map carried TWO contradictory sequences at once - the corrected table in one
section, SPEC-3's original numbering in the per-package headings - and it is the
artefact every package checks itself against. A reader following either was
right about half the time.

**This belongs in the same class as SPEC-1A section 5.6's mihpayid claim**
(ADR-012, corrected by ADR-026): not an ABSENT protection but a MISLEADING one,
which is worse, because it confers confidence without conferring correctness.
An absent sequence would have sent a reader to ask. A wrong one sent them to
work.

**Maintenance rule: when a sequence changes, grep the map for every other
statement of it before committing.** The headings are now keyed by file and
trigger precisely so there is only one statement of the order left to maintain -
but the rule stands for anything else that gets stated twice.

---

## BUG-02's mechanism, confirmed by behaviour rather than by reading (AM3)

The claim has been '''Mongoose's enum is not enforced on
`findByIdAndUpdate`''', taken from the security review and repeated since.
**Several decisions lean on it**: the ENUM columns in `db/schema.sql`, ADR-018's
ETL counting requirement, SEC-16's severity, and BUG-03.

It is now verified, and the verification was an accident. While writing the ETL
suite, a fixture seeding `status: 'approved'` through `Donation.create()` was
REJECTED by Mongoose:

```
ValidationError: `approved` is not a valid enum value for path `status`.
```

So the enum IS enforced on `create`, and the mixed-case data can only have been
produced by a path that skips validation - which is `findByIdAndUpdate`, exactly
where the review said. Seeding the test data required `collection.insertOne` to
bypass validation the same way the real bug does.

**Independent confirmation obtained while doing something else is worth more
than a re-read**, because it could not have been shaped by expecting the answer.
Recorded because the claim had been inherited rather than tested, and inherited
claims are what SEC-03's misclassification and the two contradictory sequences
were both made of.

---

## The inherited-claim rule (AN3)

> **A claim that several decisions rest on must be verified BY BEHAVIOUR at
> least once. Do not carry it from the document that first asserted it.**

A claim in a review, a spec or an ADR is an observation someone made once. Every
reader after the first inherits it, and the inheritance is invisible: the claim
reads the same whether it was tested yesterday or guessed three years ago. The
more decisions rest on it, the less likely anyone is to re-derive it, because by
then it is load-bearing and questioning it looks like wasted effort.

**The worked example - BUG-02.** The claim was "Mongoose's enum is not enforced
on `findByIdAndUpdate`". Four things rest on it: the ENUM columns in
`db/schema.sql`, ADR-018's ETL counting requirement, SEC-16's severity, and
BUG-03. It had been repeated through a security review, a project document, a
finding map and three packages, and never run.

It was confirmed by accident. A test fixture seeding `status: 'approved'`
through `Donation.create()` was REJECTED:

```
ValidationError: `approved` is not a valid enum value for path `status`.
```

So the enum IS enforced on `create`, and the mixed-case data can only have come
from a path that skips validation - which is `findByIdAndUpdate`, exactly where
the review said. **Confirmation obtained while doing something else is worth
more than a re-read**, because it could not have been shaped by expecting the
answer.

**Three findings in this project were inherited claims that turned out wrong or
understated:**

| Claim | Inherited from | What running it showed |
|---|---|---|
| SEC-03 is "NoSQL operator injection", High | the security review | An unauthenticated authentication bypass. The title named the mechanism and hid the outcome |
| SPEC-1A section 5.6: the `mihpayid` UNIQUE index is the SEC-01 replay defence | the spec, repeated in ADR-012 | `mihpayid` is unsigned and attacker-mutable. The index is integrity only (ADR-026) |
| The package sequence | SPEC-3, then restated in the map | Two contradictory sequences in one document (AL3) |
| SEC-08 lists `/login` as leaking via `needsSignupVerification` | the security review | **Wrong.** That branch is reached only after `bcrypt.compare` SUCCEEDS, so a caller without the password gets the same `Invalid credentials` as any other failure. Read the branch (AP3) |
| AE1-b's trigger is `donations.js` | AE1, restated in the map, revised once by AK5 | **Wrong file.** The ObjectId ref is written by `payment.js:141`. Enumerate the WRITE sites (3.3) |
| `services/scheduler.js` "already implements the same retention rules" | the BUG-10 mechanism | **Two of three.** The inactive-account purge had no MySQL equivalent, and retiring `dataCleanupService` would have dropped it (3.3) |
| `auth.js`'s auto-verify branch is "narrowed to accounts that predate the OTP flow" | **my own comment, package 3.2** | **Never implemented.** The branch applies to everyone. The narrowing was described in a comment and the code was not changed to match (AJ3) |

Each was correct-looking, repeated, and load-bearing. That combination is the
signature, and the countermeasure is cheap: **run it once.**

**EIGHT NOW, and the signature is holding as a predictor.** The seventh is the
most instructive, because **it is one I wrote**: a comment asserting a narrowing
that was never implemented. Every countermeasure in this section assumes the
inherited claim came from somewhere else. This one shows the generator is the
act of writing a confident sentence near code, not the age of the document.

**The eighth arrived during the audit commissioned because of the seventh**
(BUG-03 is not "always 0" - it counts the lowercase subset, measured at 1 of 2).
That is the argument for AR6's gate in one line: **the claims do not run out, and
every pass that looks for them finds one.** That is worth knowing
with three packages left: it means the remaining inherited claims are more
likely to be wrong than a base rate would suggest, and AJ3's severity pass
should be read as an application of this rule rather than a separate exercise.
They fell in five consecutive packages, each found by doing something else.

**THE TWO FROM 3.3 SHARE A SHAPE WORTH NAMING: both were claims about WHICH FILE
or WHICH COMPONENT does something, not about whether it is done.** "Donations
migrate" and "the scheduler implements the retention rules" are both true
sentences attached to the wrong subject. A claim of that form survives review
because the reviewer checks the predicate, which is correct, and the countermeasure
is to enumerate the call sites rather than reason about the name - which is how
both were found, and is AD2's method applied to something other than ordering.

**Applies to AJ3's severity pass**, which is the same rule aimed at one class of
claim - a severity derived from a mechanism is an inherited guess at an outcome.

---

## AW2 - the destructive-assertion audit. One finding, and it is not a test.

**AW1's question, applied to every assertion in 259 tests that something is
cleared, voided, disabled, locked, deleted or revoked at a threshold or on a
failure count:**

> What does an attacker gain by reaching that threshold ON SOMEONE ELSE'S
> BEHALF?

**The absences are evidence, so every one is listed - including the "nothing"s.**

### The matrix

| Assertion | Threshold | What an attacker gains by triggering it on a third party |
|---|---|---|
| `setActive(false)` increments `token_version` (`data-layer:225`) | an admin disables an account | **Nothing.** Only an admin reaches it |
| admin password change revokes sessions (`admin-char:604`) | an admin sets a password | **Nothing.** Only an admin reaches it |
| `setPassword` increments `token_version` (`data-layer:182`) | the password changes | **Nothing.** Requires already controlling the account or a valid reset code |
| the reset code is CONSUMED on success (`auth-reset:281`) | a CORRECT code is used | **Nothing.** Requires the code, at which point they have won already |
| the attempt counter is NOT cleared at `/verify` (`auth-reset:294`, ADR-034) | — | **Nothing** - it asserts a non-clearing, which is the safe direction |
| the attempt counter IS carried by the ETL (`etl:216`) | migration | **Nothing.** Carrying it is the conservative choice; resetting would hand an in-progress attacker a fresh budget |
| expired pending signups are swept (`data-layer:710`) | 24 hours | **Nothing.** The rows expire by design and hold only unverified attempts |
| the retention purge deletes donations (`data-layer:826`) | ten years + AT1's gates | **Nothing.** Unreachable without an operator's explicit authorisation |
| DELETE archives a category rather than removing it (`categories:810`) | an admin deletes | **Nothing.** Only an admin reaches it, and ADR-004 made it a soft delete |
| the reset code SURVIVES the cap (`auth-reset:263`) | 5 wrong codes | **Nothing - this is the one AV1 FIXED.** It previously read `hasResetCode === false` and was the finding AW1 records |
| **`signupOtpAttempts` is reset to 0 by `upsert`** (`data-layer:246`) | **a second `/signup` for the same address** | **SEE SIGNUP-01 BELOW** |

### Ten of eleven are "nothing", and the reason is structural

**Every safe one has the same property: the threshold is reachable only by
someone who already holds the authority the destruction represents** - an admin,
or the holder of a valid code, or the passage of time. The unsafe one is the
only case where an ANONYMOUS third party can reach the threshold.

That is a sharper form of AW1's question, and it is worth stating as the rule
this audit actually found:

> **A destructive threshold is safe when reaching it requires authority the
> destruction itself presupposes. It is dangerous when an unauthenticated party
> can reach it on someone else's behalf.**

### SIGNUP-01 - PRE-REGISTRATION ACCOUNT TAKEOVER

**Severity: High. Provenance X - proved by probe, output below. NOT introduced by
package 3.5a; found by auditing in its neighbourhood.**

`POST /api/auth/signup` is unauthenticated and accepts any address. For an
address with NO account it stores a pending signup containing **the name, the
role and the PASSWORD HASH the caller supplied** - and emails that address a
code saying *"Thank you for joining For Ocean Foundation! To complete your
registration, please verify your email address with this code."*

**If the recipient enters that code, an account is created with the ATTACKER'S
PASSWORD, and the attacker can sign in as them.**

Measured, end to end:

```
--- 1. ATTACKER initiates a signup for the victim address ---
  status: 200 {"message":"Registration initiated. Please check your email..."}
  pending row created: true
  name stored: Totally The Victim
  password hash is the ATTACKER-chosen one: true

--- 2. Can an attacker RESET the OTP attempt counter by re-posting? ---
  attempts before re-post: 4 -> after: 0

--- 3. If the victim verifies, WHOSE password does the account have? ---
  verify status: 200
  account created: true
  ATTACKER PASSWORD WORKS ON IT: true
```

**Three separate problems, and the third is the one that matters:**

1. **An attacker can destroy a legitimate in-flight signup.** `upsert` replaces
   the whole row, so re-posting the address invalidates the OTP already sitting
   in the victim's inbox. Repeatable.
2. **`signupOtpAttempts` resets to 0 on every re-post.** It does not help brute
   force - each re-post also changes the code - but a counter that any
   anonymous caller can reset is not a counter.
3. **THE ACCOUNT IS CREATED WITH THE ATTACKER'S PASSWORD.** The victim believes
   the account is theirs. Everything they subsequently do - donations, profile,
   receipts - is visible to whoever chose that password.

**The email is the whole attack surface**, and it currently reads as a
legitimate welcome. It thanks the recipient for joining something they did not
join, and asks for an action. Contrast 3.5a's new notice, which was written for
a recipient who did not initiate the request and says *"you do not need to do
anything"* and *"we will never ask you for your password or a verification code
by email."* **The template written for the untrusted case is careful; the one
that has always existed is not.**

### CLOSED IN AX1 - and recommendation 1 was NOT what closed it

**Recommendation 1 - the email warning - is IMPLEMENTED and is a MITIGATION.**
It asks the recipient to make the right decision. It cannot make the attack
fail, because the attack succeeds precisely when the recipient makes the wrong
one, and no test can assert that a human read a paragraph.

**What closes it: `/signup/verify-otp` now requires the password the signup was
started with.**

> **The OTP proves control of the ADDRESS. It does not prove who STARTED the
> signup.** Those are different facts and the flow treated them as one.

The password is the only thing the initiator holds that a recipient does not:

| | Knows the password | Outcome |
|---|---|---|
| a genuine signer-up | yes - they chose it | verifies |
| an address owner who did not sign up | **no** | **cannot verify** |

**`/login` already required exactly this** before re-sending an OTP for a pending
signup - the precedent was in the same file, and the strictly more dangerous
endpoint did not have it.

The frontend already held the password in state across both steps of its
single-page flow; it simply never sent it. One field.

**Proved by running the attack, not by asserting the line is present**
(`test:auth-char`): the attacker initiates, re-posts to reset the counter, the
victim enters the code - **and no account is created.** With a control test that
a genuine signup still completes, so the proof is not that the endpoint is
broken.

### STILL NOT IMPLEMENTED, with their evidence

**Recommendation 2 - do not reset `signupOtpAttempts` on a re-post.** Still
live: the test above ASSERTS the counter resets from 4 to 0, so the residual is
pinned rather than assumed closed. It no longer contributes to takeover, because
the chain breaks later; it remains a counter any anonymous caller can reset.

**Recommendation 3 - rate-limit `/signup` per ADDRESS.** Still live. An attacker
can still destroy a legitimate in-flight signup by re-posting the address, since
`upsert` replaces the row and invalidates the OTP already in the victim's inbox.
That is a denial of registration, not a takeover.

**Neither is inherited as "probably fine" - both are asserted or stated with the
behaviour that establishes them.**

---

## Package 3.5a - SEC-08's LAST ORACLE CLOSED

`config/email.js` gains one template and `/signup` uses it. AQ2's audit said it
would be one template; it was one template.

### Both halves are required

A uniform response with no email behind it is **a lie to the attacker and a
SILENCE TO THE VICTIM** - the person whose address was used would never learn it
happened. So the existing-account path sends a notice and says the same thing to
the caller either way.

**What the notice must not do**, which is the whole design:

- **No code and no link.** Someone who does not control the address caused it to
  be sent. Anything actionable is a capability handed to them if that mailbox is
  ever compromised, and this recipient has nothing to DO.
- **It does not say who tried.** We do not know - the attempt carries an address
  and a name the attacker typed, and no verified identity.
- **It does not echo the attacker's `name`.** Reflecting it would let anyone
  send arbitrary text to any address in the system, in an email from us. The
  greeting uses the name on the EXISTING account; the only attacker-controlled
  value in the message is the address, which the recipient already knows.

### I INVERTED THE ORACLE BEFORE I CLOSED IT

The first version made only the NOTICE fire-and-forget and left the OTP path
awaiting its send, rolling back and answering 500 on failure.

**That did not close the oracle - it turned it around.** With mail degraded, an
address that HAS an account answers 200 and one that does not answers 500, which
distinguishes them perfectly. Worse than before, because the 500 looks like an
infrastructure problem rather than a disclosure.

**The asymmetry was in the branch I was not editing.** My own comment at that
site anticipated the shape and named the wrong branch. The test caught it on the
first run; reading the code did not.

`/signup/resend-otp` had already been made fire-and-forget for exactly this
reason, **in the same file, three functions away.** A precedent that close and
still not applied is the argument for running the thing rather than reasoning
about it.

### THE COST, STATED

A user whose address genuinely bounces is told "check your email" and receives
nothing. That is inherent to a uniform response and it is the price SEC-08 asks.
The pending row is now KEPT rather than rolled back, so `/signup/resend-otp` is
a real recovery path, and the 24-hour sweep removes it if nobody uses it.

### One field is excluded from the byte-comparison, with an argument

`email` differs between the two responses because each **echoes the address the
caller sent**. That is definitionally not a disclosure - the attacker chose the
value. Every other field must match byte for byte, and the test additionally
asserts that the excluded field IS a pure echo and that both bodies carry the
same KEYS, so it cannot quietly become a carrier later.

**An exclusion with an argument is different from a comparison that never
looked**, which is the distinction AP1 is actually about.

### What is NOT closed

**A TIMING difference.** The new-account path hashes a password and writes a
row; the existing-account path does neither. That is a far weaker signal than a
distinct message, and closing it means constant-time signup - a different piece
of work. Recorded here rather than left implied by the absence of a comment.

---

## AZ2 - A DELETION CRITERION ATTACHED TO A FILE IS WRONG WHEN THE FILE'S CONTENTS HAVE DIVERGENT LIFETIMES

ADR-047 said `docker-compose.legacy-mongo.yml` exists only while `config/db.js`
does. **That is true of one half of the file and false of the other:**

| What the override provides | Dies when | Package |
|---|---|---|
| `MONGODB_URI` on the api service | `config/db.js` goes | **3.6** |
| the `mongo` SERVICE itself | 4b's snapshot rehearsal has restored into it and the ETL is gone | **4c** |

Amended with a superseding note rather than rewritten, per the ADR-012
precedent - the original reasoning is what makes the correction legible.

### The generalisation

> **A deletion criterion attached to a FILE is wrong when the file's contents
> have divergent lifetimes. Attach it to the CAPABILITY instead.**

"Delete `docker-compose.legacy-mongo.yml` when `config/db.js` goes" binds two
capabilities that happen to share a file. The criterion that survives is
"the api stops needing `MONGODB_URI`" and, separately, "nothing needs a local
MongoDB".

### The sweep - every remaining "delete X when Y" where X is a FILE

| Criterion | X is a file or a capability? | Verdict |
|---|---|---|
| ADR-047, the override | **FILE** - two capabilities in it | **The finding above.** Split |
| ADR-050, delete the bridges when `fallbackCount()` is zero | capability - "nothing needs the MongoDB fallback" | **Safe.** And it is measured, not declared |
| AE1-a, NULL minted `legacy_id`s before MongoDB is deleted | capability - "MongoDB is still readable" | **Safe**, and the ordering is the whole point |
| AV2's boot-registration gate, "delete in the same commit that removes Mongoose" | **FILE-shaped** - it names a commit, not a condition | **Corrected by ADR-059.** It said 3.6; Mongoose survives in `etl/` until 4c, so the gate still has a subject. Re-homed |
| ADR-033, duplicate index declarations "moot once the models go" | capability - "no Mongoose schema is loaded" | **Safe** |
| U-5 / ADR-030, the history scrub in Phase 6 | capability | **Safe** |

**Two of six were file-shaped, and both were wrong.** That is a high enough rate
to be worth the sweep rather than a note.

---

## AZ3 - WHAT AY2's FOURTH INSTANCE UNDERCUTS

**It is not only a finding about a fix. It undercuts the assumption behind every
ADR in this repository.**

The practice here rests on: *write the reasoning down, next to the thing, and it
will be available to whoever needs it next.* Fifty-nine ADRs, a remediation map,
and comment blocks longer than the functions they describe all assume it.

**AX4 is a counter-example at the shortest distance the assumption could
possibly be tested at.** `/signup/resend-otp` was fire-and-forget WITH A COMMENT
SAYING WHY - "so a mail failure cannot distinguish by status either". Three
functions later, in the same file, in the same editing session, I made only one
branch fire-and-forget and left the sibling awaiting its send. And the comment I
wrote at the site I WAS editing reasoned about that exact risk and named the
wrong branch.

> **Writing a thing down does not make it available to whoever needs it next. Not
> at any distance, including three functions, including when the person who needs
> it is the person who wrote it, forty minutes later.**

### What that means for the practice, stated honestly

**The ADRs are not worthless - but their value is not where it feels like it is.**

- **They are excellent for the reader who already suspects something** and goes
  looking. Every inherited-claim correction in this project was found by someone
  asking a question and finding the answer recorded.
- **They are close to useless as a CONTROL at the point of change.** A document
  consulted only by someone who already suspects the problem cannot prevent the
  problem, because the person about to make the mistake does not suspect it -
  that is what makes it a mistake.

### The countermeasure is ENUMERATE-AND-STATE AT THE POINT OF CHANGE

Not "read the ADR". Not "check nearby". **At the moment of fixing an asymmetry,
list every sibling and write down what each one does.** That converts the check
from something requiring suspicion into something requiring only a list - and a
list can be produced by someone who has no idea what they are looking for, which
is precisely the person who needs it.

**Every mechanical gate in this project has the same shape and that is why they
work**: the drift gate, the migration-state self-check, the boot-registration
set, the destructive-job authorisation. None requires anyone to suspect anything.
**The ADRs explain those gates; they do not substitute for them**, and AX4 is the
clearest evidence that they cannot.

---

## AY1 - A MITIGATION THAT DEPENDS ON A HUMAN CANNOT CARRY A CLOSURE CLAIM

**Recorded because the instruction was wrong, and that is worth keeping as
carefully as a wrong implementation.**

AX1 asked for SIGNUP-01's recommendation 1 - a warning in the signup email - to
be proved to the same standard as the finding: the attack failing end to end.

**That was not possible, and the impossibility is structural rather than a
matter of effort.** The warning asks the recipient to decide correctly. The
attack succeeds precisely when they decide incorrectly. A test can assert the
paragraph is present; it cannot assert that a human read it, believed it, and
acted on it - and the case where they did not is the entire attack.

> **When a recommendation's effectiveness depends on a human reading something,
> it CANNOT carry a closure claim under AU2. Either it is paired with a
> MECHANICAL control that can, or the finding stays OPEN with the mitigation
> noted.**

Added to the per-package criteria. It is the natural completion of AU2: that
rule says a closure claim must cite the behaviour establishing it, and this says
what to do when no behaviour can.

**Asking for proof of an unprovable control is itself a defect in the
instruction**, and it is a quiet one - it reads as rigour. The tell is that the
proof would have to assert something about a person rather than about the
system.

For SIGNUP-01 the answer was the second branch: the warning shipped as a
mitigation, and `/signup/verify-otp` requiring the initiating password is the
mechanical control that carries the closure.

---

## AY2 - THE ADJACENCY PATTERN: a control a few functions from where it was missing

**Four instances in this phase, and the fourth is the most surprising.**

| # | The control that existed | Where it was missing | Distance |
|---|---|---|---|
| 1 | SEC-08 unified on three endpoints (3.2) | a fourth endpoint differing on body text (AP1) | same file |
| 2 | `passwordProblem`, one validator for five paths | `admin.js` had a sixth, check 10 / message 6 (AT5) | one file away |
| 3 | `/login` required the pending password before re-sending an OTP | `/signup/verify-otp` did not require it at all (AX1) | **same file** |
| 4 | `/signup/resend-otp` was fire-and-forget, WITH A COMMENT SAYING WHY | `/signup`'s OTP path awaited its send (AX4) | **three functions** |

### The fourth is different in kind

The first three are a control not propagating. **The fourth is CORRECT REASONING,
WRITTEN DOWN, IN THE SAME FILE, failing to reach the next function** - and worse,
my own comment at the site I was editing reasoned about the exact risk and
attributed it to the wrong branch.

**This is AK3's meta-lesson at a smaller and far more surprising scale.** AK3 was
about a rule stated for one control failing to propagate to others - a
documentation-level failure over packages. This is the same failure over
FUNCTIONS, within a single editing session, with the explanation already visible
on screen.

### The countermeasure, and why "check nearby" is not it

> **When fixing an asymmetry, ENUMERATE every sibling branch and endpoint in the
> same file and STATE, for each, whether it has the same property.**

Not "check nearby". **"Nearby" is what has failed four times.** The enumeration
has to be written down, because the failure mode is not forgetting to look - it
is looking and not seeing, which an unwritten check cannot catch. Three of the
four had the answer already present in the file.

Added to the per-package criteria. **Applied retroactively in 3.6** for each fix
this phase that turned on a branch condition.

---

## AX4 - THE INVERTED ORACLE. Eleventh inherited claim, and it made things WORSE.

Package 3.5a's first version made only the signup-attempt NOTICE
fire-and-forget, leaving the OTP path awaiting its send with a rollback and a
500.

**That did not close the oracle. It turned it around** - and the new one is
worse than the original:

| | Known address | Unknown address |
|---|---|---|
| Before 3.5a | `400 "User already exists"` | `200` |
| **After the first attempt** | `200` | **`500`** (mail degraded) |
| After the fix | `200` | `200` |

### WHY THE INVERTED FORM IS WORSE THAN THE ORIGINAL

**A 500 reads as infrastructure, not as disclosure.** The original oracle was a
message that said in plain words what it revealed - anyone auditing it could see
it. The inverted one looks like a mail outage, which is a thing that genuinely
happens, and an operator seeing intermittent 500s on signup investigates SMTP.

**The oracle goes quiet while staying open.** That is the worst of both: it still
distinguishes the two cases perfectly for anyone probing, and it no longer looks
like a security finding to anyone maintaining.

### THE ASYMMETRY WAS IN THE BRANCH I WAS NOT EDITING

I was writing the existing-account branch. The defect was in the new-account
branch, which I had not touched and therefore did not re-read - and **my own
comment at the site I WAS editing named the wrong branch**, reasoning about the
risk correctly and attributing it backwards.

**Three functions away in the same file, `/signup/resend-otp` had already been
made fire-and-forget for exactly this reason**, with a comment saying so: "Fire
and forget, so a mail failure cannot distinguish by status either."

A precedent that close, already applied, in the same file, for the same reason,
and still not carried across. That is the strongest argument available for
running the thing rather than reasoning about it: **the reasoning was present,
correct, and written down, and it still did not reach the adjacent branch.**

---

## AW1 - A TEST THAT ENCODED A HARM AS A REQUIREMENT, AND THEN PROTECTED IT

**Its own class. The three neighbours are all about CONTROLS; this one is about
a TEST.**

| | What was wrong |
|---|---|
| **AT3** | the FIX instantiated the shape its rule prohibited |
| **AU3** | the CONTROL was correct only where nothing was at stake |
| **AV2** | the control was RIGHT; its model of the code and the runtime's diverged |
| **AW1** | **nothing was a control at all.** A TEST asserted a harm as a requirement, and the discipline protecting tests then protected the harm |

### The shape, in four steps

1. **`clearResetCode` at the cap defended nothing.** An exhausted counter
   refuses the code without ever comparing it, so voiding it removed no
   capability from an attacker.
2. **It handed anyone who knows an address a five-request denial of service** on
   that user's pending reset. Request a reset for someone, guess five times,
   their code is destroyed. Repeat.
3. **SEC-02's regression suite asserted it as a requirement**, in good faith:
   `assert.equal(u.hasResetCode, false, 'the reset code must be voided at the cap')`.
4. **It survived because it reads like defence in depth.** "The code is voided
   at the cap" is the sentence a careful person writes. Nothing about it looks
   like a mistake, and the assertion message argues for itself.

### THE UNCOMFORTABLE PART, WHICH BELONGS IN THE RECORD

**The discipline that makes tests trustworthy is what gave this its
durability.**

- *Do not edit scenarios quietly* (SPEC-3 section 4.1) meant nobody could remove
  it without a deliberate act and a written justification.
- *Assert the strongest true thing* (BUG-11, AP1) meant it was written as a
  tight, specific assertion rather than a loose one - which made it harder to
  drift past.
- *A regression suite must pass UNCHANGED* meant every subsequent package
  treated it as fixed ground.

**A WRONG ASSERTION INHERITS THE PROTECTION BUILT FOR RIGHT ONES.** Every one of
those rules is correct and I would keep all three. The cost of them is that a
mistake written in the protected form is more durable than one written
carelessly - and the more security-shaped the mistake sounds, the longer it
lasts.

That is not an argument for weaker discipline. It is an argument that the
discipline has no opinion about whether an assertion is CORRECT, only about
whether it is STABLE, and something else has to supply the first.

### The countermeasure, as a question

Added to the per-package acceptance criteria:

> **For any assertion that a control DESTROYS or REVOKES something at a
> threshold, ask: what does an attacker gain by reaching that threshold ON
> SOMEONE ELSE'S BEHALF?**

A question rather than a rule, because the answer is often "nothing" and the
assertion is then correct - the point is that it must be ASKED, not that the
pattern is forbidden. `setActive(false)` incrementing `token_version` is exactly
this shape and is right: an attacker cannot reach that threshold, only an admin
can.

**AW2 applies this question to every existing suite.**

---

## AW3 - which open items are BLOCKED, and which are merely PARKED

**Applying AV3's instinct: "deferring a question a public document answers is
how a blocker acquires a dependency it never had."**

| Item | Verdict |
|---|---|
| **U-1** Licence | **Genuinely blocked, on a PERSON.** Not a lookup - it is a choice about what the organisation wants. No document answers it |
| **U-3** the `Cancelled` state, data half | **Genuinely blocked.** Needs a count from production MongoDB. That is J3 |
| **U-4** BUG-05 redirect URLs | **HALF ALREADY CLOSED, and the map did not say so. The rest is narrower than recorded** - see below |
| **U-6** prisma advisory | **NOT BLOCKED. Done - see below** |
| **J3** production Mongo credentials | **Genuinely blocked.** Credentials |
| **4b** snapshot rehearsal | **Genuinely blocked.** Depends on J3 |
| **PAY-03** firstname 20 in PayU's TEST env | **Genuinely blocked** on a sandbox run - but the DOCUMENTED half is already extracted (AV3), so the sandbox exercise is a confirmation rather than an investigation |

### U-4 - the `.env.example` half is ALREADY FIXED

The map says: "`.env.example` used `/payment/success` and `/payment/failure`;
`App.jsx` defines `/payment-success` and `/payment-failure`."

**Checked. `.env.example` lines 219-220 now read:**

```
FRONTEND_SUCCESS_URL=https://donation.example.org/payment-success
FRONTEND_FAILURE_URL=https://donation.example.org/payment-failure
```

**Which match `App.jsx:180-181` exactly.** The documentation defect was fixed at
some point and the finding was never updated - it has been describing a
corrected file for several packages.

**What remains is the DEPLOYED values, and that is genuinely unreachable from
here** - two independent reasons, both checked rather than assumed:

1. The Vercel tooling available to this session can WRITE environment variables
   and cannot READ them. `get_project` returns framework, domains and deployment
   state; no environment values.
2. Behavioural probing is unavailable: the backend deployment's `readyState` is
   `BLOCKED` and `live` is `false`, and the production domain answers 404. (The
   invalid-hash path would otherwise have revealed `FRONTEND_FAILURE_URL`
   without any credential, since it redirects before any hash check passes.)

**But it is no longer a "production session".** It is one `vercel env pull`, or
one look at the dashboard, comparing two values against exactly:

```
/payment-success
/payment-failure
```

The comparison is pre-computed, so whoever reads the values is confirming rather
than investigating. **That is the difference AV3 is about**: the task did not
shrink, the part of it that needed a human did.

### U-6 - the prisma advisory check, DONE

The item was "trigger, not cadence - start of every phase", and Phase 4 is next.
Run against the deployed tree:

```
deepmerge-ts  <8.0.0   HIGH   stack exhaustion on recursive object graphs
  @prisma/config
    prisma
3 high severity vulnerabilities
```

**The chain IS in the PRODUCTION tree, and the obvious reading is wrong.**
`prisma` is declared a devDependency - so the natural conclusion is "build
tooling only". `npm ls` says otherwise:

```
@prisma/client@6.19.3      <- a production dependency
`-- prisma@6.19.3
  `-- @prisma/config@6.19.3
    `-- deepmerge-ts@7.1.5
```

`@prisma/client` pulls `prisma` transitively. **Checking the declaration would
have given the wrong answer; checking the tree gave the right one.**

**It is not reachable by an attacker.** `deepmerge-ts` is used by
`@prisma/config` to merge Prisma CONFIGURATION, which is developer-controlled.
No request path reaches it, and stack exhaustion needs attacker-controlled
recursive input.

**Its own package, 4d, AFTER 4c (AZ1)** - so that a failure in either cannot
be attributed to the other. The fix is a
Prisma bump, which regenerates the client - the one dependency the entire data
layer sits on. It deserves a full suite run of its own rather than being
absorbed into a package that is already removing Mongoose.

---

## AV1 - the per-address reset cap. SEC-02 vs SEC-08 RESOLVED.

**`config/rateLimiters.resetAttemptLimiter`.** Five attempts per address per
fifteen minutes, shared by `/forgot-password/verify` and `/reset`.

### AQ1's three requirements, and how each is met

**1. COVERS ADDRESSES WITH NO ACCOUNT.** It is a limiter, not a column. A column
can only exist for an address that has a row, which was the whole problem.

**2. CAPS THE RESPONSE, NOT THE ACCOUNT.** It is a WINDOW: it expires by itself,
writes nothing to the user's row, and `/forgot-password/request` is deliberately
NOT behind it, so a delayed user can always obtain a fresh code and a fresh
per-account budget. A per-address counter that disabled anything would be a
denial-of-service primitive handed to anyone who knows an address.

**3. FULL BODY IDENTICAL AT THE CAP.** Asserted with `deepEqual` over the whole
body, in `test:auth-char`, for an address with an account and one without.

### THE UNIFORMITY IS STRUCTURAL, NOT MAINTAINED BY HAND

The cap response is produced by MIDDLEWARE, before the handler, before anything
has been looked up. **There is no code path in which the two cases could
diverge** - as opposed to two branches a later edit has to keep byte-identical.

That distinction is the lesson of AP1, which exists because my first SEC-08 fix
unified three endpoints and left a fourth differing on body text. A property
maintained by construction does not need the discipline that one maintained by
agreement does.

### VOIDING THE RESET CODE WAS A GRIEFING PRIMITIVE, AND A TEST REQUIRED IT

The old cap did `clearResetCode(user.id)`. It defended nothing - an exhausted
counter refuses the code without ever comparing it - while letting anyone who
knows an address destroy that user's pending reset with five requests.

**SEC-02's regression suite asserted it**: `'the reset code must be voided at the
cap'`. A regression test was requiring a denial-of-service primitive, in good
faith, because "the code is voided" reads like defence in depth. That is the
most useful thing in this package: **a test can encode a harm as a requirement,
and the more security-shaped the assertion sounds, the longer it survives.**

### The deliberate edit (SPEC-3 section 4.1)

Stated rather than made quietly, with the before and after in the test file
itself:

| Before | After |
|---|---|
| `status === 429` | `status === 400` |
| `/Too many attempts/i` | `'Invalid verification code'` |
| `hasResetCode === false` - *"must be voided at the cap"* | `hasResetCode === true` - **must SURVIVE the cap** |
| `passwordIsOriginal === true` | **unchanged** - the security property, and it still holds |

The 429 has not disappeared. It moved to the per-address limiter, which produces
it for EVERY address. SEC-02's control still announces itself; it no longer
announces who has an account.

### A TEST THAT PASSED WITH A FALSE PREMISE

`auth-characterisation`'s oracle test went green after the limiter landed and
before it was edited: the known address tripped the new per-address cap at 429,
and the unknown address - a DIFFERENT address with its own untouched bucket -
still answered 400. The assertion held and its premise was gone.

**A test can survive the removal of the thing it was written to pin, when what
it measures is a side effect rather than the property.** It only failed honestly
once rewritten to drive BOTH addresses to the cap, which is what the finding was
always about.

### DEPLOY-01, a third time

A per-address cap over a 15-minute window plus a shared, durable Redis store
made `test:auth` fail on its FIRST request with `429/0` - the previous run's
budget, on a stable fixture address. The first two instances were per-IP; this
bucket is one no amount of varying the client address can escape. Fixture
addresses are now unique per run.

---

## AV2 - A CORRECT CONTROL, ACTING ON A CORRECT FINDING, BROKE A LIVE PATH

**Its own class. Not AT3, not AU3, and the difference is the useful part.**

| | What went wrong |
|---|---|
| **AT3** (3 instances) | the FIX was wrong - it instantiated the shape its rule prohibited |
| **AU3** | the CONTROL was incomplete - correct on the subset where nothing was at stake |
| **AV2 (PAY-02)** | **nothing was wrong.** The finding was real, the control was right, the remedy was correct, and a live path broke |

AT4's gate says: no file may import the Mongoose model of an entity whose
authoritative store is MySQL. `routes/admin.js` imported `models/User` and used
it nowhere. The gate flagged it; the import was removed; both were correct.

And `GET /api/payment/status/:txnid` started answering 500 to every request,
because `.populate('userId')` resolves through Mongoose's GLOBAL MODEL REGISTRY
and that `require()` was the only thing populating it.

### The statement

> **A correct control acting on a correct finding can break a live path when its
> MODEL OF THE CODE and the RUNTIME'S MODEL diverge.**
>
> AT4 checks REFERENCES. Mongoose's model registration is a SIDE EFFECT OF
> MODULE LOADING. Those are different properties, and no amount of care about
> the first tells you anything about the second.

The control was not checking the wrong thing - "does a file reference a migrated
model" is exactly the right question for the coupling AT4 was built to find. It
is that the ANSWER to that question does not determine whether the import can be
removed, and nothing in the question hints that it might not.

### U-6 IS THE SAME CLASS (AX2)

`prisma` is declared a **devDependency**. The obvious reading is "build tooling
only, not shipped". `npm ls` says otherwise:

```
@prisma/client@6.19.3      <- a PRODUCTION dependency
`-- prisma@6.19.3
  `-- @prisma/config@6.19.3
    `-- deepmerge-ts@7.1.5   <- the advisory
```

**Checking the DECLARATION gives the wrong answer. Checking the TREE gives the
right one.** The declaration is a statement of intent; the tree is what npm
installs. Those are different properties, exactly as "does a file reference a
model" and "does loading it register one" are different properties.

Filed here rather than as a dependency note, because the interesting part is not
the advisory - it is that a reasonable person checks `package.json`, concludes
"dev-only", and is wrong.

### The countermeasure is NOT a better import checker

That is the tempting conclusion and it is wrong. A checker that also understood
Mongoose's registry would miss the next registry - a decorator, a plugin system,
an `express.Router` collected at import time, a `process.on` handler. **The
space of load-time side effects is not enumerable by static analysis**, which is
precisely why they are side effects.

> **REMOVALS GET THE SAME INJECTION-PROOF STANDARD AS ADDITIONS.**

This project already proves a gate by breaking the thing it guards and watching
it fail. That discipline had only ever been applied to what a change ADDS.
PAY-02 says a deletion is a change to the running system and earns the same
treatment: delete it, run the thing that might have depended on it, and look.

Concretely, the cost of catching PAY-02 was one request to an endpoint in the
file's blast radius - and the baseline that eventually caught it was written one
package later, for a different reason, because AU1 required it.

### The gate, and ITS OWN EXPIRY DATE

`test/migration-state.test.js` asserts the exact set of Mongoose models the app
registers at boot. As of package 3.4 that set is **empty**.

**IT MUST BE REMOVED IN PACKAGE 4c, IN THE SAME COMMIT THAT REMOVES MONGOOSE
(corrected by ADR-059 - Mongoose survives 3.6 in `etl/`, so the gate still has a
subject until 4c).**
Once no Mongoose exists, the gate guards a coupling that cannot occur - and a
gate protecting nothing is AU3's shape one package out: it passes forever,
nobody can tell whether it still works, and it makes the suite look better
covered than it is.

Recorded here AND in the test's own comment, because a note in only one of the
two is how a gate outlives its subject.

---

## AV3 - the txnid length claim: CLOSED from the public documentation

**Carried as UNVERIFIED for exactly one package, and closed without a sandbox.**

Package 3.4 replaced the guessable `TXN${Date.now()}${rand(0,999)}` reference
(16-17 characters, proven against the live gateway) with 80 random bits
(23 characters). The claim "PayU accepts 23 characters" rested on reasoning
rather than on an observation, and it was the ONLY unverified claim on the money
path.

**PayU documents it:**

> "Transaction ID (or Order ID) generated at the merchant end. Must be unique
> for every new transaction. **Character limit: 25.**"
> — https://docs.payu.in/reference/addl_info-payment-apis

23 of 25, alphanumeric, two characters of headroom. **Asserted by
`test:payment-char` so the headroom cannot be spent by someone lengthening the
reference for entropy without knowing there is a ceiling.**

It did not need the sandbox credentials at all - the `llms.txt` route reached it
in three fetches. Worth noting because the instinct was to defer it to 4b, and
deferring a question that a public document answers is how a blocker acquires a
dependency it never had.

### THE SAME PAGE SURFACED A SHARPER ONE: PAY-03

| Field | Production limit | **TEST limit** |
|---|---|---|
| `firstname` | 60 | **20** |
| productinfo | 100 | 100 |
| email | 50 | 50 |
| udf1-udf5 | 255 | 255 |

**`firstname` is truncated to 20 characters in PayU's TEST environment and 60 in
production.** Our own callback fixtures use
`'ZZZ SYNTHETIC TEST DO NOT PROCESS'` - **33 characters**.

**Why that is a trap rather than a detail.** `firstname` is a SIGNED field: it
appears in both the request hash and the response hash. If PayU's test
environment stores a truncated value and signs its response with that, the
response hash is computed over a different string than the one we sent, and
`verifyHash` refuses it. **Every sandbox payment would fail hash verification,
and the symptom - "invalid_hash" - points at the hashing code, which is correct.**

It is not live today: nothing reaches PayU from the test suite. It becomes live
the moment anyone runs a sandbox payment, which is the first thing 4b does.

**Assigned to Phase 4b's pre-cutover checklist**, alongside the credentials
dependency. The fix is to keep the donor name under 20 characters in any sandbox
exercise, or to confirm PayU rejects rather than truncates - a distinction the
documentation does not make and which decides whether this is a nuisance or a
silent one.

---

## PAY-02 - AS7 broke the donor receipt lookup by deleting a DEAD IMPORT

**Severity** High, availability. **Provenance X** - found by extending the
payment baseline BEFORE touching `payment.js`, which is the order AU1 required.
**Live on `phase-2-data-layer`; never reaches production, because 3.3 and 3.4
are one merge unit and 3.4 repairs it.**

`GET /api/payment/status/:txnid` calls `.populate('userId', 'name email')`.
Mongoose resolves that through a GLOBAL MODEL REGISTRY, and the only thing
registering `User` in the running process was `const User = require("../models/User")`
at `routes/admin.js:3`.

**AS7 deleted that line as a dead import - correctly, by AT4's own gate.** The
binding genuinely was unused; package 3.1 had replaced every USE with the bridge.

Measured:

```
models registered at boot: Donation
User registered? false

GET /api/payment/status/TXN... -> 500
{"error":"Failed to check payment status",
 "details":"Schema hasn't been registered for model \"User\"."}
```

The frontend calls it at `Frontend/src/utils/api.js:272` - it is the receipt
lookup a donor hits after paying.

### AN UNUSED BINDING IS NOT AN UNUSED IMPORT

`require()` does work. In a module system with side effects, an import can be
load-bearing through a registry that **no reference-level analysis can see** -
and AT4's check is exactly a reference-level analysis. It was right that
`admin.js` must not import a migrated model. The REMEDY had a consequence the
check does not model.

This is the inverse of AT4's own lesson. AT4 said an audit organised around
USAGE cannot see declarations that are never used. PAY-02 says some of those
declarations **are not unused at all** - they are used by something that is not
a reference.

### The gate

`test/migration-state.test.js` now asserts **the exact set of Mongoose models
the app registers at boot**, each with a reason for being there. Exact rather
than minimum, so it catches both directions:

- a model silently DROPPED - PAY-02, and something using `.populate()` starts
  throwing
- a model silently REINTRODUCED - a route reaching back to Mongoose

It runs in a child process with a deliberately unreachable `MONGODB_URI`, since
registration happens at `require()` time and needs no connection.

**Proved by injection.** Re-adding a `models/User` import to a boot-loaded file
fails BOTH gates - the AT4 import check and this one - and they are not
redundant: the import check sees an import being ADDED, and cannot see the last
registration being REMOVED, which is the direction that broke this.

### SEC-06 is currently MASKED by it, which is not the same as fixed

The status endpoint returns the whole donation - name, email, phone, amount - to
a caller with no credential. Right now it cannot, because it 500s first.

**The map has recorded this exact shape before.** SEC-03 was "currently
unreachable ONLY because MongoDB rejects the application's credentials - an
availability failure standing in for an access control". It was not a defence
then and it is not one now: repair the registration and the disclosure is live
again. The characterisation suite therefore asserts the MECHANISM is still
present without depending on the broken path.

---

## AT1 - destructive jobs need AUTHORISATION, separate from migration state

**`config/destructiveJobs.js`.** A job runs only when its own gate is on AND
migration state says deleting is safe. Neither implies the other.

| | Decides | Changed by |
|---|---|---|
| `SCHEDULER_ENABLED` | whether jobs are **registered** | an operator |
| `config/destructiveJobs` | whether a job may **delete** | an operator, per job |
| `config/migrationState` | whether deleting would be **safe** | a code change, verified against the source tree |

### The finding

AS7 migrated `routes/admin.js`. That moved `user` to `mysql`. **That made the
inactive-account purge runnable** - a change in what gets deleted, falling out of
a change to an admin console, decided by nobody.

**It would have recurred and doubled.** Package 3.4 moves `donation` to `mysql`,
which under the old arrangement authorises the donation retention purge on the
same transition - two destructive jobs going live at once, on a commit whose
subject is a payment route.

**MIGRATION STATE IS A SAFETY PRECONDITION, NOT AN AUTHORISATION.** It says the
rows are all in one place. It says nothing about whether anyone wants them gone.

### Per-job, not one flag

A single "destructive jobs enabled" switch reproduces the problem one level up:
enabling the harmless-sounding pending-signup sweep would authorise the donation
retention purge in the same keystroke.

### Every job states what leaving it OFF costs

Asserted by a test, because otherwise "off" reads as the cautious choice
everywhere and one of these is a retention obligation going unmet:

| Job | Off means |
|---|---|
| `JOB_RETENTION_PURGE` | donations retained past the stated ten years - a documented policy not enforced is its own finding |
| `JOB_INACTIVE_ACCOUNT_PURGE` | personal data kept for accounts nobody has used in a decade |
| `JOB_PENDING_SIGNUP_SWEEP` | **turn this one on first.** Name, email and bcrypt hash per row, replacing a TTL index that used to expire them continuously |

### The gates run BEFORE the job does anything, and that was a finding of its own

They sat after the candidate count, which short-circuits on zero - **so a job
with nothing to delete never revealed that it was unauthorised, and would begin
refusing the day a row first qualified.** An operator would have read months of
clean logs and then a sudden refusal.

Found by a test failing with "Missing expected rejection" on the pending-signup
sweep. Dry runs still skip both gates: counting is not destructive, and the
preview is how an operator decides whether to authorise at all.

### Three outcomes, three answers

`ERR_JOB_NOT_AUTHORISED` is logged at INFO and answered `409` with the variable
that enables it. `ERR_NOT_AUTHORITATIVE` is logged at WARN. A genuine failure is
logged at ERROR and says rows may have been partially deleted. **Nobody asked for
this, this would destroy data, and this crashed partway are three different facts
and an operator acts differently on each** - warning nightly about the first
trains them to ignore the channel the third arrives on.

### Asserted, as AT1 required

`test/destructive-jobs.test.js`, in its own file because putting it beside the
migration-state suite would quietly assert the two questions are one:

- **moving `donation` to `mysql` does NOT make its purge runnable** - simulated,
  because waiting for 3.4 to find out is the sequence that produced the finding
- the same for `user`, which needs no simulation: AS7 already moved it
- authorisation alone is not enough; safety alone is not enough; **both open and
  it actually deletes** - the control without which the refusals prove only that
  the job never runs
- authorising one job does not authorise another

---

## AT3 - A FIX CAN INSTANTIATE THE SHAPE IT WAS WRITTEN TO PREVENT

**Twice, in two consecutive packages, and both times only execution caught it.**

| The rule | The fix | What the fix turned out to be |
|---|---|---|
| ETL-01: an option that can only make things worse is worse than no option | narrow the override so it does not apply to loader-refused findings | **a documented flag applying to NOTHING** - the same defect one level up |
| ETL-01, honoured: report the declaration drifting ahead of the data | make the new finding BLOCKING | **a gate that prevents its own remedy** - blocking stops the load, and running the load is what fixes that finding |

### Why review does not catch these

**The fix reads as compliant, because it was written by someone holding the rule
in mind.** A reviewer checks the fix against the rule and finds agreement - which
is exactly what the author checked. Both of these would have passed any review,
including a hostile one, because the defect is not in the relationship between
the fix and the rule. It is in the relationship between the fix and the system,
and that only appears when the code runs.

The first was found by running the ETL and watching a flag apply to nothing. The
second by running the pre-flight and watching a load refuse to perform its own
remedy. Neither was found by reading.

### THE THIRD INSTANCE, AND IT HAPPENED INSIDE THE COMMIT THAT RECORDED THE PATTERN (AU3)

| The rule | The fix | What the fix turned out to be |
|---|---|---|
| AT1: a purge must not go live as a side effect | gate each destructive job on its own authorisation | **the gates sat AFTER the candidate count**, which short-circuits on zero - so the gate was unreachable exactly when the job had nothing to do |

**Three instances now, and this one was written in the same commit that recorded
the first two.** Knowing the pattern, naming it, and putting it in the map did
not prevent me from producing it again forty minutes later.

That is the strongest available evidence that **this is not an attention
failure**. It is structural: the fix is authored by someone holding the rule in
mind, so it reads as compliant to the only two people who will ever check it -
the author and a reviewer applying the same rule.

### The family resemblance: A CONTROL VALIDATED ONLY ON THE CASES IT WAS NEVER NEEDED FOR

This instance has a sibling that is not a fix at all, and the shape is worth
naming because it recurs:

| | The control | Worked correctly on | Was absent exactly where it mattered |
|---|---|---|---|
| **ADR-048** | rate-limit keying | **every IPv4 client** - counted, throttled, metrics healthy | IPv6 clients, who hold ~2^64 addresses each and had an unlimited budget |
| **AT1 (this)** | the destructive-job gates | **every run with nothing to delete** - refused nothing, deleted nothing, logs clean | the first run with a qualifying row, which is the only run that can do harm |

> **A control validated only on the cases where nothing was at stake.**

In both, the control is CORRECT on the subset it is exercised against, and that
subset is precisely the one where its correctness is worthless. Observation makes
it worse rather than better: the IPv6 gap looked like a healthy limiter, and the
gate gap looked like months of clean scheduler logs. **The evidence of working
and the evidence of not working are the same evidence**, which is why neither
review nor monitoring finds them.

The countermeasure is the same in both cases and it is not vigilance: construct
the case where it matters, and run it. ADR-048's IPv6 finding came from a
library warning firing during a test run; AT1's came from a test asserting a
rejection that did not arrive.

### The consequence: THE INJECTION-PROOF STANDARD APPLIES TO FIXES, NOT ONLY GATES

This project already proves gates by injection - break the thing, watch the gate
fail, restore it, watch it pass. The standard was applied to *controls*: the
drift gate, the IPv6 keying, `set_real_ip_from`, the AK3 ordering, the LIKE
escaping.

**Extend it to fixes.** For a fix to a finding of the form "X is a bad shape",
demonstrate that the fixed code does not exhibit X - by running it, not by
reading it. Concretely:

- If the fix REMOVES an option, show the removal is observable: passing the old
  flag must fail loudly, because an operator pasting it from a runbook and
  seeing a clean run concludes it worked.
- If the fix ADDS a gate, show the gate's remedy is REACHABLE from the state the
  gate creates. A gate whose remedy it blocks is a deadlock that looks like
  caution.
- If the fix NARROWS something, enumerate what remains in scope. "Applies to
  nothing" and "applies to exactly the right thing" are indistinguishable in a
  diff and obvious in a run.

**And a third instance, from AS7, that fits the pattern from the other side:** a
control that names a specific violation EXPIRES when that violation is fixed.
`migration-state`'s control used `user`/`routes/admin.js` as its example; AS7
migrated that file and the control had to move to `donation`/`routes/payment.js`.
It failed loudly when its subject disappeared, which is the behaviour to build
in - a control nobody notices has expired is worse than none, because it still
reports success.

---

## AT4 - AN AUDIT ORGANISED AROUND USAGE CANNOT SEE UNUSED DECLARATIONS

**The AR1 entity audit enumerated CALL SITES. A dead import has none, so it was
invisible to the method by construction** - not overlooked, unreachable.

`routes/admin.js` and `routes/payment.js` both still imported `models/Category`
after package 3.1 replaced every USE with the bridge. The audit checked every
place Category was used and correctly found them all going through MySQL. The
bindings sat above, unexamined, because the method had no step that would look
at them.

**The `migrationState` self-check found both on its first run**, because it asks
a different question: not "where is this used" but "who has this in scope".

### The generalisation

> **An audit organised around USAGE cannot see DECLARATIONS that are never used.
> Dead references to a superseded store are exactly the thing a later developer
> resurrects, because the binding is already there and looks sanctioned.**

A dead import is not a crossing today. It is the SEED of one, and it is the
cheapest kind to plant: the next person editing `admin.js` had `Category` in
scope, already imported, apparently blessed by whoever wrote the file.

### The gate

`test/migration-state.test.js` asserts that **no file may import the Mongoose
model of an entity whose authoritative store is MySQL**, outside that entity's
`mongooseAllowed` list - the ETL, which reads the old store by definition, and
the bridges, which read it as a fallback. **Wired into CI (AT4)** rather than
left as a suite someone runs locally.

The asymmetry is the right way round: forgetting to update the declaration after
migrating a file leaves it UNDERSTATED, which is safe. Updating the declaration
without migrating the file leaves it OVERSTATED - a purge would then be
permitted - and that is the direction the gate catches.

---

## AT5 - SEC-10 IS THE NINTH INHERITED CLAIM, AND THE THIRD THAT IS MINE

| # | Claim | Source |
|---|---|---|
| 7 | the auto-verify branch is "narrowed to accounts that predate the OTP flow" | **my comment, 3.2** |
| 8 | BUG-03's counter is "always 0" | the review, restated in the map |
| 9 | **SEC-10 is closed - "one shared validator across all five paths"** | **my claim, 3.2** |

**Two of the last three were my own claims rather than the review's, and that is
the more useful half of the pattern.** The rule was built to catch claims
inherited from documents written by other people. It bites hardest on what one
asserts IN PASSING WHILE DOING SOMETHING ELSE - a sentence written to close a
finding, in a commit about something larger, never re-read because the author
knows what they meant.

SEC-10's mechanism was "one shared validator across ALL FIVE PATHS". Package 3.2
built it as a function local to `routes/auth.js`, which made it one validator
across the five paths IN THAT FILE. The claim was true of what was checked and
false of what was claimed, and nothing in the phrasing revealed the difference.

### A validator disagreeing with its own error text is a THIRD kind of defect

```js
if (!newPassword || newPassword.length < 10) {
  return res.status(400).json({ error: "Password must be at least 6 characters long" });
}
```

**Neither half is wrong.** The check is the correct policy. The message is a
clear sentence. **The defect is the pair**, and it has a specific victim: an
admin who reads the message, chooses a 7-character password, and is refused by
an error stating that it should have worked. They will try again with 8, then 9,
learning nothing each time.

It is not a policy bug and not a copy bug - it is the consequence of the rule and
its statement being two separate literals. `utils/password.js` interpolates the
constant into the message, so they cannot disagree again.

---

## AS7 - admin.js migrated. ADMIN-01 CLOSED. And package 3.5 no longer exists.

`routes/admin.js` imports no Mongoose. `user` is now `mysql` in
`config/migrationState.js`; `donation` is the only entity left `split`.

### THE SCOPE FACT, reported rather than taken quietly (AR3)

AS7 authorised "admin.js's user operations plus the two /stats counts". **That is
the entire file.** Nine routes: two cleanup (migrated in 3.3), six user
operations, one `/stats`. There was no "rest of admin.js" to leave for 3.5.

**So package 3.5 ceases to exist as a file migration**, and the findings parked
against it need re-homing. What happened to each:

| Finding | Outcome |
|---|---|
| ADMIN-01 | **CLOSED.** All five false successes now act |
| BUG-03 | **CLOSED** by the `/stats` counts, and it was worse than recorded |
| BUG-08 | **CLOSED** - the user list is clamped, NaN refused |
| SEC-18 | **CLOSED by construction** - the route no longer chooses a cost |
| SEC-18b | **CLOSED** - `setPassword` revokes sessions |
| SEC-19 | **CLOSED** - `failed()`, and malformed ids are 404 |
| SEC-21 | **CLOSED** - `isVerified: true` set explicitly at creation |
| SEC-10 | **CLOSED** - the sixth password rule is gone; see below |
| SEC-08 (admin half) | **NOT APPLICABLE**, decided not deferred - see below |
| BUG-04's dead cron | **STILL OPEN.** A deployment change, not a route change |

### SEC-10 had a SIXTH copy, and its check and its message disagreed

The finding's mechanism was "one shared validator across all five paths".
Package 3.2 implemented it - **as a function local to `routes/auth.js`**, which
made it one validator across the five paths IN THAT FILE. `admin.js` had a
sixth:

```js
if (!newPassword || newPassword.length < 10) {
  return res.status(400).json({ error: "Password must be at least 6 characters long" });
}
```

**The check says 10 and the message says 6.** An admin choosing a 7-character
password was refused by an error telling them it should have worked. The length
was right; the defect was having a second copy at all, which is what SEC-10 was
about. Moved to `utils/password.js` so there is nowhere else to put one, and the
message quotes the constant so they cannot disagree again.

`POST /admin/users` had **no** password rule, so an admin could create an
account with a one-character password whose owner could then never change it to
anything under ten.

### SEC-08's admin half is NOT APPLICABLE, and that is the outcome rule again

The finding is account enumeration. Both admin endpoints that name an address
are behind `adminAuth`, and **the same caller can list every account with a GET
one request later.** A generic response withholds nothing from an attacker and
withholds from an admin the only useful thing the failure could say. The
mechanism is present; the outcome it prevents is not.

### AS7 MADE A DESTRUCTIVE JOB LIVE, and that is worth saying separately

Closing ADMIN-01 moved `user` from `split` to `mysql`. **The inactive-account
purge was refused by AS2's gate and is now permitted.** An operator who sets
`SCHEDULER_ENABLED=true` after this package deletes accounts that the same
setting would have spared before it.

That is correct - MySQL is authoritative now - and it is **a change in blast
radius that nobody asked for as a feature**, which is exactly the kind of
consequence a migration hides. Asserted explicitly in
`test/migration-state.test.js` rather than left to pass as a green test. The
purge remains bounded: admins are never deleted, and an account with ANY
donation is never deleted.

### A control that names a specific violation EXPIRES when that violation is fixed

`test/migration-state.test.js`'s control proved the self-check could detect an
overstated declaration, using `user`/`routes/admin.js` as its example. **AS7
migrated that file, so the example stopped existing and the control had to move
to `donation`/`routes/payment.js`.**

Worth recording as a maintenance property: a control built on a named defect has
a lifetime, and **a control nobody notices has expired is worse than no control**,
because it still reports success. This one failed loudly when its subject was
fixed, which is the behaviour to preserve when the next one is written.

### The SMTP trap, again

The test asserting that an admin-created account can log in initially failed with
`500 "Failed to send OTP email"`. **The credential check had passed** - `/login`
verifies the password and THEN sends an OTP, and there is no SMTP in the test
environment.

Reading that 500 as a refusal is exactly what hid SEC-03 for a full package. The
assertion now discriminates on the MESSAGE - a caller with the wrong password is
stopped at `400 Invalid credentials` and never reaches the mail step - with the
wrong password as the control.

---

## AS2 - the destructive crossings, closed by a declaration rather than a default

**`config/migrationState.js` is the single statement of which store is
authoritative per entity.** The scheduler's DELETEs, the ETL's pre-flight and
both bridges' exit condition read it; none of them restates it.

### The finding it closes

`services/scheduler.js` held `DELETE` on donations and on users against MySQL
while the live writer for both was still MongoDB. A purge in that state deletes
ETL-migrated history from MySQL while live rows accumulate in MongoDB where the
purge cannot see them - **destroying data and failing the retention obligation
the job exists to satisfy, in the same pass.**

**The only thing preventing it was `SCHEDULER_ENABLED` defaulting to false.** A
guard that is correct and is a default is not a control: an operator is
eventually told to turn the scheduler on, and nothing stopped them doing it too
early. The failure is silent - the job reports a successful purge, because from
MySQL's point of view it performed one.

### What replaced it

| | Decides | Who can change it |
|---|---|---|
| `SCHEDULER_ENABLED` | whether the jobs are **registered** | an operator - it is an operational choice |
| `config/migrationState` | whether a job may **delete** | a code change, which the self-check test then verifies |

**THREE STATES, NOT TWO.** `split` means different files write different stores
for one entity - ADR-057's crossing, and the state both `user` and `donation`
are in now. A binary migrated/not-migrated cannot express the condition that
causes the harm, so `split` is treated as not-migrated everywhere.

**DRY RUNS STILL WORK IN EVERY STATE**, and report `authoritativeStore` so an
operator learns why a real run would refuse without having to try it. Refusing
the preview would remove information for no safety gain, and a control that
blocks safe work gets turned off.

**THE GATE IS PER-ENTITY.** The pending-signup sweep is ALLOWED today, because
`pendingSignup` is MySQL-only. A blanket "is the migration finished" would block
a job that is completely safe - which is how a control loses its credibility.

**A REFUSAL IS NOT A FAILURE.** `ERR_NOT_AUTHORITATIVE` is logged distinctly by
the cron and answered `409` by the admin endpoint. "Nothing was touched" and "it
crashed partway through deleting" are opposite facts about the data, and the
BUG-10 wording - "rows may have been partially deleted" - would send an admin
looking for damage that does not exist.

### The declaration is CHECKED, not believed

`test/migration-state.test.js` walks the source tree and asserts that for every
entity declared `mysql`, no file outside its `mongooseAllowed` list imports its
Mongoose model. **The asymmetry is the right way round:** migrating a file and
forgetting to update the declaration leaves it understated, which is safe;
updating the declaration without migrating the file leaves it overstated - a
purge would then be permitted - and that is the direction the test catches. It
carries its own control, which proves the check would fail if the declaration
overstated `user`.

**IT FOUND SOMETHING ON ITS FIRST RUN, and something AR1 structurally could
not.** `routes/admin.js` and `routes/payment.js` both still imported
`models/Category` - **dead imports**, left behind when package 3.1 replaced the
usage with the bridge. **AR1 enumerated CALL SITES, and a dead import has no
call site.** Not a crossing today; the seed of one, because the next person
editing those files has `Category` in scope. Both removed.

### Two things I got wrong building it, recorded because the second is ironic

1. **The ETL's new `declaration-ahead-of-data` check was BLOCKING first** - and
   a blocking finding stops the load, while **running the load is what fixes
   this finding.** A gate that prevents its own remedy is ETL-01's shape exactly
   ("an option that can only make things worse"), reproduced inside the check
   written to honour it. Now `RECORD`. Caught by running it, not by reading it.
2. **The report footer printed "refused by the loader as well ()"** with an
   empty list, and offered one remedy for findings whose remedies differ. A
   summary asserting something untrue, in a report whose entire purpose is to be
   trusted. Now per-finding.

---

## AS5 - `checkOrder.js` deleted

An unreferenced diagnostic at the repo root reading a store that stopped being
authoritative at package 3.1. Confirmed by `git grep` that nothing imports it,
no npm script runs it, and no compose file or Dockerfile mentions it.

**Deleted, and the reason is the one AS5 gave rather than tidiness:** it is the
kind of thing someone runs DURING A CUTOVER to check something, and it would
have answered confidently from the wrong database at the moment its answer
mattered most.

---

## AS6 - the unwalked area, closed

AR1 carried one explicitly unverified claim: that nothing outside `Backend/`
touches an entity directly. Walked now.

| Checked | Result |
|---|---|
| Repo root | **No JavaScript at all.** `.env`, `.gitignore`, two compose files, three markdown files, `LICENSE` |
| Top-level `db/` | `schema.sql` only |
| `Frontend/` dependencies | **No database driver.** react, react-dom, react-router-dom, chart.js, jspdf and build tooling |
| Every `.js/.jsx/.ts/.tsx` outside `Backend/` | 50 files, all under `Frontend/src` or Frontend build config |

**Nothing outside `Backend/` touches an entity's store directly**, and nothing
could - the Frontend has no driver to do it with. The claim is now verified
rather than carried.

### What the walk did turn up

**The Frontend couples to entity SHAPES through the API**, which is not a
crossing but is the thing every migrated route's `present()` exists to protect:
`_id` 60 references, `.category` 48, `isActive` 32, `donationAmount` 29,
`paymentDetails` 23, `.userId` 25, `sortDescription` 19, `transactionId` 15.
Those numbers are the cost of getting a wire shape wrong, and they are why AE4
pins what an endpoint ACTUALLY returned rather than what its query asks for.

**`pdfGenerator_backup.js` and `pdfGenerator_old.js` are byte-identical (20507
bytes each) and neither is imported** - only `pdfGenerator.js` is, by five
pages. The same class of artefact as `checkOrder.js`: stale copies of receipt
logic that read donation fields. **Not deleted here** - Phase 5 owns the
Frontend and this package has no business editing it - but recorded so Phase 5
does not have to rediscover them.

---

## AS3 - a plan organised around a DIRECTORY cannot see what lives outside it

**Recorded as a planning error, per AS3, not as an execution gap.**

Four of the seven new crossings AR1 found are not in route files:
`services/scheduler.js`, `scripts/seedDatabase.js` twice, and `checkOrder.js`.
**The entire Phase 3 sequence is organised around `routes/`** - 3.1 categories,
3.2 auth/users/middleware, 3.3 donations, 3.4 payment, 3.5 admin, 3.6 Mongoose
removal. Every package is named for a route file. (That was the sequence AS WRITTEN;
AT2 later collapsed 3.5 into AS7. The point stands either way - and the collapse
orphaned U-2, which is the same shape one level up.)

**So no amount of careful reading of the sequence could have surfaced them.**
They are not omissions from a list; they are outside the space the list
enumerates. Reading it more carefully finds route files you had missed - it
cannot find a category of file the plan has no slot for.

### The generalisation

> **A plan organised around one directory cannot see dependencies that live
> outside it. The audit that finds them has to be organised around the DATA, not
> around the code layout.**

That is why AR1's matrix is per-ENTITY and not per-package. Walking `routes/`
would have produced the same blind spot the sequence has, because it would have
inherited the sequence's organising principle. Walking the entities found
`scheduler.js` holding `DELETE` on two of them.

### Same shape as "every real constraint turned out to be a property of the data"

The ordering constraints arrived in that order and the pattern held every time:

| Constraint | Looked like | Actually was |
|---|---|---|
| ADR-055 | a read-dependency question | **FK direction** - a property of the schema |
| ADR-056 | a bridge-coverage question | **where the rows are** - a property of the data |
| ADR-057 | a package-sequencing question | **which store the writer writes** - a property of the data |
| AR1's crossings | a code-review question | **which store each call site touches** - a property of the data |

**Four times, the constraint that mattered was a fact about the DATA wearing the
costume of a fact about the CODE.** The plan is a map of the code, so each time
it was the wrong instrument, and each time the corrective was to enumerate
something concrete - FK directions, row locations, write sites, call sites.

**The operational conclusion is AR1's own: re-run the entity audit at the end of
every package that moves an entity.** It is organised around the thing the
constraints are properties of.

---

## AS4 - BrandingSettings has no callers, and that is CORRECT

**Stated deliberately so a later reader does not mistake the absence for
something missed.**

`branding_settings` has a Prisma model, a table, a `ck_branding_settings_singleton`
CHECK plus two colour-format CHECKs, two entries in `db/check-drift.js`, coverage
in `test/data-layer.test.js` and `test/schema.test.js`, and a seeded row. It has
**zero application callers**: no route, no middleware, no service, and no
reference anywhere in `Frontend/src`.

**THIS IS NOT A GAP. Phase 5 builds the whitelabel consumer, and the foundations
are deliberately already in place.** A Phase 2 data layer built ahead of a Phase
5 feature is the migration doing its job: the constraints that are expensive to
add to a populated table - the singleton CHECK, the colour formats - exist
before there is any data to migrate.

**What the Phase 5 spec should know:**

1. **The foundations exist.** Singleton-enforced, colour-validated, drift-gated,
   with a seeded row at `id = 1`. Phase 5 writes the consumer, not the schema.
2. **Nobody is its first caller yet, and that has a cost.** An entity with no
   caller cannot be verified by any test of BEHAVIOUR - only its constraints are
   proven. Whoever wires it up will be exercising its semantics for the first
   time, and should expect to find things no CHECK constraint can catch.
3. **It is the one entity with no MongoDB predecessor**, so it is the only one
   that has never been `split` and never needed a bridge. `migrationState`
   records it as `mysql` / `etlMigrates: false` for that reason, not because it
   was migrated.

**Recorded here rather than left to be rediscovered**, because "a fully built
data layer nobody calls" reads like an oversight to anyone who finds it without
this note - and the natural response to an apparent oversight is to remove it.

---

## AR1 - the entity ownership audit. NINE crossings, seven of them new.

**Full matrix: `docs/entity-ownership-audit.md`.** Summary only here.

| Entity | Crossings | Verdict |
|---|---|---|
| **User** | 3 | `admin.js` writes MongoDB, 3.2 reads MySQL (ADMIN-01); the scheduler DELETES from MySQL; the seeder writes MongoDB |
| **Donation** | 3 | `payment.js` writes MongoDB, `donations.js` reads MySQL (ADR-057); `admin.js`'s two `/stats` counts read MongoDB; the scheduler DELETES from MySQL |
| **Category** | 2 | `scripts/seedDatabase.js` and the unreferenced `checkOrder.js` - no route package crosses, because every route reader goes through the bridge |
| **PendingSignup** | **0** | clean |
| **BrandingSettings** | **0** | **no caller of any kind exists** |

### The three things worth carrying forward

**1. FOUR OF THE SEVEN NEW CROSSINGS ARE NOT IN ROUTE FILES.** `scheduler.js`,
`seedDatabase.js` (twice) and `checkOrder.js`. The package sequence is organised
around `routes/`, so no amount of reading it would have surfaced them. That is
ADMIN-01's lesson generalised: the sequence defines scope, and scope defines
attention.

**2. TWO OF THEM ARE DESTRUCTIVE, AND THE WRITER/READER FRAMING MISSES THEM.**
`services/scheduler.js` holds `DELETE` on donations and on users against MySQL
while the live writer for both is still MongoDB. Both sides are WRITERS, so
neither is "a reader reading the wrong store" - they were found only by recording
the STORE at each call site rather than the operation. The retention purge would
delete migrated history from MySQL while live rows accumulate in MongoDB, so the
organisation satisfies its retention obligation against the wrong copy.

**The only thing preventing that is `SCHEDULER_ENABLED` defaulting to false - a
guard that is correct and is an environment variable.** Recommend the scheduler
additionally refuse to run while any route file still imports Mongoose: a
condition the code can check, and vacuously true from 3.6.

**3. THE ONE CLEAN ENTITY IS CLEAN BY ACCIDENT.** `PendingSignup`'s writer and
all its readers share a package because nobody split them, not because anyone
checked. It would have come out clean at 3.1 too - and ADMIN-01 was created at
3.2. **The audit must be re-run at the end of every package that moves an
entity.** It took under an hour and it is a grep.

### BrandingSettings: built, constrained, gated, tested, and called by nothing

A Prisma model, a table, three CHECK constraints, two entries in the drift gate,
coverage in two suites, a seeded singleton row - and **zero application callers**,
in `routes/`, in `config/`, in `app.js` or in `Frontend/src`.

Not a defect: a Phase 2 entity built ahead of a Phase 5 feature. Recorded because
**an entity with no caller cannot be verified by any test of behaviour**, so it
will reach whoever wires it up with its constraints proven and none of its
semantics. They should know they are its first caller.

### AR3 answered: `admin.js`'s other operations

- **CATEGORY: not entangled.** One call, `categoryBridge.countCategories()` at
  `admin.js:31`, already resolving to MySQL. Nothing to do.
- **DONATION: entangled, but NOT equally** - two `countDocuments` in
  `GET /admin/stats` ([location redacted while open]). Read-only, no control, no false
  success. **Reported rather than taken**, per AR3. Recommendation and its cost
  are in the audit document; the short version is that they sit in the same
  handler as the user count, so leaving them produces one handler reading two
  databases - the exact condition this audit exists to remove, newly created by
  the fix for it.

---

## ADMIN-01 - every admin user operation writes a store that authentication does not read

**Severity HIGH. Provenance X** - found by AJ3's severity pass, while checking a
bcrypt cost parameter. **LIVE ON `phase-2-data-layer` TODAY.** Not in production:
the branch has never been deployed.

**This is ADR-057's constraint, and package 3.2 had already violated it.** The
constraint was derived at 3.3 from donations. It applies to `User` identically,
and it was broken one package earlier without anyone noticing - which is the
strongest argument for the ADR that could exist.

`routes/admin.js` is entirely on the Mongoose `User` model (`admin.js:3`).
`routes/auth.js`, `routes/users.js` and both middlewares are entirely on
`repositories/users` (MySQL) as of package 3.2. They no longer share a store.

**MEASURED, not reasoned about.** Run against the stack with an ETL-migrated
account present in both stores with the same id:

```
PATCH /api/admin/users/:id/change-password  -> 200
  says: {"message":"Password changed successfully", ...}
  MongoDB hash changed : true
  MySQL   hash changed : false          <- and MySQL is what login reads

PATCH /api/admin/users/:id/toggle-status    -> 200
  says: {"message":"User disabled successfully", ...}
  MongoDB isActive = false
  MySQL   isActive = true               <- and MySQL is what authMiddleware enforces
```

| Admin operation | What an admin is told | What actually happens |
|---|---|---|
| `PATCH /users/:id/toggle-status` (`:198`) | **"User disabled successfully"** | `isActive` is set in MongoDB. `authMiddleware` enforces the MySQL value. **The disabled account keeps authenticating.** SEC-05 reopened - not by forgetting to read the flag this time, but by writing it to the wrong database |
| `PATCH /users/:id/change-password` (`:234`) | **"Password changed successfully"** | the hash is written to MongoDB. Login verifies against the MySQL hash. **The old password still works and the new one does not** |
| `DELETE /users/:id` (`:270`) | user deleted | the MongoDB row goes. The MySQL account survives and keeps authenticating |
| `PATCH /users/:id` - role (`:182`) | user updated | role is changed in MongoDB. `authMiddleware` takes the role from MySQL |
| `POST /admin/users` (`:143`) | account created | a MongoDB row. **The account cannot log in** - already asserted by `auth-characterisation`'s AK3 test |
| `GET /admin/users` (`:99`) | the user list | MongoDB rows. After the ETL these are stale copies |

**THE CONDITION MATTERS, and checking it changed the finding.** The silent
failures above need the account to exist in BOTH stores - which is every
ETL-migrated account, i.e. **every real user after cutover**. An account created
through the API since package 3.2 exists only in MySQL, and the same calls
return a loud `404 "User not found"`:

```
SAME CALL for a MySQL-ONLY account (created after 3.2) -> 404
  says: {"error":"User not found"}
```

So the endpoints are not uniformly broken - **they are loud for the accounts
that do not matter yet and silent for the ones that will.** That is the worse
half of the distribution, and it is the half a developer testing on a fresh
database never sees.

**The first four share one shape: an admin acts to REVOKE access, is told it
succeeded, and access is not revoked.**

**Why it was not caught.** Every one of these paths is untested: `admin.js` is
package 3.5 and had no characterisation suite (it has one as of AS7), which is exactly the coverage
rule's point ("no route file is migrated until it has characterisation tests")
seen from the other side - **a file that has not been migrated has no tests
either, so a change in a DIFFERENT file can break it silently.** Package 3.2
changed where users live; nothing was watching `admin.js` when it did.

### What this does to the sequence

**`admin.js`'s user operations must ship with 3.2's store change, not two
packages later.** The options, and neither is mine to choose:

1. **Fold `admin.js`'s user management into the 3.3/3.4 merge unit**, so nothing
   reaches `main` with the split open. It grows the unit to three packages.
2. **Migrate only `admin.js`'s user operations now**, leaving its donation and
   category reads for 3.5. It splits a file across packages - the thing ADR-057
   declined to do for `payment.js` - but the argument is stronger here, because
   this split is already open and shipping rather than hypothetical.

**What must NOT happen is 3.2 reaching production as it stands.** An admin
console that reports success for every revocation it performs and performs none
is worse than the finding it was migrated to fix.

### THE SHAPE (AR4) - record this, not only the fix

**A control that reports success without acting is worse than one that visibly
fails, because nobody returns to verify.**

That is the whole finding in one sentence, and it generalises past this bug. A
`500` from the disable endpoint would have been fixed the same afternoon by the
first admin who hit it. A `200 "User disabled successfully"` is filed as done.
The admin moves on, the record says the account was disabled, and the only way
anyone learns otherwise is the disabled person continuing to use the system -
which is not a signal anybody is watching for, because the console already said
it was handled.

**THE FAILURE MODE IS INVERTED RELATIVE TO WHERE THE RISK IS.** This is the part
that makes it more than an ordinary bug:

| | Accounts created since 3.2 | ETL-migrated accounts |
|---|---|---|
| Exist in | MySQL only | **both stores** |
| The admin gets | `404 "User not found"` - loud | `200 "...successfully"` - silent |
| Who they are | test accounts, fixtures, whoever signed up on the branch | **every real user after cutover** |

**It is loud for the accounts that do not matter and silent for the ones that
will.** A developer on a fresh database sees the 404, reads it as "the endpoint
is broken, someone will fix it", and never sees the silent case at all. The
condition that produces the dangerous behaviour is precisely the condition that
only exists in production.

### ADR-057 was violated ONE PACKAGE BEFORE ADR-057 WAS WRITTEN

The constraint was derived at 3.3, from donations. `User` had the identical
split - `admin.js` writing, `auth.js` reading - and 3.2 shipped it.

That ordering is the strongest argument the ADR could have. It was not a rule
someone forgot to apply; **it was a rule nobody had yet articulated, and the
system broke in exactly the way it now predicts, one package earlier.** A
constraint that retroactively explains a defect found by an unrelated pass is
worth more than one that merely sounds correct.

### THE COVERAGE RULE FAILED FROM THE OTHER SIDE

SPEC-3's spine is *no route file is migrated until it has characterisation
tests*, and AC1 sharpened it: a test must assert the MECHANISM, not the outcome.
Both are about tests that assert too little.

**ADMIN-01 was not caught by a weak test. It was not caught because THERE IS NO
TEST AT ALL in `admin.js`** - the file has no characterisation suite, because it
was package 3.5 and its suite was written when it migrated - in AS7, and the
suite is what made ADMIN-01 executable rather than described.

So the rule has a blind spot it cannot see from the inside:

> **A file that has not been migrated has no tests either. A change in a
> DIFFERENT file can therefore break it silently, and the coverage rule - which
> only ever asks about the file being changed - will report full compliance.**

Package 3.2 changed where users live. Nothing was watching `admin.js` when it
did, and nothing in the process was supposed to be. **That is why AR1's audit is
a per-package gate rather than a one-off**: the audit asks about the entity,
which crosses files, where the coverage rule asks about the file.

### It also answers a question the map had left open

AK2's ordering constraints are about which package goes FIRST. ADR-057 added
granularity - which packages MERGE together. **ADMIN-01 shows the two are the
same question asked at different times**, and that the check is mechanical:
*for each entity, list every file that WRITES it and every file that READS it;
if those sets span package boundaries, those packages are one merge.* That check
has never been run over the whole codebase. It should be, before 3.4.

---

## AJ3's severity pass - run at the end of 3.3, before 3.4

**The rule being applied: severity comes from the OUTCOME, not the MECHANISM.**
A severity derived from a mechanism is an inherited guess at an outcome, which
makes this an application of the inherited-claim rule rather than a separate
exercise - and with six inherited claims already fallen, the base rate says to
expect hits.

**Method: for each open finding, read the code and state what an attacker or a
user actually gets.** Not what the category is called.

**A pass that only moves things UP is inflation, not analysis.** One finding
moved down, and that is recorded as prominently as the one that moved up.

### MOVED: SEC-06 is HIGH, not Medium

**Was:** "Unauthenticated donor PII via `GET /payment/status/:txnid`" - Medium,
filed as information disclosure.

**Outcome, read from the code:** [location redacted while open] has no authentication of any
kind. It returns the WHOLE donation record, populated - donor name, email,
phone, amount, and the payment details including `mihpayid` and `bank_ref_num`.
The only thing standing between an anonymous request and a donor's personal data
is knowing `txnid`.

**And the application publishes `txnid` into the URL bar itself.** Every callback
redirects to `FRONTEND_SUCCESS_URL?txnid=...` ([location redacted while open]). A
value in a query string is in the browser history, in the `Referer` header sent
to every third party the success page loads, and in any analytics or error
reporter on that page. **The credential protecting donor PII is transmitted the
one way a credential must never be transmitted.**

Blind enumeration is NOT the exposure and saying so would overstate it:
`TXN${Date.now()}${rand(1000)}` is roughly 10^11 candidates per day, which is not
practically brute-forceable. The exposure is that the secret leaks by design.

**High.** It is one band below SEC-03 - that is an authentication bypass, this is
unauthenticated access to personal data - and a band above where "information
disclosure" placed it.

### MOVED DOWN: SEC-18 is Low, and its real finding is a different one

**Was:** "bcrypt cost 10 ([location redacted while open])" - Medium.

**Outcome:** cost 10 versus 12 is a four-fold change in offline cracking cost,
and it only matters at all GIVEN a database compromise. It is hardening, not a
control that can be defeated. **Low.**

**But reading it produced a better finding than the severity.** [location redacted while open]
and [location redacted while open] call `bcrypt.hash(password, 10)` DIRECTLY - they do not go through
`repositories/users`, which is where `BCRYPT_COST = 12` lives and where
`create()` and `setPassword()` apply it. So:

- There are **two password-hashing implementations** in this codebase, and only
  one of them is governed by the policy.
- `setPassword` also increments `token_version`, which is SEC-05's revocation
  mechanism. An admin resetting a user's password through `admin.js` therefore
  **does not revoke that user's existing sessions**, because it never calls the
  function that would.

**That second consequence is the finding.** It is not about a cost parameter; it
is a security control silently skipped by the one code path most likely to be
used after an account compromise. **CLOSED IN AS7** - `admin.js` now calls
`users.setPassword`, which increments `token_version`. It was more important
than the number that led to it.

### RESTATED: SEC-21 is not about `isVerified` being false

**Was:** "`POST /admin/users` leaves `isVerified` false, then `auth.js` silently
auto-verifies" - Low.

**Outcome, checked by enumerating every read of the flag:** `isVerified` is read
in **exactly one place in the entire codebase** - [location redacted while open], the line that
sets it to true. No route and no middleware gates anything on it.

**So the flag is not a control.** An "unverified" account has precisely the
capabilities of a verified one. That is SEC-05's shape exactly: a field that
exists, is settable from the admin UI, and is never read - and SEC-05 was rated
High on that basis.

**It does NOT get High here, and the reason matters.** Self-service signup
enforces verification STRUCTURALLY: no `User` row exists until the
`PendingSignup` OTP is confirmed, so the flag being decorative does not open
unverified self-registration. The exposure is limited to admin-created accounts
and migrated legacy rows. **Medium**, restated as "the email-verification flag
gates nothing", which is a different sentence from the one filed.

**And it exposed a seventh inherited claim, which is mine.** Package 3.2's
comment at that line said the branch had been "narrowed to accounts that predate
the OTP flow rather than applying to everyone". It applies to everyone. **The
narrowing was described and never implemented**, and the comment would have been
inherited by the next reader as a statement of fact - which is exactly how the
other six propagated. Corrected in place to describe what the code does.

### PAY-01 - NEW: `quantity` is unbounded on the pricing path

**Severity** Low. **Provenance X** - found during this pass, by reading the two
adjacent lines rather than the finding list.

```js
const qty   = Math.max(1, parseInt(quantity, 10) || 1);              // no ceiling
const extra = Math.max(0, Math.min(1_000_000, parseFloat(extraAmount) || 0));
```

**`extraAmount` is clamped and `quantity` is not, on consecutive lines.** That
asymmetry is the tell: a bound was added to one input and not to its neighbour,
and a reviewer skimming the pair concludes that amounts are bounded.

Measured rather than reasoned about: `quantity="99999999999999999999"` gives
`qty = 1e20` and a total of `1.5e+23`, on an endpoint with **no authentication**.

| Store | What happens |
|---|---|
| MongoDB (today) | the amount is stored as a float and handed to PayU |
| MySQL (after 3.4) | `toMinorUnits(1.5e23)` returns `null`, the repository refuses, the endpoint 500s |

So the migration converts it from a bad stored value into an unauthenticated
500. Neither is acceptable and the fix is one `Math.min`. **Assigned to 3.4**,
with the bound stated as a constant next to `extraAmount`'s so the pair cannot
drift apart again.

### SEC-07's label hides that no credential is needed

**Not re-graded** - Medium is right by outcome: an injected donation lands in a
victim's history as `Pending`, and the attacker cannot read it back, because
`GET /donations/:id` matches ownership and the donation is not theirs. It is
integrity and nuisance, not disclosure or escalation.

**But "Donation attribution forgery" does not convey that `/initiate` has no
authentication at all.** `userId` is taken from `req.body` on an endpoint any
anonymous caller can reach, so anyone on the internet can write rows into any
identified user's donation history. The severity is right; the sentence
undersells what is required to do it, which is nothing.

### Checked and NOT moved

Recorded so the pass is auditable rather than a list of the ones that changed.

| ID | Label | Outcome, re-derived | Verdict |
|---|---|---|---|
| SEC-14 | Medium | Malformed hash throws rather than refusing. Fails CLOSED - the donation stays `Pending` - so it is a broken refusal, not a bypass | **Medium stands** |
| SEC-11 | Medium | Unauthenticated writes allow row and email flooding. Email flooding can get the org's SMTP reputation blocked, which is an availability loss for every donor | **Medium stands** |
| SEC-19 | Low | `err.message` to the client. Names the store, driver and column - reconnaissance, not access | **Low stands** |
| SEC-08 | Medium | Account enumeration. Confirms an address is registered; no access | **Medium stands** |
| BUG-03 | - | Dashboard tile reads 0 forever. Misinformation to one admin | **stands** |
| BUG-04 | - | Purge never ran. A retention obligation unmet, and the reason the first real run is dangerous | **stands** |
| BUG-08 | - | Unbounded page size on `admin.js`. Resource exhaustion behind adminAuth | **stands** |
| DEPLOY-01 | Medium | Shared Redis throttles real users. Availability, very hard to diagnose | **Medium stands** |

### What the pass says about the method

Three of the four findings that moved were **not found by re-reading the
severity column**. SEC-18's real finding came from asking why the cost was
hard-coded, SEC-21's from enumerating reads of a flag, and PAY-01 from reading
the line next to the one under review. **The severity label is where the
mis-grading is recorded; it is almost never where the evidence is.**

---

## Package 3.3 - COMPLETE, BUT IT MUST NOT MERGE ALONE

`routes/donations.js` is migrated to MySQL and imports no Mongoose. Twelve
findings closed. **One blocking ordering constraint and two inherited claims
came out of it, and the first one decides how this package ships.**

### THE BLOCKER: donations have a WRITER in a different package (ADR-057)

**`donations.js` READS donations. `payment.js:141` WRITES them, and it migrates
in 3.4.** So for as long as 3.3 is on `main` without 3.4, a donation created
through `/api/payment/initiate` lands in MongoDB and is **invisible** to the
admin list, the receipt, the filter options and the charts.

This is ADR-056 applied to donations, and it is worse there than it was for
categories:

| | Categories (3.1) | Donations (3.3) |
|---|---|---|
| What goes missing | a category created after the cutover | **every donation taken after the cutover** |
| Who notices | an admin, on the donation form | nobody, until the money is reconciled |
| Path | configuration | **the live money path** |

**It is symmetric, which is why swapping the order does not fix it.** Migrate the
writer first and the readers are on MongoDB, so MySQL has everything and the
admin console shows a stale subset. Migrate the readers first, as here, and
MySQL has the ETL's history and none of today's donations. A bridge does not
help either way - ADR-056 is precisely the finding that a read-through bridge
covers single-record reads and not LISTS, and the admin console IS a list.

**So 3.3 and 3.4 must reach `main` together.** Package 3.2 already has the
precedent: `auth.js`, `users.js` and both middlewares shipped as one unit
because they shared an entity. The work stays split for review; the MERGE does
not. **The alternative - merging 3.3 alone - puts a window on production in
which donations are taken and not shown.**

Recorded as a DECISION FOR THE WORK ORDER rather than taken unilaterally: the
smallest correct alternative is to move `payment.js`'s donation WRITE path into
3.3 and leave the rest of `payment.js` (the PayU hash, SEC-21, AQ1's counter) in
3.4. That splits a file across packages, which the sequence has so far avoided.

### AE1-b's trigger DOES NOT FIRE HERE - the fifth inherited claim

`mintObjectId()` STAYS in `categories.js` through 3.3.

The trigger was recorded as "once `donations.js` has migrated", reasoning that
`Donation.category` stays an ObjectId ref *until donations migrate*. The concept
was right and the file was wrong: **the ref is written by `payment.js:141`, not
by `donations.js`.** [location redacted while open]'s write is BUG-01 and has never once
succeeded, so removing the minter at 3.3 would have broken the live donation
write path on the first category created afterwards.

It follows AP3's signature exactly - restated, load-bearing, correct-looking -
with one addition worth noting: **it had already been revised once.** The
ADR-055 swap moved its package number from 3.2 to 3.3 and did not re-examine its
reasoning, so the revision carried the error forward while looking like a check.

**Moved to 3.4, bound to `payment.js` rather than to a package number.**

### The scheduler implemented TWO of the three retention rules - the sixth

The map recorded that `services/scheduler.js` "already implements the same
retention rules against MySQL". It implemented the donation purge and the
pending-signup sweep. `dataCleanupService` also purged **inactive accounts**,
and nothing had replaced that.

Retiring the legacy service as written would have **dropped a data-retention
control without anyone deciding to** - the quiet kind of loss that surfaces in
an audit years later rather than in a test. `purgeInactiveUsers` is carried
across, with the legacy guards kept deliberately: admins are never purged, and
an account with ANY donation is never purged, because severing a donation from
the person who made it is not a retention outcome anyone asked for.

### Findings closed

| ID | How |
|---|---|
| **BUG-10** | Dry run is the DEFAULT; a real delete needs `?confirm=delete`. Awaited, with counts in the response. No catch returns 0 - a failure is a 500 that says rows may have been partially deleted. Preview and trigger now run THE SAME CODE with `dryRun` flipped, which is the only way a preview can be trusted to describe the delete |
| **BUG-12** | `PUT /:id` 404s a missing donation. It answered `200 {message:"Donation updated", donation:null}` |
| **BUG-08** | Pagination clamped to 100, NaN refused with 400 - on BOTH listings, which had the same defect twice |
| **BUG-02** | Casing decided in the repository, once. Both casings accepted, one stored |
| **BUG-01** | **Endpoint REMOVED.** Decided, not deferred - see below |
| **BUG-06** | Closed by deletion with its only caller |
| **SEC-16** | MySQL ENUM plus repository canonicalisation; a refused write writes nothing |
| **SEC-19** | `failed()` everywhere; no `err.message` reaches a client |
| **ADR-041** | `distinct()` keeps DATA semantics - `groupBy` reports only groups that exist |
| **ADR-003** | FK `ON DELETE SET NULL`; `donor.isGuest` distinguishes |
| **ADR-050** | `donations.js`'s four `categoryBridge` call sites are GONE, not rewired - a migrated donation carries its category through the join |
| **BE-HIGH-08** | **Renamed, not retired** - see below |

### BUG-01: the endpoint is REMOVED

The map asked for a decision. Deleting it, for two reasons:

1. **Nothing can depend on it.** It built a document without the required
   `donorEmail` and `amount`, so every request in its life failed validation. An
   endpoint that has always refused has no client relying on success, and the
   frontend's `DONATIONS.CREATE` constant is declared and never referenced.
2. **Completing it would be the worse change.** It sat behind `optionalAuth`, so
   making it work would create an **unauthenticated path that writes donation
   records bypassing payment initiation entirely** - arbitrary amounts, no
   gateway, any status the caller chose.

BUG-06 goes with it: `optionalAuth` had no other caller, and a corrected
fragment nothing reaches is code that looks tested and is not exercised.

### BE-HIGH-08 was RENAMED by the store swap, not retired

**A parameterised query stops SQL injection. It does not stop `%` from meaning
"anything".**

The finding was `$regex` executing the caller's metacharacters, and the fix
escaped them. `LIKE` has its own metacharacters - `%` and `_` - and Prisma's
`contains` binds the value without neutralising them, so `searchQuery=%` would
have returned every donor. The same over-match, arriving through a different
door, in the package that was supposed to have removed the class.

Escaped in the repository, and **asserted by behaviour, then proved by
injection**: removing the escaping fails that test and only that test. The test
also pins the dependency the fix rests on - MySQL's `LIKE` treats backslash as
the default escape character, which holds only while `NO_BACKSLASH_ESCAPES` is
absent from `sql_mode`.

### ETL-01 - the override turned a clean refusal into a PARTIAL LOAD

**Severity** High, operational. **Provenance X** - found by running 4a's ETL for
real against donation data, which is the first time any BLOCKING finding had
actually been overridden.

The pre-flight reported one implausible date. The operator passed
`--i-have-reviewed-the-preflight`. The loader then wrote two categories, one
user and **four of five donations**, and threw on exactly the row that had been
reported - leaving MySQL part-populated.

`migrate.js`'s comment said "the row still fails here", which is what its author
intended and is not what a `throw` does: **it fails the RUN, not the ROW.**

Checked rather than assumed: **all three BLOCKING pre-flight findings are ones
the loader also refuses** - implausible dates, orphaned categories, and
case-variant emails (the second insert hits the unique index). So overriding a
BLOCKING finding was strictly worse than not overriding it, in every case the
check can produce. The flag was offering a choice that did not exist.

**Fixed**: findings carry `refusedAtLoad` (renamed from `loaderRefuses` by BD1),
and those are refused BEFORE anything
is written, with the report saying why and pointing at the source data. Proved
by re-running: the load now refuses with MySQL untouched at 0/0/0.

It is AP4's class again - a control that is correct (refusing to guess a date)
producing a symptom somewhere else (a half-migrated database).

**THE GENERAL FORM (AR5): an option that can only make things worse is worse
than no option.**

The override's entire purpose was to let an operator accept a finding and
proceed. It could not do that for any finding that exists, so every use of it
was a strict downgrade: a refusal with nothing written became a refusal with
part of the data written.

**The first fix was not enough, and the reason is worth keeping.** Making the
flag not apply to those findings left a documented flag that applied to
NOTHING - which is the same defect one level up: an option offering a choice
that does not exist. **The flag is now removed**, and passing it is a loud
refusal rather than a silent no-op, because an operator who types a flag from an
old runbook and sees a successful run concludes it worked.

`refusedAtLoad` is KEPT as reporting rather than deleted with the flag. It no
longer changes behaviour; it records which findings the loader would also throw
on, and it is the thing to check the day a BLOCKING-but-loadable finding is
added - because on that day the question of an override becomes real again, and
the flag comes back scoped to that finding and not before.

### Test isolation: the suites no longer own the store (worth knowing for 3.4)

Two assertions broke on data they do not own, because every suite now shares one
MySQL database with every other suite AND with whatever is loaded locally:

- `filter-options` asserted `Cancelled` is absent. The ETL's fixtures include a
  cancelled donation.
- `displayOrder` asserted the first category gets `0`. The ETL's two categories
  make it `max+1`.

Neither was a behaviour change, and neither assertion was wrong about the CODE -
they were wrong about owning the table. Both now assert the RULE (`reported
statuses == statuses with rows`; `each is max+1`) which is what the finding
actually says and is true regardless of what shares the database. **Expect more
of these in 3.4**: the app user is scoped to one database by design, so
per-suite databases would need root, and that is a bigger change than a route
package should make.

---

## Package 3.2 - COMPLETE. SEC-04 CLOSED, SEC-03 closed on the branch.

`auth.js`, `users.js` and both middlewares are migrated to MySQL and import no
Mongoose.

### SEC-04 IS CLOSED - reversing the Phase 2 report

Phase 2 reported it OPEN, and correctly: ADR-042 recorded that
`config/rateLimiters.js` existed and nothing imported it, and that "the store
existing and the store being used are different claims". **This package supplies
the second claim.** `routes/auth.js` imports the factory, and the running
container announces:

    [rateLimiters] store=redis

Same 5-per-minute budget, so the wiring changed the STORE and nothing else - a
package that silently tightened the limit would be indistinguishable from one
that broke something.

### SEC-03 - closed on the branch, NOT YET IN PRODUCTION

Three different claims, kept apart deliberately because they are not the same
thing:

| Claim | Status |
|---|---|
| Closed on `phase-2-data-layer` | **YES.** Parameterised SQL closes the class, asserted including that no login OTP is issued |
| Hotfixed on `hotfix/sec-03-auth-bypass` | **YES.** 11/11 against current `main` |
| Merged **and deployed** | **NO, as of this package.** Until the hotfix merges AND deploys, production carries the bypass |

### Also closed here

| ID | What changed |
|---|---|
| SEC-05 | `isActive` enforced in both middlewares and at login; `tokenVersion` revokes tokens on a password change. Both had existed as columns nothing read |
| SEC-08 | `/login/resend-otp`, `/forgot-password/verify` and `/forgot-password/reset` answer identically for known and unknown addresses |
| SEC-10 | ONE validator on every path that sets a password. There were three rules and two paths with none |
| SEC-13 | OTPs and reset codes stored as sha256 hashes rather than readable digits |
| SEC-18 | bcrypt cost 12 |
| SEC-19 | `failed()` on every handler |
| SEC-09 | the profile-load PII log removed |

### Deferred, with the reason stated

**SEC-08 on `/signup`.** "User already exists with this email" is an account
oracle. Removing it properly means always answering "check your email" and
sending EITHER a verification code OR a "someone tried to register with your
address" notice - a second template in `config/email.js`, which this package does
not own. The security review reaches the same conclusion. Assigned to the package
that owns the email templates.

### Two corrections found by running it

**SEC-08's `/login` row in the review is WRONG.** It lists the
`needsSignupVerification` disclosure as enumeration. That branch is reached only
after `bcrypt.compare` SUCCEEDS, so a caller who does not already hold the
password gets the same `Invalid credentials` as any other failure. Verified by
reading the branch rather than inherited from the review (AN3) - the third such
correction.

**My first SEC-08 fix was incomplete, and a test caught it.** A known address
with no reset code answered "No verification code found" while an unknown one
answered "Invalid verification code", so the oracle SURVIVED the change meant to
remove it. Found because the test asserted BYTE-IDENTICAL BODIES rather than
identical statuses. Asserting the status alone would have passed.

### One defect the wiring introduced

Wiring the Redis limiter made every process that imports `app.js` hang on exit,
because the client held the event loop open - the auth suites passed and then
never terminated, which reads as a broken test rather than as a held socket.
Fixed with `unref()`: in production the HTTP server keeps the process alive, and
a rate limiter has no business doing it.

### The identifier split this package forced

`req.user` now carries BOTH ids: `id` is the external ObjectId, used for
comparisons against client-supplied values, and `uuid` is the MySQL key used for
repository lookups. Conflating them made `/auth/me` answer 404 for a valid token,
because an ObjectId was being looked up as a uuid.

`uuid` is NULL for an account still in MongoDB, which makes a half-migrated
account VISIBLY half-migrated: a handler that needs the repository gets null and
answers 404, rather than searching for an id that cannot match and failing for a
reason nobody can see.

---

## Information-disclosure findings: assert the FULL BODY, never the status (AP1)

> **For any finding about information disclosure through response differences,
> assert the entire response body identical across the cases being compared.
> Never the status alone.**

**The worked example is my own incomplete fix.** Package 3.2 unified three
endpoints for SEC-08 and reported it closed. It was not: a known address with no
reset code answered "No verification code found" while an unknown one answered
"Invalid verification code" - same status, different body. **A status-only
assertion passes, and SEC-08 gets marked closed while still open.**

**The full audit then found four MORE oracles** that the original fix had not
touched, because it only looked at the endpoints already under test:

| Endpoint | The oracle |
|---|---|
| `/login/verify-otp` | `Invalid credentials` (unknown) vs `Invalid OTP` (known) |
| `/signup/resend-otp` | 404 (unknown) vs 200 (pending signup exists) |
| `/signup/verify-otp` | 404 "No pending signup found" vs an OTP error |
| `/forgot-password/verify` and `/reset` | "expired" and the attempt cap are reachable ONLY for an existing account |

All closed except the last, which is a genuine conflict - see below.

**This is BUG-11's assertion-strictness decision paying off in an unrelated
package.** Narrowing `assertRefused` from "any of three keys carries a reason"
to "`error` carries it" was done for BUG-11; the same instinct - assert the
strongest true thing, not the most convenient - is what made the SEC-08 test
compare bodies. A test that asserts less than it could is not cheaper, it is
just quieter about what it did not check.

**Field ordering and nested codes count.** `deepEqual` catches an oracle hiding
in an extra field or a nested error code, which is where one goes once the
obvious string has been unified.

---

## UNRESOLVED: SEC-02 versus SEC-08 on the reset-code cap

**Both cannot hold as written, and the conflict is recorded rather than
resolved by quietly picking one.**

- **SEC-08** wants every response identical for existing and non-existing
  accounts. An attacker can DRIVE a known account to the attempt cap - request a
  reset, guess five times - so the `429 Too many attempts` confirms the account
  exists.
- **SEC-02's regression suite** asserts that exact 429, because a control that
  announces itself is how that finding was demonstrated closed. That suite must
  pass UNCHANGED (SPEC-3 section 4.1).

**The 429 stands**, because editing the SEC-02 scenario to accommodate this
would be precisely the silent behaviour change section 4.1 exists to prevent.
The residual oracle is ASSERTED in `auth-characterisation.test.js` so that the
day it is closed, that test fails and someone updates it deliberately.

**FUNDED AND ASSIGNED TO PACKAGE 3.4 (AQ1).** Accepting the residual would leave
SEC-08 half-closed indefinitely, and a 429 that confirms an account exists is a
real enumeration primitive on a public donation platform.

Requirements, all three:

1. **The counter covers addresses with NO account**, so the cap response is
   identical either way. That is the whole point; a counter that only exists for
   real accounts reproduces the oracle.
2. **Cap the RESPONSE, not the ACCOUNT.** An attacker must not be able to lock a
   real user out by exhausting their reset attempts - the counter throttles what
   the endpoint will say, it does not disable anything. This is the requirement
   that makes the feature safe to add at all: a per-address counter is otherwise
   a denial-of-service primitive handed to anyone who knows an address.
3. **Assert the full body identical at the cap** (AP1), for an address with an
   account and one without.

**WHEN IT LANDS, THE SEC-02 SCENARIO ASSERTING 429 CHANGES.** That is the
deliberate edit SPEC-3 section 4.1 asks for, not a breach of it: state it as a
behaviour change with the reason, in the commit and in this map. The rule is
against editing a scenario QUIETLY to make a package go green - not against
changing behaviour on purpose and saying so.

---

## SEC-08 on `/signup` - DEFERRED, with a trigger and an owner problem (AP2)

`"User already exists with this email"` is the one remaining account oracle, and
it is deliberate. Closing it means always answering "check your email" and
sending EITHER a verification code OR a "someone tried to register with your
address" notice.

**Trigger: the package that migrates `Backend/config/email.js`.**

**IT WAS A GAP IN THE PLAN, AND IT NOW HAS A PACKAGE (AQ2).** `config/email.js`
was owned by no Phase 3 package and Phase 5 is scoped to the frontend and
dependencies, so the deferral had no owner - which is exactly how U-2 through
U-6 happened.

**Assigned to package 3.5a**, before `admin.js`.

**THE AUDIT (AQ2): it is one template.** Everything assigned to
`config/email.js`, checked against the review and the ADRs:

| Candidate | Verdict |
|---|---|
| SEC-08 on `/signup` | **IN SCOPE.** Needs a "someone tried to register with your address" template so the endpoint can answer identically whether or not the account exists |
| ADR-027, escape per sink - "an email template is not React" | **ALREADY DONE.** `config/email.js:4` defines `escapeHtml` and applies it to `userName`; the codes it interpolates are server-generated six digits, not attacker-controlled. Remains a STANDING CONSTRAINT on any field added later, not work |
| LOW-06, `module.exports` ordering | Already fixed - appendix A of the review |
| SEC-11, "email flooding" | Not this file. It is about unauthenticated endpoints accepting unlimited writes, and it belongs with the limiter |

So 3.5a is one template and the `/signup` handler change that uses it. Kept
small deliberately: the reason to name the package was to give the finding an
owner, not to invent a body of work for it.

---

## When the symptom points away from the cause (AP4)

A short list, because the pattern has now cost real time four times.

| Symptom | Cause | The "fix" that would have hidden it |
|---|---|---|
| The auth suites PASS and then hang forever | Wiring Redis left a socket holding the event loop | A force-exit flag - which would have hidden a genuine resource leak, in a module every process imports |
| The SEC-02 suite fails with 429 on its FIRST request | The Redis limiter is shared and persistent, so a re-run inherits the previous run's counters | Marking the suite flaky, or adding a retry |
| An injected login returns 500 | The SMTP send failing AFTER the credential check was passed | Reading the 500 as a refusal - which is what happened, and it hid SEC-03 for a full package |
| **DC1:** some donors get a 500 after ~30 s, others are fine; the log says `pool timeout ... active=0 idle=0` | Hostinger refused the connection with `1226 ER_USER_LIMIT_REACHED` (75 per user), and the driver dropped the reason | A bigger `PRISMA_CONNECTION_LIMIT` or a longer pool timeout - each asks for more of the connections the server has just refused |

The common shape: **infrastructure made correct produces a symptom that reads as
a broken test.** The natural response makes the test quiet rather than making
the system right. In all of them the honest read was available immediately from
asking what the symptom would mean if the code were correct. **DC1 is the same
shape outside the test suite:** the symptom read as a slow network, and the
cause - a specific, named refusal - had been discarded before it reached the log.

---

## DEPLOY-01 - two deployments sharing one Redis throttle each other (AQ4)

**Severity** Medium, operational. **Provenance X** - found when the SEC-02 suite
began failing with `429` on its FIRST request after SEC-04 was wired.
**Owning package: closed by `RATE_LIMIT_PREFIX`; the documentation half lands
with the self-hosting docs.**

Wiring the Redis-backed limiter (SEC-04) changed the store from per-process to
**shared and persistent**. That is exactly what the finding asked for, and it
introduces a failure mode the MemoryStore could not have:

**Two deployments pointed at one Redis share rate-limit buckets.** A staging
instance and a production instance, or a blue/green pair, count each other's
requests against the same 5-per-minute budget. Real users get `429`s caused by
traffic they never generated.

**IT IS VERY HARD TO DIAGNOSE, and that is the substance of the finding.** Each
side sees a limiter behaving perfectly correctly: the counter increments, the
window rolls, the 429s are issued exactly as configured. Nothing is broken
anywhere. The only way to see it is to notice that the counts do not match the
traffic on either host - which requires already suspecting the answer.

**An NGO self-hosting this is a plausible victim.** Standing up a staging
instance by copying the production `.env` and changing the database URL is an
ordinary thing to do, and `REDIS_URL` is exactly the line someone would forget
to change. The reward for the mistake is intermittent 429s on the donation and
login paths under load, which reads as a capacity problem.

**Closed by `RATE_LIMIT_PREFIX`**, which namespaces the keys. Documented in
`.env.example` next to `REDIS_URL`, because that is where the person about to
make the mistake is looking.

Recorded rather than fixed-and-forgotten because it belongs to the class in AP4:
**infrastructure made correct producing a symptom that points somewhere else.**
It first appeared as a flaky test, and the natural response - a retry, or marking
the suite unreliable - would have left the deployment hazard in place with no
trace that anyone had seen it.

---

## PER-PACKAGE ACCEPTANCE CRITERIA (AR6) - the inherited-claim gate

**AN3 was an observation. Seven claims in seven consecutive packages, the last
one mine, make it a gate.**

> **Every package MUST list, in its commit message, each claim it relied on that
> came from a DOCUMENT rather than from observed behaviour. Each listed claim is
> either VERIFIED - by running something - or explicitly marked UNVERIFIED and
> carried as a risk.**

An unverified claim is not a failure and must not be treated as one. **Listing it
is the deliverable.** Six of the seven were load-bearing and wrong; the cost of
each was a package or more of work built on it. The cost of writing three lines
saying "I took this from the map and did not check it" is three lines.

### What counts as inherited

A claim is inherited if the package acted on it and the evidence for it is a
sentence somewhere - the security review, SPEC-1A, SPEC-3, an ADR, the map, a
code comment, or a previous commit message. **Including comments I wrote myself
in the previous package**, which is where the seventh came from.

### What counts as verified

Running something and reading the result: a test, a query, a request against the
stack, a grep that enumerates call sites. **Re-reading the document is not
verification** - it is how the claim propagated in the first place.

### THE CITATION RULE (AU2) - listing is not catching

**AR6 as first written was not enough, and the evidence is its own output: I
listed three inherited claims for package AT1-AT5 and two of them were wrong.**
Listing a claim after acting on it records the failure; it does not prevent it.

The signature AT5 identified is the fix. The highest-risk claims are the ones
**written IN PASSING TO CLOSE A FINDING, inside a commit about something
larger.** Nobody re-reads them - including the author, who knows what they meant
and therefore reads the sentence as a description of their own intention rather
than as an assertion about the system.

> **Any sentence in a commit message, a code comment or an ADR that asserts a
> finding is CLOSED, NARROWED, or NOT APPLICABLE must cite the behaviour that
> establishes it: a test name, a probe output, or a file:line reference.**
>
> **A closure claim with no citation is flagged UNVERIFIED. It is not listed as
> verified, and it is not listed as a claim at all - it is listed as a gap.**

The asymmetry matters. "I checked" is a claim about the author. "`test:admin`
case 12 asserts it" is a claim about the repository, and anyone can falsify it
in one command.

#### The two that were wrong, worked through

**CLAIM: "3.5's findings are all closed by AS7."**

*Asserted in:* the AS7 commit message, as a list - BUG-03, BUG-08, SEC-18,
SEC-18b, SEC-19, SEC-21 and SEC-10 closed; SEC-08 not applicable; BUG-04's cron
the only remainder.

*What was true:* everything in that list was correct. **U-2 was not in the
list.** It had been parked against 3.5 as a design-only item, and collapsing the
package orphaned it - the U-2-through-U-6 pattern recurring on U-2 itself.

*The citation that would have caught it:* the claim is about a SET, so its
citation has to be the enumeration that produced the set - `grep -n "3\.5"
docs/remediation-map.md`, run and its output read. I ran exactly that grep one
package later, under AL3, and it found the orphan immediately. **The claim was
made from memory of what I had just migrated, not from the document that owns
the assignments.**

**CLAIM: "the gates are checked before deletion."**

*Asserted in:* `config/destructiveJobs.js`'s header and `services/scheduler.js`'s
comments, while building AT1.

*What was true:* both gates sat AFTER the candidate count, which short-circuits
on zero. So a job with nothing to delete never reached either gate, and an
unauthorised job would look correct until the day a row first qualified.

*The citation that would have caught it:* a test NAME. "Checked before deletion"
is a claim about control flow under a specific condition - zero candidates - and
naming the test that covers that condition forces the question "does one exist?".
It did not. The test I later wrote failed with `Missing expected rejection`,
which is precisely the state the citation rule asks you to discover before
writing the sentence rather than after.

#### AND FOR DESTRUCTIVE ASSERTIONS, ONE MORE QUESTION (AW1)

> **For any assertion that a control DESTROYS or REVOKES something at a
> threshold, ask: what does an attacker gain by reaching that threshold ON
> SOMEONE ELSE'S BEHALF?**

A question, not a prohibition - the answer is often "nothing" and the assertion
is then correct. It exists because SEC-02's suite asserted that a user's reset
code must be VOIDED at the attempt cap, which defended nothing and handed anyone
who knows an address a five-request denial of service on that user's reset. See
AW1.

#### A MITIGATION THAT DEPENDS ON A HUMAN (AY1)

> When a recommendation's effectiveness depends on a human reading something, it
> CANNOT carry a closure claim. Either pair it with a mechanical control that
> can, or leave the finding OPEN with the mitigation noted.

#### WHEN FIXING AN ASYMMETRY, ENUMERATE THE SIBLINGS (AY2)

> Enumerate every sibling branch and endpoint in the same file and STATE, for
> each, whether it has the same property. Written down, not checked mentally -
> the failure mode is looking and not seeing, four times so far.

#### THE RULE THAT AUDIT FOUND (AX3)

The question above is what to ASK. This is what the answer turned out to be, and
it is checkable by inspection rather than by investigation:

> **A destructive threshold is SAFE when reaching it requires authority the
> destruction itself presupposes. It is DANGEROUS when an unauthenticated party
> can reach it on someone else's behalf.**

Ten of the eleven destructive assertions in the suites were safe, and **all ten
for that one structural reason** - an admin, or the holder of a valid code, or
the passage of time. **The reason is the finding, not the count.** A future
package does not need to re-run the audit to classify a new assertion; it needs
to name who can reach the threshold.

The eleventh was `signupOtpAttempts` resetting on a second `/signup`, reachable
by anyone, which is SIGNUP-01.

#### What this does NOT require

It does not require a test for every claim. It requires that a claim with no
citation be **labelled as such**. An honest "UNVERIFIED: I believe this closes
SEC-19 but nothing asserts it" is a useful entry. A confident "SEC-19 closed" is
not, and is worse than silence, because the next reader inherits it.

---

### The register

| # | Claim | Inherited from | Outcome |
|---|---|---|---|
| 1 | SEC-03 is "NoSQL operator injection", Medium | the security review | **WRONG** - a CRITICAL unauthenticated auth bypass |
| 2 | SPEC-1A §5.6's `mihpayid` claim | SPEC-1A | **WRONG** - ADR-026 |
| 3 | The package sequence | SPEC-3, restated in the map | **WRONG** - two contradictory sequences (AL3) |
| 4 | SEC-08 leaks via `/login`'s `needsSignupVerification` | the security review | **WRONG** - the branch is past `bcrypt.compare` (AP3) |
| 5 | AE1-b's trigger is `donations.js` | AE1, restated, revised once | **WRONG FILE** - the ObjectId ref is written by `payment.js` |
| 6 | `scheduler.js` "already implements the same retention rules" | the BUG-10 mechanism | **TWO OF THREE** - the inactive-account purge had no replacement |
| 7 | The auto-verify branch is "narrowed to accounts that predate the OTP flow" | **my own comment, 3.2** | **NEVER IMPLEMENTED** - it applies to everyone |
| 8 | BUG-03's counter is "always 0" | the review, restated in the map | **WRONG** - it counts the lowercase subset; measured 1 of 2 (AR1) |
| 9 | SEC-10 is closed: "one shared validator across all five paths" | **my own claim, package 3.2** | **TRUE OF ONE FILE.** It was local to routes/auth.js; admin.js had a sixth, whose check said 10 and whose message said 6 (AT5) |
| 10 | "`present()` below already returns `legacyId \|\| id`" | **my own comment, package 3.4** | **WRONG.** It returned `legacyId` alone, so every new category got `_id: null`. Caught in minutes by four assertions |
| 11 | "making the notice fire-and-forget closes the oracle" | **my own comment, package 3.5a** | **IT INVERTED IT.** See AX4 below |

**ELEVEN NOW.** Number 8 arrived during the audit commissioned because of number
7, number 9 during the package commissioned because of number 8, and numbers 10
and 11 in the two packages after that. The claims do not run out, and each pass
that looks for them finds one.

**THREE OF THE NINE ARE MINE, AND TWO OF THE LAST THREE.** That is the shift
worth naming: the rule was built for claims inherited from other people's
documents, and it now catches mostly my own - sentences written to close a
finding, inside a commit about something larger, never re-read because I knew
what I meant. A claim does not need age to be inherited. It needs only to be
asserted once and relied on afterwards.

### The pattern that predicts them

Claims 5 and 6 are about **WHICH FILE or WHICH COMPONENT** does something, not
about whether it is done. "Donations migrate" and "the scheduler implements the
retention rules" are true sentences attached to the wrong subject, and they
survive review because the reviewer checks the predicate - which is correct.
**The countermeasure is to enumerate the call sites rather than reason about the
name**, which is AD2's method and now AR1's audit.

---

## The three ordering constraints, in order of precedence (AK2)

> **A FOURTH was added in package 3.3, and it sits BELOW these three because it
> does not change the ORDER - it changes the GRANULARITY.** Where one entity's
> WRITER and READERS are in different packages, those packages are ONE MERGE
> (ADR-057). Donations are the case: `payment.js` writes them and `donations.js`
> reads them, so either package alone leaves new donations in one store and the
> admin console reading the other.

Each was found by hitting it. None was found by planning.

| # | Constraint | Found by | Governs |
|---|---|---|---|
| **1** | **Data location** (ADR-056). A route's LIST and WRITE paths cannot migrate before that entity's DATA has migrated. Single-record reads can be bridged; lists and writes cannot, because they address a STORE rather than a record. | Probing a Mongo-only category against the migrated route: `GET` returned `[]` | Everything. It subordinates both the others |
| **2** | **Foreign key direction** (ADR-055). A table cannot migrate before the tables it references. Reads can be bridged; references cannot, because the constraint is enforced inside one database against rows in another. | Attempting to write a donation whose `user_id` referenced a MySQL row that did not exist | Which entity before which |
| **3** | **Read dependency** (AD2). A file is safe to migrate when everything reading its data has moved, or when a bridge exists. | Finding that `categories.js` has the smallest write surface and the largest read surface | Which FILE before which, once 1 and 2 are satisfied |

**The original criterion - the size of the file being changed - was wrong
entirely**, not merely incomplete. It is a property of the work; every real
constraint above is a property of the data. Sequencing by how much typing a
package involves has no relationship to what makes a package safe.

Worth stating plainly: three corrections, each one found by attempting the work
rather than by analysing it harder. The analysis got better each time and still
missed the next constraint, because each was invisible from where the previous
one was standing.

---

## The suite-provenance rule (AK3) - SPEC-3 §1 amendment

> **Every characterisation suite must include at least one fixture created in
> the OLD store and NOT migrated, and must assert the endpoint behaves correctly
> against it.**

**Why the existing rule was not enough.** Every suite creates its fixtures
through the `store` seam. After the seam switches, the suite writes to the NEW
store - so it migrates its own data along with the route and then asserts the
route works on it. The categories suite was green 22/22 before and after, and
not one scenario exercised a record that predated the migration. Meanwhile the
endpoint returned `[]` for every real category.

The coverage rule was followed to the letter. It says to pin the endpoint's
BEHAVIOUR and says nothing about the PROVENANCE of the data it is pinned
against, and that gap is exactly the size of ADR-056.

**AE3 had already made this point about a different control:** "a database of
only new records cannot take the fallback path, so it proves nothing". Identical
reasoning, written three packages earlier, about the bridge's exit check.
Neither of us generalised it to the suites.

**So record the meta-lesson too: a rule stated about one control does not
propagate to the others on its own.** It has to be restated, deliberately, at
each place it applies. AE3 was correct and specific and therefore stayed
specific.

**Retroactive**: apply to `categories-characterisation` (22) and
`donations-characterisation` (24) before either package is considered closed.

---

## Revised sequence (AK5)

| Pkg | Work | Trigger |
|---|---|---|
| **4a** | The ETL: schema-aware transform for all five entities, run LOCALLY, with the SPEC-1A §8 pre-flight reports. Report-only, never silently correct | none - it is the root |
| **3.1r** | Categories data migrated locally; route re-verified; AK3 fixture added | 4a exists |
| **3.2** | `auth.js` + `users.js` + `middleware/` - completing what is already built | users data migrated |
| **3.3** | `donations.js` + retire `dataCleanupService` | donations data migrated; users migrated (FK) |
| **3.4** | `payment.js` + **the per-address attempt counter** (AQ1) + **AE1-b: remove `mintObjectId()` from `categories.js`** | donations data migrated |

> **3.3 AND 3.4 MERGE TOGETHER (ADR-057).** `donations.js` reads donations;
> `payment.js` writes them. Either one alone leaves new donations in one store
> and the admin console reading the other. The work stays split; the merge does
> not. See "Package 3.3" above.
| **3.5a** | **`config/email.js`** (AQ2) | none - it was unowned |
| ~~**3.5**~~ | ~~`admin.js`~~ **DONE IN AS7.** Migrating its user operations and the two `/stats` counts was the whole file - there was no remainder. BUG-04's dead Vercel cron declaration is all that is left, and it is a deployment change | - |
| **3.6** | Mongoose removal from the REQUEST PATH and the test suites. `etl/` and `models/` RETAINED (ADR-059) | no file reachable from a request imports Mongoose; `fallbackCount()` zero (AE3) |
| **4b** | Production cutover: freeze, rollback boundary, J3, snapshot rehearsal | Phase 3 complete |
| **4c** | Terminal cleanup: `etl/`, `models/`, the `mongoose` dependency, `scripts/seedDatabase.js`, `docker-compose.legacy-mongo.yml` | 4b complete, rollback boundary closed |
| **4d** | The Prisma advisory bump (U-6) - its own package because it regenerates the client the data layer sits on | after 4c, so a failure in either cannot be attributed to the other |
| **4e** | **SEC-15: the session moves from `localStorage` to an httpOnly cookie** (CH3). Not small; see "SEC-15 - OPEN" | 4b complete, **and frontend and backend served from the same site** |
| **5** | Frontend | Phase 4 complete |
| **6** | Release: licence, rotation (no history scrub, CG1), publication gate (bypassed, Phase 6 checklist §0) | Phase 5 complete |

**4a moving ahead does not reorder the phases** - it splits one. 4b stays last
and is stronger for it: the ETL will have been exercised by five route packages
against real data before it is ever pointed at production, instead of rehearsed
once against a snapshot. Nothing on the critical path is blocked on credentials.

---

## Corrected package sequence (AD2) - SUPERSEDED BY AK5 ABOVE

Kept because it records the read-dependency reasoning, which still holds as the
THIRD constraint. The sequence table in it is out of date; AK5 is current.

### The Phase 3 exit criteria (still current)

**SPEC-3 section 2 sequenced by the size of the file being changed. That was the
wrong criterion** - the risk is in the files NOT being changed. Re-derived by
READ DEPENDENCY in ADR-052. A file is safe to migrate when everything reading
its data has moved, or when a bridge exists.

| Pkg | File(s) | Introduces | Retires |
|---|---|---|---|
**THE SEQUENCE TABLE THAT WAS HERE IS DELETED (AQ3/AL3).** It was the second
statement of the package order in this document, and two statements of one order
is precisely how the map came to contradict itself. **The sequence is stated
ONCE, under "Revised sequence" above.** What remains below is the read-dependency
REASONING, which is still correct as the third ordering constraint.

The bridges each die when the last reader of their entity migrates, and the
minted `legacy_id`s are NULLed before MongoDB is deleted - both are triggers, and
both are recorded against the packages that own them rather than restated here.

`admin.js` moves from third to **last**, because it is the last reader of all
three bridged collections and putting it last lets every bridge die in one
package rather than lingering. `auth.js` + `middleware` moves to **second**.

**3.2 and 3.3 were swapped again by ADR-055**, on a constraint the read-
dependency analysis could not see: `donations.user_id` is a FOREIGN KEY into
`users(id)`, so donations cannot migrate before users exist in MySQL. Reads can
be bridged; references cannot. The corrected principle in full:

> Sequence by READ DEPENDENCY, subject to FOREIGN KEY DIRECTION. A table cannot
> migrate before the tables it references.

The FK roots in this schema are `categories` and `users`; `donations` references
both; `donation_payment_details` references `donations`. 3.1 migrated a root,
which is why it worked.

**Bridge count: two new, three alive at peak** - and they are three instances of
ONE mechanism, not three bespoke components. ADR-052 records that generalising
`categoryBridge.js` into one parameterised module is the recommendation, and
that needing materially different resolution logic rather than different
parameters is the signal to stop.

**`dataCleanupService` was live-reachable and had been treated as dead.**
[location redacted while open] imports three of its functions, which DELETE donations and users.
BUG-04 stops the cron firing, which is what made it look inert, but an admin can
still invoke it. Retiring it removes a reader of `Donation`, `User` AND
`PendingSignup` in one change, and takes `PendingSignup` to a single reader so
it needs no bridge at all.

### Phase 3 exit criteria, as amended

SPEC-3 section 7, plus what AE1 and AE3 added. **The order of the first two is
the control, not a preference.**

| # | Condition | Why it is in this position |
|---|---|---|
| 1 | For every category with a non-NULL `legacy_id`, look it up in MongoDB; **if absent, NULL it** | A minted id is distinguishable from a genuine one ONLY while MongoDB exists. Do this after deleting Mongo and the distinction is gone permanently, and a fresh open-source install ships fabricated ObjectIds in a column documented as holding real ones. **No timestamp heuristics** - the lookup is a fact, the heuristic is a guess. |
| 2 | Delete MongoDB | Only after 1 |
| 3 | `fallbackCount()` zero across the **full** test suite, asserted rather than eyeballed | Part one of AE3 |
| 4 | `fallbackCount()` zero across a manual exercise of every migrated route, against a database holding **both** migrated and post-3.1 records | Part two of AE3. A database of only new records cannot take the fallback path, so it proves nothing |
| 5 | All three bridges deleted | Follows 3 and 4 |
| 6 | No file under `Backend/` imports Mongoose; `config/db.js` and `models/` deleted | SPEC-3 section 7 |
| 7 | `docker-compose.legacy-mongo.yml` deleted; plain `docker compose up` gives four healthy services | ADR-047 |
| 8 | `mongoose` and `mongodb` out of `package.json`, both lockfiles regenerated; Mongo service out of `app-tests.yml` | SPEC-3 section 7 |
| 9 | SEC-04 reported **closed** with its wiring commit, reversing the Phase 2 report | SPEC-3 section 7 |

### Two items AE1 adds to the backlog

| ID | Item | Owner |
|---|---|---|
| AE1-a | NULL every minted `legacy_id` before MongoDB is deleted, by lookup | 3.6, as criterion 1 above |
| AE1-b | Remove `mintObjectId()` from `categories.js` once the donation WRITE PATH has migrated | **3.4 - CORRECTED IN 3.3 (fifth inherited claim).** The trigger was recorded as `donations.js`. The concept was right - "until the ObjectId ref stops being written" - and the FILE was wrong: the ref is written by `payment.js:141`, not by `donations.js`, whose own write is BUG-01 and has never succeeded. Removing the minter at 3.3 would have broken the live donation write path on the first category created afterwards. It had ALREADY been revised once - the ADR-055 swap moved its package number and never re-read its reasoning. |

**SPEC-1A section 4.1 is temporarily false** and is corrected in ADR-051(c):
its invariant that a non-NULL `legacy_id` means "migrated from MongoDB" does not
hold during the Phase 3 window. AE1(b) stops new violations, AE1(a) removes the
existing ones, and after 3.6 the invariant is true again - deliberately restored
rather than never broken.

---

## Open findings, by OWNING FILE

**Keyed by file and TRIGGER, not by package number (AJ2).** "Mechanism" is how
it gets fixed; "Verification" is what proves it.

**These headings previously carried package numbers, and they were WRONG.** The
ADR-055 swap renumbered the sequence and this section was not updated with it,
so the map contained two contradictory numberings at once: the sequence table
said 3.2 was auth, while this section still said 3.2 was donations. A reader
following either one would have been right about half the time.

That is the whole argument for AJ2. **A package number is a position; the real
dependency is an event.** We have now reordered three times - write size, read
dependency, foreign keys, and now data location - and each reorder invalidated
every number written down and none of the triggers. The `*(trigger: ...)*` note
is the durable part; the "currently N" is a convenience that will go stale
again and is marked so nobody trusts it.

### `routes/categories.js`  *(trigger: categories data migrated locally; currently 3.1r)*

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| - | - | **All closed. See "Package 3.1 - COMPLETE" above.** The one item deliberately left open is the non-atomic reorder, which moves to the transaction work. | | | |

### `routes/donations.js`  *(MIGRATED in package 3.3)*

**All closed - see "Package 3.3" above.** The three items deliberately left open
are AG4 (a guest cannot retrieve their own donation - a product question, pinned
so it cannot change silently), the ADR-057 merge constraint, and the unbounded
row count on `stats/charts` for a multi-year custom range, which is pre-existing
and was not changed alongside the store swap.

The original table is kept below as the record of what the package was given.

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| SEC-16 | Low | `PUT /donations/:id` writes any `status` string ([location redacted while open] - `findByIdAndUpdate`, no `runValidators`) | Repository accepts only enum members; MySQL ENUM rejects the rest | Test writes a junk status and expects rejection | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| BUG-01 | - | `POST /api/donations` can never succeed - builds a document without the required `donorEmail`/`amount` ([location redacted while open]) | Decide: supply the fields or delete the endpoint | Characterisation test records the current 400 **as current behaviour**, then the change is visible | **R** |
| BUG-02 | - | `PATCH /:id/status` accepts only lowercase `approved`/`rejected` ([location redacted while open]) while callbacks write `Approved`. **MECHANISM NOW VERIFIED BY BEHAVIOUR (AM3)** - see below | Canonical enum casing through the repository | Test asserts both casings resolve correctly; see ADR-018 for the ETL side | **R**, mechanism confirmed **X** |
| BUG-06 | - | `optionalAuth` 401s a guest holding a stale token ([location redacted while open]) | Catch the auth failure and fall through to guest | Test: expired token + guest donation succeeds | **R** |
| BUG-08 | - | Unbounded pagination ([location redacted while open]) | As 3.1 | As 3.1 | **R** |
| ADR-041 | - | `distinct()` must keep data semantics, not enum semantics | `donations.listStatusesInUse()` | Already tested in `test:data-layer`; route test asserts the endpoint's shape | **R** |
| ADR-003 | - | Deleting a user preserves their donations - **behaviour change** | FK `ON DELETE SET NULL`; `donor.isGuest` distinguishes | Test: delete a donor, donation survives and stays attributable | **R** |

### `routes/admin.js`  *(MIGRATED in AS7 - see "AS7" above)*

**All closed except BUG-04's dead Vercel cron declaration, which is a deployment
change rather than a route change.** SEC-08's admin half is NOT APPLICABLE - both
endpoints that name an address are behind `adminAuth`, and the same caller can
list every account with a GET one request later.

The original table is kept below as the record of what the package was given.

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| SEC-08 | Medium | User enumeration (admin-side endpoints) | Generic responses | Test asserts identical responses for known and unknown | **R** |
| SEC-18 | **Low** (AJ3: was Medium) | bcrypt cost 10 ([location redacted while open]). **The real finding is that these call `bcrypt.hash` DIRECTLY instead of `repositories/users`** - two hashing implementations, one governed by policy | Route both through `users.create` / `users.setPassword` | Test asserts the cost AND that an admin password reset revokes sessions | **R**, re-derived **X** |
| **ADMIN-01** | **High** | **EVERY admin user-management operation writes MongoDB, which authentication no longer reads.** See the dedicated section above - this is not a bcrypt finding and not a `tokenVersion` finding, it is a store split | Migrate `admin.js`'s user operations, or move them into the package that owns the entity | Test: each admin operation, then assert the effect through `/api/auth/login` | **X** (AJ3) |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| SEC-21 | **Medium** (AJ3: was Low, and RESTATED) | **`isVerified` gates nothing.** It is read in exactly one place in the codebase - [location redacted while open], the line that sets it true. SEC-05's shape. Not High only because self-service signup enforces verification structurally via `PendingSignup` | Decide whether the flag is a control. If it is, gate on it; if it is not, remove it rather than leave a field the admin UI can toggle to no effect | Test: an unverified account is refused, or the field is gone | **R**, re-derived **X** |
| BUG-03 | - | **Dashboard "approved" counter is NOT "always 0" - it counts the LOWERCASE SUBSET** (`countDocuments({status:"approved"})`, [location redacted while open]). Measured in the AR1 audit: it returned **1 when the true figure was 2**. It reads 0 only where no admin ever used `PATCH /:id/status`; anywhere else it reads a plausible fraction. **A tile showing 0 is visibly broken; a tile showing 1 of 2 is believed** | Canonical casing; follows BUG-02, and closed as a side effect of migrating the two `/stats` counts | Test: donations approved through BOTH writers, expect the tile to count both | **R**, corrected by **X** (AR1) |
| BUG-04 | - | Retention purge has never run - Vercel cron hits `/api/admin/cleanup/trigger` behind `adminAuth` ([location redacted while open]) | Phase 2's `services/scheduler.js` replaces it; remove the dead cron declaration | Scheduler tests already pass; assert the endpoint is gone or authenticated by shared secret | **R** |
| BUG-08 | - | Unbounded pagination ([location redacted while open]) | As 3.1 | As 3.1 | **R** |

### `routes/auth.js` + `routes/users.js` + `middleware/`  *(trigger: users data migrated; currently 3.2)*

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| **SEC-04** | **High** | **Rate limiting non-functional** - [location redacted while open] builds a default in-memory limiter | Wire `config/rateLimiters.js`. **This is what closes the finding** (ADR-042) | `test:auth` unchanged; assert the Redis store is in use | **R** |
| **SEC-05** | **High** | `isActive` never enforced and tokens cannot be revoked - confirmed: the flag exists on the model and [location redacted while open] toggles it, but **no route or middleware reads it**, and `tokenVersion` does not exist in `routes/`, `middleware/` or `models/` | Check `isActive` at both login steps and in both middlewares; `tokenVersion` on the token, incremented by `setPassword`/`setActive` | Test: disable an account, existing token rejected, login refused | **R** |
| **SEC-03** | **High** | NoSQL operator injection - **12+ `findOne({ email })` call sites, no `String()` coercion anywhere in `routes/` or `middleware/`** | Parameterised SQL removes the class; repositories coerce and lowercase | Test posts `{"email":{"$ne":null}}` and expects no match | **R** |
| SEC-08 | Medium | User enumeration on five endpoints | Generic responses | Test asserts identical responses | **R** |
| SEC-10 | Medium | Password policy absent in two places, inconsistent elsewhere | One shared validator across all five paths | Test each path with a weak password | **R** |
| SEC-13 | Medium | OTPs and reset codes stored in plaintext - confirmed at [location redacted while open] (`user.resetPasswordCode = verificationCode`) | Repositories store sha256 (`users.setResetCode`) | Test: read the row, assert no plaintext code | **R** |
| SEC-18 | Medium | bcrypt cost 10 ([location redacted while open]) | `BCRYPT_COST = 12` | As 3.3 | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| ADR-034 | - | A correct code at `/verify` must NOT clear the attempt counter | `users.verifyResetCode` deliberately does not reset | Already asserted in `test:auth` and `test:data-layer`; must stay true | **R** |
| ADR-033 | - | Duplicate index declarations in the Mongoose models | Moot once the models go (3.6); must not be reintroduced in the Prisma schema | Drift gate; boot logs free of the Mongoose duplicate-index warning | **X** |
| SEC-09 | Medium | Donor PII written to application logs | Strip PII; level-aware logger | Assert no PII in captured log output | **R** (ADR-032 upgraded the evidence to observed - **X**) |

### `routes/payment.js` + remaining seam  *(trigger: donations data migrated; currently 3.4)*

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| **SEC-14** | Medium | **Still live.** Malformed hash throws `RangeError` - char-length guard, byte-length decode ([location redacted while open]) | Validate `/^[0-9a-f]{128}$/i` before decoding | Extend [location redacted while open] to assert the response status, not only the donation state | **R**, re-opened by **X** |
| SEC-06 | **High** (AJ3: was Medium) | Unauthenticated donor PII via `GET /payment/status/:txnid`, and the `txnid` protecting it is published into the URL bar by the app's own redirects - confirmed: no auth middleware at [location redacted while open] | Authenticate; random transaction ids | Test: unauthenticated request returns no PII | **R** |
| SEC-07 | Medium | Donation attribution forgery - `userId` is destructured from `req.body` at [location redacted while open] and written at [location redacted while open] | Take the user from the token, never the body | Test: post a forged `userId`, assert it is ignored | **R** |
| SEC-11 | Medium | Unauthenticated write endpoints allow storage/email flooding | `paymentInitiateLimiter` (built in Phase 2, unwired); stale-`Pending` sweep | Test the limiter fires; scheduler test for the sweep | **R** |
| **PAY-01** | Low | **`quantity` is unbounded while `extraAmount` is clamped, on consecutive lines** ([location redacted while open]). `quantity="99999999999999999999"` prices a donation at 1.5e23, unauthenticated. After 3.4 it becomes an unauthenticated 500 instead | One `Math.min`, with the ceiling a named constant beside `extraAmount`'s so the pair cannot drift again | Test both bounds together | **X** (AJ3) |
| SEC-19 | Low | `details: error.message` at [location redacted while open] | Generic message | Characterisation test | **R** |
| ADR-012 / ADR-026 | - | SEC-01 idempotency is a non-atomic read-then-write. **ADR-026 supersedes ADR-012's conclusion**: the `mihpayid` UNIQUE index is integrity, NOT the replay defence | Wrap the callback in `withTransaction` (SPEC-3 §4.3) | Concurrent-callback test | **R** |
| ADR-024 §3 / ADR-026 / ADR-027 | - | No security decision may rest on an unsigned field; unsigned text must be escaped per sink | Keep the `verifyHash` banner; escape at each sink, not at ingest | Test asserts `unmappedstatus` cannot drive the decision | **R** |
| SPEC-3 §4.6 | - | Alternate-case parser fallbacks (`.AMOUNT`, `.STATUS`, `udf_4`, `udf[4]`) | Delete them; keep the banner comment | Tests unchanged - they are unreachable today | **R** |

### Mongoose removal  *(REQUEST PATH in 3.6; the dependency itself in 4c - ADR-059)*

Exit criteria are SPEC-3 section 7, **restated as two by ADR-059** because one of
them would have made the cutover impossible: the ETL reads production MongoDB
through Mongoose, and 4b is what runs it.

1. **3.6** - no file reachable from a request imports Mongoose. Gated by
   `test/migration-state.test.js`, which asserts the app registers ZERO Mongoose
   models at boot.
2. **4c** - `etl/` and `models/` are the last importers, deleted once 4b closes.

| ID | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|
| ADR-047 (first half) | the `config/db.js` coupling | Delete `config/db.js` and its `connectDB()` call; the api stops needing `MONGODB_URI` | Boot with no `MONGODB_URI`; no Mongoose connection attempted | **R**, **3.6** |
| ADR-047 (second half) | the `mongo` SERVICE in the override | Delete `docker-compose.legacy-mongo.yml` | Plain `docker compose up`, four healthy, no override | **R**, **4c** - 4b's snapshot rehearsal restores INTO that service |

---

## Deferred to later phases

### Phase 4a - the ETL itself  *(moves ahead of the route migrations, AK1)*

**Nothing here needs production access.** Built and run locally against seeded
and synthetic data; each route package migrates its entity's data in the local
database before migrating the route. That is what makes the route migrations
possible at all (ADR-056), and it means the ETL is exercised five times by real
packages rather than rehearsed once against a snapshot.

| ID | Finding / constraint | Prov |
|---|---|---|
| ADR-013 | Never `INSERT IGNORE` / `UPDATE IGNORE` | **X** (found by a schema test) |
| ADR-018 | Count mixed-case status values before insert; supersedes SPEC-1A's assumption that MySQL rejects them - it does not, `_ci` collation canonicalises silently | **X** |
| ADR-022 | Re-check strict SQL mode in its own preflight | **R** |
| ADR-025 | `gateway_status` will be NULL for the entire paid population at cutover | **R** |
| ADR-054 | Assert no migrated row has `donated_at` or `created_at` outside a sane range, and **report** rather than correct | **R** |
| ADR-051 | `legacy_id` is populated for rows that were never in MongoDB, so it does NOT mean "migrated" during the Phase 3 window | **R** |
| SPEC-1A §8 | The five pre-flight reports: case-variant emails, mixed-case status, float-to-paise, amount vs base+extra, orphaned category refs. **Report-only; never silently correct** | **R** |

### Phase 4b - the production cutover  *(stays last)*

**Everything credential-blocked lives here, and nothing else depends on it.**

| ID | Finding / constraint | Prov |
|---|---|---|
| ADR-031 | The rollback window closes at the first real donation into MySQL | **R** |
| J3 | Admin account enumeration, the `Password@123` check, the `PendingSignup` TTL index check. **Blocked on a dedicated read-only Atlas user** | **R** |
| - | A restored production snapshot. Same credential dependency, but now a CONFIRMATION of an ETL already exercised locally rather than its first real run | **R** |
| - | The freeze window and the cutover runbook | **R** |

### Phase 5 - frontend and dependencies

| ID | Sev | Finding | Prov |
|---|---|---|---|
| SEC-15 | Medium | JWT in `localStorage` (confirmed at [location redacted while open], [location redacted while open]) | **R** |
| SEC-17 | Low | `Frontend/.env` is tracked (confirmed by `git ls-files`) | **R** |
| SEC-20 | Low | `/tailwind-test` and `/button-showcase` routed in production ([location redacted while open]) | **R** |
| BUG-07 | - | Dead and mismatched frontend API methods | **R** |
| ADR-035 | - | `react-router-dom@7` major; the advisories themselves are unreachable | **X** (`npm audit` + reachability check) |
| ADR-037 | - | `vite` exposure restated accurately - not build-time only | **X** |

### Phase 6 - release

| ID | Finding | Prov |
|---|---|---|
| ADR-030 | History scrub, expanded scope | **R** |
| DEF-01 | Licence - **but see U-1: it blocks publication and has no owner today** | **R** |

---

## Source conflicts and supersessions

Recorded because SPEC-3 section 3 asks for both sides to be cited rather than
silently reconciled.

| Topic | Older source says | Superseded by | Which wins |
|---|---|---|---|
| `mihpayid` UNIQUE index | SPEC-1A §5.6 and ADR-012: it is the SEC-01 replay defence | **ADR-026** | ADR-026. `mihpayid` is unsigned and attacker-mutable; the index is a data-integrity control only. This is the one wrong rationale that reached a merged branch (ADR-048) |
| Mixed-case ENUM values | SPEC-1A §8.2: MySQL will reject them on load | **ADR-013, ADR-018** | ADR-013/018. `_ci` collation canonicalises `'approved'` to `'Approved'` silently, so the ETL must count them beforehand |
| `--default-authentication-plugin` | SPEC-1A §3.3 prescribes it | **ADR-015** | ADR-015. Removed in MySQL 8.4; the container crash-loops |
| `api`/`nginx` profile gating | ADR-006: gated, cannot start | **ADR-006 amendment (AA2)** | The amendment. Gating removed; acceptance is four healthy services **with the legacy-mongo override** |
| SEC-14 | Remediation plan lists it under "next sprint", and `test:payment` passes | **This document** | Still live. The test asserts the outcome, not the mechanism |
| ADR-024 item 2 | Recorded as an open Phase 3 question | **`a2b4556` / `b201818`** | Closed. The fix postdates the ADR |
| SEC-04 | Remediation plan: "trust proxy + Redis store" as one item | **ADR-042** | Split. `trust proxy` is closed and proven; the store is built but unwired, so the finding is open until 3.4 |
| SEC-09 | Review inferred it from the code | **ADR-032** | ADR-032. Upgraded to observed; the finding itself is unchanged |

---

---

## BA3 - A NOTE ABOUT A RESIDUAL IS NOT A CONTROL, AND THE DISTANCE WAS ZERO

AZ3 found that correct reasoning written down does not propagate at three
functions' distance. **This is the same failure at zero distance.**

In `etl/nullMintedLegacyIds.js` I wrote, under a heading reading THE RESIDUAL,
STATED RATHER THAN IMPLIED, that the guard catches an EMPTY MongoDB source but
NOT a POPULATED WRONG one. I wrote it minutes before running the suite. Then I
pointed the suite at a scratch database and it permanently nulled the `legacy_id`
of both categories the ETL had migrated from `kindledger_legacy`.

Same author. Same session. Same file. Minutes apart. The note did not reach the
code, and nothing about proximity helped.

### It is also AZ3's OTHER shape - the gate after the candidate count

Catching an empty source but not a populated wrong one validates the case where
nothing is at stake. An empty source is the case where a careful operator has
already noticed something is wrong; a populated wrong one is the case that looks
normal. **The guard fired on every configuration except the dangerous one.**

### The rule

> **A note about a residual must be converted into a guard or a test in the same
> commit, or it is not a control. Writing it down is documentation of a hazard,
> not mitigation of one.**

The countermeasure is AZ3's, because it is the only one available: enumerate and
state at the point of change. Not "check whether a guard is needed" - state, for
each residual, what closes it.

---

## BA3 - THE RESIDUAL AUDIT: every documented residual, and what closes it

Commissioned by BA3. **Absences are reported, not omitted** - the "no" rows are
the output of this audit, not the leftovers.

### THE RULE THIS TABLE NOW ENFORCES (BB5)

> **A documented residual with no test is indistinguishable from one nobody has
> thought about, and the map cannot tell them apart.**

So every row carries **either a test name or the word UNPINNED**. There are no
prose-only residuals in this project. A row that cannot name a test is making a
claim about a hazard that nothing would notice changing, and saying so in the
same column as the rows that can is what makes the difference visible.

"PINNED" does not mean fixed. Rows 5, 6, 7 and 9 are **open**, and safe to leave
open, because a test asserts the defective behaviour exactly - so closing it
FAILS that test, and the failure is the notification.

| # | Residual, as documented | Guard | Test that pins it, or UNPINNED | Verdict |
|---|---|---|---|---|
| 1 | **BUG-02's mixed-case `status` migrates invisibly** - MySQL silently canonicalises `'approved'`, erasing the only record of the corruption (ADR-014) | `etl/preflight.js` counts and reports before any insert | `etl.test.js` test 8, with the count | **CLOSED** |
| 2 | **`sql_mode` is settable at runtime**, so the boot check does not cover a connection opened later - and the ETL is exactly such a connection (ADR-022) | `etl/preflight.js` re-checks `@@SESSION.sql_mode`; `etl/cli.js` makes it FATAL | **UNPINNED** - nothing asserts the ETL refuses a non-strict connection | **GUARD ONLY.** Acceptable, since the guard is the control - but it has never been seen to fire |
| 3 | **`LIKE` wildcards in a search term** - a parameterised query stops injection, not `%` meaning "anything" | `escapeLike()` in the repositories | `admin-characterisation` and `donations-characterisation` both exercise `%`, `_`, `%%` | **CLOSED** |
| 4 | **SEC-08's residual oracle** - a mail failure must not distinguish known from unknown by status either | both branches fire-and-forget, one shared `res.json` | asserted in `auth-characterisation.test.js` | **CLOSED** |
| 5 | **SIGNUP-01 rec 2** - `signupOtpAttempts` resets on a re-post, so any anonymous caller can reset the counter | none - deliberately still live | **yes** - the test ASSERTS the counter resets 4 -> 0, pinning the residual rather than assuming it closed | **PINNED.** Open, but it cannot silently change |
| 6 | **SIGNUP-01 rec 3** - `/signup` is not rate-limited per address, and `upsert` lets an attacker destroy a legitimate in-flight signup by re-posting the address | none - deliberately still live | **`auth-characterisation.test.js`** - "a re-post DESTROYS a legitimate in-flight signup" and "the re-post is UNLIMITED", both with a control (BB2) | **PINNED, STILL OPEN.** Demonstrated end to end: the victim's emailed code is dead and no account is created, so it is denial of registration and not takeover. Implementing the limit has a trigger, not a phase - see below |
| 7 | **The 3.5a TIMING difference** - the new-account signup path hashes a password and writes a row; the existing-account path does neither | none | **`signup-timing.test.js`** (BB3) - MEASURED, with the number recorded | **PINNED, STILL OPEN, AND LARGER THAN EXPECTED.** See the BB3 measurement below |
| 8 | **`refusedAtLoad` (was `loaderRefuses`) is reporting only** - kept for the day a BLOCKING-but-loadable finding is added | **`finding()` now THROWS** at construction unless the check is in `BLOCKING_BUT_LOADABLE` with a reason (BB4) | **`preflight-findings.test.js`** - the rejection proved by injection | **CLOSED - and writing it found the day had already come TWICE.** See below |
| 9 | **AE1-a against a POPULATED WRONG MongoDB** - the emptiness guard cannot see it | **IDENTITY CHECK IN THE OPERATION** (BB1): documents on the other side and NOT ONE shared identifier is refused with `ERR_SOURCE_MISMATCH` | **`null-minted.test.js`** - "a POPULATED WRONG database is REFUSED", by injection against a 5000-document source | **CLOSED for the wrong-database case.** The PARTIAL-overlap case remains and is row 12 |
| 10 | **AE1-a's FALSE refusal** - an entity legitimately all-minted is indistinguishable from the wrong database | `entities` scoping, so an operator can proceed deliberately | the dry-run test exercises the shape | **CLOSED as far as it can be.** The two cases are indistinguishable by construction; refusing is the correct default |
| 11 | **AE3 part 2** - `fallbackCount()` zero across a MANUAL exercise of every migrated route, against a database holding both migrated and post-3.1 records | none | **none, by nature** | **OPEN.** A runbook step, and AY1 already says a runbook step is not a closure claim. See BA4 |

### What the audit found, and what acting on it found

The audit reported four residuals with neither a guard nor a test - rows 6, 7,
8 and 11 - plus row 9's guard being in the wrong place. **Acting on them found
things the audit could not have.**

#### Row 9 -> BB1. The guard protected the test suite, not the cutover

Moved into the operation, and changed from EMPTINESS to IDENTITY: *documents on
the other side, and not one identifier in common, is not the database these rows
came from.* A count cannot see that; sharing identifiers is what "the source"
MEANS. Proved by injection against a 5000-document source - the case the old
guard passed.

It is deliberately **not a threshold**. "Share at least one identifier" is the
weakest possible statement of sameness and needs no number to argue about.

The cutover is why it could not wait: in 4b, production MongoDB IS the oracle,
and there is no `kindledger_legacy` to restore from.

#### Row 8 -> BB4. The flag that was meant to announce the day was mis-set

`finding()` now THROWS when a BLOCKING finding declares `refusedAtLoad: false`
unless it is acknowledged with a reason. **Writing the check found the day had
already arrived, twice:**

- `mixed-case-status` (non-canonicalisable) was blocking with the flag
  false, and that was simply WRONG - MySQL rejects an out-of-set ENUM under
  strict mode, and the finding's own detail text says so. **The flag whose job
  was to notice this discrepancy was itself wrong about it.**
- `strict-sql-mode` is GENUINELY blocking-but-loadable: the loader does not
  throw on a permissive `sql_mode`, it truncates silently. Nothing to override,
  because the remedy is the connection and not the data. Acknowledged.

A note saying "check this on the day" could not have found either, because the
day does not announce itself. The constructor does.

#### Row 6 -> BB2. Pinned, and deliberately not fixed

The per-address limit is separate work, and not trivially safe: **a limit keyed
on an address the attacker supplies is itself a way to lock a real user out of
registering**, which is AV1's shape and needs the same care. What could not wait
was that it was the only residual neither closed nor recorded.

#### The rule that generalises

> **The output of an audit like this is not the closed rows. It is that a
> documented residual with no test is indistinguishable from one nobody has
> thought about - and every row that had to be converted from prose into a check
> turned out to contain something the prose had got wrong.**

Three of the four unpinned rows were not merely unwatched. Row 8's flag was
mis-set, row 9's guard was in the wrong component, and row 7's signal (below)
was larger than the note implied. **The act of writing the check is what found
them**, which is AZ3's countermeasure doing the thing it was adopted for.

---

## BA2 - ADR-059's SHAPE, RECURRING

> **A component whose purpose is to demonstrate the thing being removed cannot
> survive into the evidence that it can be removed.**

ADR-059 said a package removing a dependency cannot remove it from the component
whose job is to stop needing it. This is the same relation, between a control
and its evidence.

The AK3 fixtures exist to assert that the bridge works - that an un-migrated
record still resolves. The bridge's deletion evidence is that nothing uses it.
**Both cannot hold.** So the fixtures go first, and AZ4's steps 2 and 3 swap.

This is the second instance. The difference worth recording is that ADR-059 was
found by reasoning about a plan, and this one was found by a check producing a
number that made no sense. Two routes to the same shape, and only the second is
repeatable.

---

## BA4 - A NUMBER THAT CANNOT DISTINGUISH ITS OWN EXPLANATIONS IS NOT EVIDENCE

AE3's exit check reported **34 fallbacks**. Two readings were available:

1. the bridge is load-bearing, and deleting it breaks authentication;
2. the fixtures manufacture the traffic, and the number is noise.

**Neither was checkable without reading the fixtures**, and the second reading is
the one a tired person picks the day before a cutover. The answer turned out to
be (2) for 32 of the 34 - but the metric could not say so.

**The mechanical half:** `readyToDelete()` counts within ONE PROCESS, and
`node --test` gives each suite its own. The number ADR-050 asked for did not
exist anywhere. It is now `test/bridge-exit-check.js`, a CI gate.

**The conceptual half, which is the one that generalises:**

> **An exit metric must be able to distinguish its own readings. If two
> incompatible explanations produce the same number, it is not an exit criterion
> - it is a prompt to go and read the code, and it will be read in whichever
> direction the schedule prefers.**

Applied to AE3, the fix is not to weight synthetic records but to **remove
them**: a record that cannot exist in production after the ETL has no business
in the evidence at all. That is BA2.


---

## BC1 - A FLAG THAT IS THE SOLE CHECK ON A PROPERTY CAN ONLY AGREE WITH ITSELF

BB4's construction-time guard found **two existing errors on its first run**, not
a future one. That is the strongest case this project has produced for BA3's
rule, because a note cannot find anything - only a check that runs can.

| Finding | What was wrong |
|---|---|
| `mixed-case-status` | BLOCKING with the flag FALSE, **contradicting its own detail text**, which says in words that MySQL will REJECT these rows. The flag whose job was to notice the discrepancy was itself the discrepancy, and nothing could catch that because the flag was the only check |
| `strict-sql-mode` | Genuinely blocking-but-loadable. The loader truncates silently rather than throwing, and there is nothing to override because the remedy is the CONNECTION, not the data. **That is ETL-01's shape reappearing inside the mechanism built to classify ETL-01** |

Two instances of metadata being wrong about the thing it describes.

> **Any flag that is the SOLE check on a property needs a second mechanism
> deriving that property independently, or it can only ever agree with itself.**

The second mechanism here is `test/etl.test.js`, which asserts the refusals by
their SHAPE - a duplicate-key violation, an ENUM rejection - rather than by any
message of ours. It fails if the property stops holding, whatever the flag says.

---

## BD1 - THE FLAG WAS TRUE ABOUT THE SYSTEM AND FALSE ABOUT THE LOADER

`loaderRefuses` is now **`refusedAtLoad`**, and the rename is not tidiness.

**Two of the five refusals come from the SCHEMA, not from `migrate.js`:**

| Finding | What actually refuses it |
|---|---|
| `strict-sql-mode` | **Nothing.** Acknowledged in `BLOCKING_BUT_LOADABLE` |
| `case-variant-emails` | **SCHEMA** - `uq_users_email` under `utf8mb4_0900_as_ci`, which is case-INsensitive, so two accounts differing only in case collapse onto one row |
| `mixed-case-status` | **SCHEMA** - the `ENUM` plus `STRICT_TRANS_TABLES`. Without strict mode MySQL would insert the empty string instead |
| `orphaned-category` | `migrate.js` - an explicit throw |
| `implausible-dates` | `migrate.js` - an explicit throw |

The old name invited exactly the reasoning that produced the original error:
read "loaderRefuses", look in `migrate.js`, find nothing, conclude the flag is
wrong. That is how `mixed-case-status` came to be marked false.

> **A property owned by the schema and named after the loader is invisible to
> anyone changing the schema.**

Relaxing the email collation or dropping `uq_users_email` silently removes a
migration safety property, and **nothing in the ETL would change to show it**.
So the warning now lives in `db/schema.sql`, next to the index, per AI4 - the
warning goes where the mistake gets made, not where it gets noticed.

---

## BD2 - THE OTHER THREE BLOCKING FINDINGS, AUDITED THE SAME WAY

BC2's instruction was not to assume the remaining three were right because the
guard passes, since the guard was written from the same understanding that
produced the errors. Two of the three had **no behavioural citation either** -
only a pre-flight test, so `refusedAtLoad: true` was an assertion about code
nobody had executed.

Both are TRUE. Both are now cited to behaviour:

- **`BC2: CASE-VARIANT EMAILS fail the load - and it is the INDEX that refuses`**
  asserts a duplicate-key refusal (`P2002` / `Duplicate entry`), deliberately
  NOT a message of ours, because there is no message of ours.
- **`BC2: a status in NO casing fails the load - and it is the ENUM that refuses`**
  is the `mixed-case-status` detail text, executed.

`orphaned-category` and `implausible-dates` were already cited by the two
existing "FAILS THE LOAD" tests. ETL suite: 18 of 18.

---

## BD3 - WHY THE 4b MATCH-RATE FLOOR IS 1.0, DERIVED RATHER THAN CHOSEN

The value matters less than the derivation, because the derivation is what tells
a future reader that a 0.98 is **a stop condition and not a tolerance**.

1. A minted `legacy_id` exists because `routes/categories.js` and
   `repositories/users.js` FABRICATED one for a row created through the running
   application, so that a required Mongoose ObjectId ref would resolve.
2. **That code has never been deployed.** Phase 3 runs in development only.
3. Production MySQL is therefore populated by the ETL and by nothing else.
4. Every `legacy_id` in production MySQL came from production MongoDB.
5. **So every one of them must resolve. The expected rate is exactly 1.0.**

It follows that a production rate below 1.0 does not mean "some rows were
minted" - that cannot happen in production. It means one of:

- rows were **deleted from MongoDB after the ETL ran** - which the freeze window
  exists to prevent, so its occurrence means the freeze was not held; or
- **this is not the database the ETL read** - an old snapshot, a staging copy.

Both are reasons to stop. Lowering the floor to make a run succeed converts an
alarm into a permission, and the run it permits destroys migration history
permanently, because after the cutover there is no oracle left to rebuild it.

The floor is checked across every entity **before any write**, and the CLI
requires `--min-match-rate` on every apply run - not only in production, because
a flag first typed on the run that matters is a flag nobody has typed.

---

## BD4 - THE 3.5a TIMING DIFFERENCE, MEASURED

**The note said it was "a far weaker signal than a distinct message". It is not.**

```
BB3 MEASUREMENT (12 samples each, interleaved, medians):
  UNKNOWN address (hashes + writes): 247.5 ms
  KNOWN address   (neither)        :   4.6 ms
  SEPARATION                       : 242.8 ms
  ratio                            :  53.27x
```

And the distributions **do not overlap at all** - the slowest known-address
response is faster than the fastest unknown one - which is the strongest form
the finding can take. **One request classifies an address.** The body is
identical either way, which is what 3.5a closed; the clock is not.

It is not an accident of implementation that a tidy-up removes. The separation
IS bcrypt at cost 12, which SEC-18 deliberately chose to be expensive. Closing
it means constant-time signup, and the obvious cheap fix - defer the hash - is
a different trade-off, not a free one.

Pinned by `test/signup-timing.test.js` on the BB2 model: the test asserts the
separation, so closing it FAILS the test.

### The collection problem, which is its own small finding

The measurement takes **3.6 seconds**. Collecting it took several ten-minute
timeouts, and the cause was not the measurement:

Both `/signup` branches start an SMTP connection that cannot complete in this
environment. `nodemailer` holds those sockets past the end of the test, so under
`node --test` - which runs each file in a child process and drains its pipe -
the run presents as a hang long after the numbers exist. Same class as the Redis
`unref` finding: **a held socket presenting as a hang, whose natural fix is a
force-exit flag.**

The suite now runs the file DIRECTLY rather than under `node --test`, and forces
exit after cleanup.

> **THAT IS CORRECT FOR A MEASUREMENT HARNESS AND IS NOT A PATTERN FOR THE
> APPLICATION SUITES.** In those, a process that will not exit is EVIDENCE - of
> a connection never closed, a timer never cleared, a listener never removed.
> Forcing exit there would delete the signal rather than the delay. This suite
> is exempt because it deliberately drives a path whose side effect cannot
> complete, and it exists to produce one number.


---

## BE2 - THE COMPOSITION CLASS: TWO CORRECT CONTROLS, ONE VULNERABILITY

Every class catalogued so far is a control that is **wrong** - missing, mis-set,
validated where nothing is at stake, depending on a human, agreeing with itself.
This one is different, and the difference is the point:

> **Two independently correct controls producing a vulnerability by interaction.
> Neither is wrong. Neither can be fixed by making it more correct.**

- **SEC-18** made bcrypt cost 12 on purpose. The cost factor is the control; a
  cheap hash would be the defect.
- **SEC-08** made the responses identical on purpose. Package 3.5a spent a whole
  package closing the last body-shaped oracle.

**The oracle lives in the gap between them.** SEC-08 equalised what the endpoint
SAYS. SEC-18 guaranteed that one branch would take 240 ms longer to say it.
Reviewing either control on its own finds nothing, because neither is defective.

### Why nothing in this process was looking for it

**The map tracks findings individually.** Every row is one finding, with its own
owner, its own package and its own test. That structure is what has made the
work tractable, and it has no representation for *"these two rows interact"*.

- AR6's inherited-claim gate reads claims one at a time.
- BB4's invariant checks one finding's flags against itself.
- The `readyToDelete` / exit-check machinery measures one property.
- A code review of `repositories/users.js` sees a correct cost factor. A review
  of `routes/auth.js` sees correct identical responses.

**No single-finding review could have caught this**, and the only reason it was
caught at all is that BB3 measured a residual instead of restating it. The
measurement was commissioned to decide whether a note was signal or noise; what
it actually found was an interaction nobody had a place to write down.

### The countermeasure, which is weaker than the others and should be admitted as such

There is no gate for this. What there is:

1. **When a control is deliberately EXPENSIVE, ask what else observes its cost.**
   Cost is an output. bcrypt's expense is visible to anyone who can time a
   request, and "identical responses" does not cover it.
2. **When a finding is closed by making two paths identical, name the dimension.**
   3.5a closed SEC-08 *in the body*. Writing "in the body" would have left the
   clock visibly unclosed rather than implicitly so.
3. **Measure residuals rather than characterising them** (BB3). The prose said
   "a far weaker signal than a distinct message". It is a 52x signal with no
   overlap between the distributions. Characterisation was the error.

---

## BE1 - THE SAME SHAPE, EVERYWHERE IT OCCURS

Enumerated rather than checked nearby (AY2). **Every endpoint that performs real
cryptographic work in one branch and returns early in its sibling.**

### Measured - bcrypt-sized, all three with NON-OVERLAPPING distributions

| Endpoint | Expensive branch | Early-returning sibling | Separation | What it reveals |
|---|---|---|---|---|
| `POST /signup` | unknown address -> `bcrypt.hash` + write | known address -> neither | **237.7 ms (51.9x)** | account existence |
| `POST /login` | pending signup OR registered user -> `bcrypt.compare` | **neither exists -> refused before any bcrypt** | **236.0 ms (60.0x)** | account existence, on the canonical enumeration endpoint |
| `POST /signup/verify-otp` | pending row -> `bcrypt.compare` | no pending row -> `false`, no bcrypt | **240.7 ms** | whether a signup is IN FLIGHT for an address |

**`/login` is the worst of the three and was not the one noticed.** `/signup`
was measured first only because BA3's audit happened to carry a note about it.
Its three-way structure - pending signup, registered user, neither - means an
unknown address is refused before any hashing at all.

**`/signup/verify-otp` contradicts its own comment.** The comment AX1 left says
the password requirement "adds no oracle: a caller cannot learn whether the
address has a signup in flight". That is TRUE OF THE BODY AND FALSE OF THE
CLOCK. Another confident sentence written next to code, in the class AJ3 named.

### Enumerated, same shape, NOT yet measured - stated rather than assumed

| Endpoint | Shape | Expected size |
|---|---|---|
| `POST /signup/resend-otp` | `pendingSignups.verifyPassword` - identical structure to `/signup/verify-otp` | bcrypt-sized. Almost certainly the same ~240 ms |
| `POST /forgot-password/request` | known+active -> sha256 + one UPDATE + mail dispatch; unknown -> nothing | **small** - milliseconds, not hundreds. Real but far below the bcrypt cases |
| `POST /login/resend-otp` | same shape as above | small |

### Checked and found NOT to have it - reported because "nothing" is an answer

| Endpoint | Why not |
|---|---|
| `POST /login/verify-otp` | `verifyLoginOtp` is **sha256**, microseconds. The branch exists; the cost does not |
| `POST /forgot-password/verify`, `POST /forgot-password/reset` | `verifyResetCode` is sha256, same reason |
| `POST /change-password` | behind `authMiddleware` - the caller already IS the account, so there is nothing to enumerate |
| `GET /me`, every donation and payment route | no password-shaped comparison on a branch |

**So: four bcrypt-sized oracles, not one**, three of them measured and the
fourth structurally identical to one that was.

---

## BE4 - `git add -A` HAS NOW TWICE COMMITTED SOMETHING UNINTENDED

An unexplained edit was sitting in the working tree - the README's title
demoted from `#` to `##` - and `git add -A` swept it into a commit about the
pre-flight invariant. Reverted in a separate commit; Gary did not make the
change knowingly.

It is a hygiene point rather than a finding, and it is recorded because it is
the SECOND time in this project. The pattern is that `-A` stages whatever is
there, and "whatever is there" is not always mine - an editor's autoformat, a
stray keystroke, a tool writing a file.

> **Review `git status` before staging, or stage by path. A commit message that
> describes one change while the commit contains two is a small lie that a
> future bisect believes.**


---

## BG1 - THE THREE ORACLES, CLOSED AND RE-MEASURED

| Endpoint | Before | After | Change |
|---|---|---|---|
| `POST /signup` | 237.7 ms, 51.9x, **no overlap** | **13.0 ms, 1.06x** | equalised |
| `POST /login` | 236.0 ms, 60.0x, **no overlap** | **3.6 ms, 1.02x** | equalised |
| `POST /signup/verify-otp` | 240.7 ms, **no overlap** | **9.3 ms** | equalised |

`config/passwordTiming.js` holds the equaliser. The branch with no row to check
spends a bcrypt against a throwaway hash and discards the result.

**The dummy hash is GENERATED at load from `BCRYPT_COST`, not hardcoded**, and
`BCRYPT_COST` now has one definition that both repositories import. A literal
`$2a$12$...` would be a second place encoding the cost, and when SEC-18 next
revisits it the dummy would drift away from the real work - turning a full
equalisation into a partial one by an amount nobody chose.

### The residual, which is the database write and is deliberately NOT equalised

The remaining 3-13 ms is the row each unknown-address branch WRITES and the
known branch does not. Equalising it means performing a dummy database write on
behalf of an address that does not exist, which hands an unauthenticated caller
unbounded writes - **a worse problem than the one it closes**. Asserted as small
rather than claimed to be zero.

### THE FIX I GOT WRONG, WHICH ONLY RE-MEASUREMENT FOUND

`/signup/verify-otp` leaks whether a signup is in flight. The comment pointed at
`pendingSignups.verifyPassword`, I equalised that function, and **the separation
did not move at all - still 234.1 ms.**

The route returns at `if (!pending) return refuse(...)` **before that function is
ever called.** I was looking at the right endpoint, for the right reason, with
the right fix, and fixed a line the request never reaches.

> **Inspection said fixed. The measurement said 234.1 ms.** That is the entire
> argument for re-measurement as the acceptance criterion, demonstrated by the
> work rather than asserted about it - and it is the second time in this package
> that measuring corrected something reading had settled.

### And an error in my own enumeration, corrected the same way

I recorded `/signup/resend-otp` as "structurally identical to
`/signup/verify-otp`, bcrypt-sized", from a grep hit on
`pendingSignups.verifyPassword` **that is actually inside `/login`**. That
endpoint does not call it at all - it calls `setOtp`, which is sha256.

So Class A is THREE endpoints, not four. The enumeration was right to exist and
wrong in a detail, and the detail was caught by measuring the endpoint instead
of trusting the row.

---

## BG2 - THE MITIGATION'S DEPENDENCY, ASSERTED

> **The dummy-bcrypt mitigation is safe only while `authLimiter` is wired and
> effective on `/signup`, `/login` and `/signup/verify-otp`.**

BG1 converts an information leak into a CPU cost: a request refused in 4 ms now
costs ~240 ms, and an unauthenticated caller can force it. `authLimiter` at 5
per minute per IP is the only bound. **Unlimited, each of those endpoints is a
60x CPU amplifier.**

That bound is a control which has already failed once here - SEC-04 was a
limiter built, not wired, and reported closed while it was not. A mitigation
resting on it cannot rest on a comment.

`test/password-timing.test.js` asserts it **behaviourally**, not structurally:
it bursts requests from one address until refused. "A limiter is in the chain"
and "the endpoint is limited" are different claims, and a limiter keyed on
something an attacker varies would satisfy the first and not the second. It also
asserts that `burnEquivalentBcrypt` still costs a real bcrypt - if somebody stubs
it out, every oracle reopens and the timing tests would still pass, because they
compare two branches that would both have become fast.

---

## BG3 - THE sha256-SCALE ENDPOINTS: MEASURED, AND CLOSED AS ACCEPTED

"Real but small" with no number was BB3's original state, so each got one.

| Endpoint | Working branch | Idle branch | Separation |
|---|---|---|---|
| `POST /signup/resend-otp` | 7.81 ms | 2.62 ms | **5.2-5.4 ms** |
| `POST /login/resend-otp` | 9.74 ms | 2.63 ms | **6.2-7.1 ms** |
| `POST /forgot-password/request` | 9.15 ms | 2.81 ms | **6.2-6.5 ms** |

All three are one sha256 plus one UPDATE - the same work, and the numbers agree.

**The "distributions overlap" verdict is NOT a reliable discriminator, and
saying so is part of the finding.** Across runs it flipped for
`/signup/resend-otp` on the strength of one or two outliers in the idle branch.
The stable quantity is the separation: **5-7 ms, everywhere.**

### The decision: ACCEPTED, not equalised

- **5-7 ms is not a single-request oracle across a network.** Internet jitter is
  tens of milliseconds; one request decides nothing. Recovering the signal needs
  many samples per address, through a limiter of 5 per minute per IP.
- **The fix would be worse than the finding.** These branches differ by a
  database WRITE, not a hash. Equalising means writing a row for an address that
  does not exist - unbounded writes from unauthenticated callers.
- It is **pinned anyway**: each test asserts the separation stays under 50 ms,
  which is what fails if somebody moves a password hash onto one of these paths.

This is the first row in the audit closed by MEASURING IT AND ACCEPTING IT
rather than by fixing it, and the number is what makes that a decision instead
of a shrug.

---

## BG4 - A CLAIM THAT SOMETHING "ADDS NO ORACLE" MUST NAME ITS CHANNELS

`/signup/verify-otp` carried, in this project, written by me:

> "ANSWERS 'Invalid OTP' like every other failure here, **so it adds no oracle**:
> a caller cannot learn whether the address has a signup in flight, nor whether
> their password guess was right."

**True of the body. False of the clock.** 240.7 ms of separation, and the
distributions did not overlap - one request answered the exact question the
sentence says cannot be answered.

### Against AZ3: proximity in TIME is no better than proximity in the FILE

AZ3 found correct reasoning failing to travel three functions. BA3 found it
failing to travel three lines, same author, same session. **This is shorter
still: the author knew the timing class and wrote a claim the class contradicts.**

There is no distance left to shorten. Nearness - in the file, in the session, in
the author's own attention - does not propagate anything. Only a check does.

### The countermeasure is AU2's, and the citation rule gains a clause

The comment asserted a closure and **cited nothing**. Under AU2 it was already
defective before it was wrong.

> **A claim that something "adds no oracle" must name which CHANNELS were
> checked. Body, status and timing are separate channels, and a claim covering
> one is not a claim covering the others.**

Applied: the comment now reads "adds no oracle IN THE BODY OR THE STATUS", and
the timing channel is closed by code with a test rather than by a sentence. The
same clause applies to the SEC-08 closures generally - 3.5a closed SEC-08 *in the
body*, and writing those three words at the time would have left the clock
visibly open instead of implicitly so (BE2).


---

## BH5 - A MISSING ENVIRONMENT VARIABLE SILENTLY DISABLES SEC-01

### (a) The diagnosis was wrong and the consequence was worse

The symptom was that `docker compose` warns about a dozen blank variables. The
supposed cause - compose not finding the env file - is **not what is happening**.
`.env` is found; it holds ten keys; the warned variables **are simply not in it**.
`--env-file` would change nothing.

That matters because the fix is different, and because one of the absent
variables is `PAYU_MERCHANT_SALT`.

> **`docker-compose.yml` declares `PAYU_MERCHANT_SALT` as a bare `${VAR}` - no
> default, no `:?` - and it is absent from `.env`. So a plain `docker compose up`
> produces a stack that reports HEALTHY while `verifyHash` computes
> `sha512("undefined|success|...")`, which anybody can compute too.**

Every callback endpoint would accept a forged "payment succeeded" and mark a
donation PAID. Nothing looks wrong in the logs, because from the code's point of
view nothing IS wrong: it verified a hash, and the hash matched.

**This is not a weaker check. It is a public one.**

### The sixth AY2 adjacency, and the control was in the same directory

`config/jwt.js` refuses to load at all without a 32-character `JWT_SECRET`.
`config/payu.js`, sitting beside it, read an equally load-bearing secret into
`undefined` and said nothing.

### The fix refuses at the SECURITY DECISION, not at boot

`assertSigningConfigured()` throws inside `generateHash` and `verifyHash`. A
require-time throw like jwt.js's would stop the application starting for work
that never touches payments - including the harnesses that boot the app to
measure auth timing - and that creates pressure to invent a dummy salt, which is
how a guard becomes a formality. `docker-compose.yml` keeps `${VAR}` with the
reasoning written next to it.

### And a threshold I invented rejected a legitimate value immediately

My first version required 16+ characters for BOTH the salt and the key. It
rejected `TESTMERCHANTKEY` - fifteen - and failed sixteen tests on first run.

**The merchant KEY is an identifier, not a secret.** It travels in the payment
form, the customer's browser sees it, and PayU's own test key is `gtKFFx`.
Requiring length of it is a category error.

That is BB1's argument - "a threshold is a number you choose and then have to
relax" - which I had written three steps earlier and then did not apply.

### (b) `.env.example` - checked, and CLEAN

Reported because nothing is an answer. Every secret is blank
(`MYSQL_ROOT_PASSWORD=`, `MYSQL_PASSWORD=`, `JWT_SECRET=`, `ADMIN_CREATION_KEY=`,
`PAYU_MERCHANT_SALT=`, `EMAIL_PASSWORD=`, `HEALTH_DIAGNOSTIC_SECRET=`), and
`DATABASE_URL` carries a visible `CHANGEME` rather than a working password. A
self-hoster copying it inherits nothing usable.

**For Phase 6's publication gate:** the local `.env` holds `klpass` / `rootpw`.
Those are fine locally and must never become defaults anywhere - the gate should
assert that no tracked file contains a non-empty credential value, rather than
relying on `.env.example` continuing to be written carefully.


---

## ENV-01 (HIGH) - A BARE `${VAR}` MADE SEC-01 A PUBLIC CHECK

**Severity: HIGH. Fails OPEN, and fails SILENTLY.**

`docker-compose.yml` declared `PAYU_MERCHANT_SALT` as a bare `${VAR}` - no
default, no `:?` - and it is absent from `.env`. A plain `docker compose up`
therefore started a stack reporting four healthy services in which

    verifyHash -> sha512("undefined|success|||...")

is a value **anyone can compute**. Every forged "payment succeeded" callback is
accepted and the donation marked Paid.

**The logs show a hash verified and matched**, because one was. There is no
error, no warning, and no symptom until somebody reconciles against the bank.

### This is the self-hosting story for the whole project

An NGO clones the repository, copies the compose file, misses one variable, and
accepts forged payments with nothing in the logs to show it. That is not a
misconfiguration they could reasonably detect - it is the system working exactly
as written.

**Fixed** by `config/payu.js assertSigningConfigured()`, which refuses at the
point the secret is USED rather than at boot. Proved by outcome: a callback
forged with a blank salt leaves the donation `Pending`
(`payment-callbacks.test.js`, and the forging helper is parameterised so the
seventeen SEC-01 tests prove its formula).

### THE RULE, FOR PHASE 6

> **No security-critical variable may be declared as a bare `${VAR}`. Either
> `:?` so compose refuses to start, or a runtime guard at the decision point.**

### Every variable in `docker-compose.yml`, audited on that basis

| Variable | Declared | Security-critical? | Behaviour when absent |
|---|---|---|---|
| `PAYU_MERCHANT_SALT` | bare | **YES - the signing secret** | was FAIL-OPEN; now refused at `verifyHash`/`generateHash` |
| `PAYU_MERCHANT_KEY` | bare | yes, as an identifier | now refused for absence (not length - see BJ2) |
| `JWT_SECRET` | `:?` | **YES** | compose refuses; `config/jwt.js` also throws |
| `ADMIN_CREATION_KEY` | `:?` | **YES** | compose refuses |
| `DATABASE_URL` | `:?` | yes | compose refuses |
| `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | `:?` | yes | compose refuses (the bare second occurrence is the healthcheck, covered by the same value) |
| `ALLOWED_ORIGINS` | bare | **yes - CORS** | **FAILS CLOSED, checked.** Empty list, so every cross-origin request is rejected. Correct direction, and worth having confirmed rather than assumed |
| `HEALTH_DIAGNOSTIC_SECRET` | `:-` empty | yes | the diagnostic form is unavailable - fails closed |
| `EMAIL_PASSWORD`, `EMAIL_USER`, `SMTP_HOST`, `EMAIL_SERVICE` | bare | no, but delivery-critical | mail fails with EAUTH; OTP and reset codes are not delivered. Fails closed, loudly in logs, and the endpoints are fire-and-forget so no oracle |
| `SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL`, `FRONTEND_*_URL` | bare | no | PayU redirects nowhere; the flow breaks visibly |
| `JOB_*`, `SCHEDULER_ENABLED` | `:-false` | yes, DESTRUCTIVE | default OFF (AT1) - the right direction |
| `MONGODB_URI` | `:-` empty | no | request-path Mongoose is removed in this package |
| `NODE_ENV`, `REDIS_URL`, `PORT`, `RATE_LIMIT_PREFIX`, `PRISMA_CONNECTION_LIMIT`, `SMTP_PORT/SECURE`, `PAYU_BASE_URL`, `MYSQL_USER/DATABASE`, `HTTP(S)_PORT` | `:-` | no | sensible defaults |

**One fail-open security-critical variable, and it was the payment one.**

---

## BJ2 - A THRESHOLD I INVENTED, THREE STEPS AFTER ARGUING AGAINST ONE

BB1 chose "share at least one identifier" over a match-rate threshold, with the
reason written down: *a threshold has to be chosen, argued about and eventually
relaxed.*

Three steps later I required **16+ characters for the PayU merchant key**. PayU
ships `gtKFFx`. The suite's `TESTMERCHANTKEY` is fifteen, and sixteen tests
failed on the first run.

### It was also the wrong CONTROL, not merely the wrong number

The two values need different properties, and conflating them is the actual
error:

| Value | What it is | What it needs | Guard |
|---|---|---|---|
| `PAYU_MERCHANT_SALT` | a SECRET - never leaves the server, and the only thing making a callback unforgeable | **entropy** | present, and long enough not to be `test` / `salt` / `changeme` |
| `PAYU_MERCHANT_KEY` | an IDENTIFIER - travels in the payment form, the customer's browser sees it | **correctness** - it must be the right merchant | present. Length says nothing about it, and PayU's own is six characters |

A length floor on an identifier is not a weak control. It is a control for a
property that value does not have.

### Against the AZ3 tally

AZ3 was three functions. BA3 was three lines, same session. BG4 was zero
distance - the author knew the class. **This is the next step along: reasoning
failing to reach the author's own NEXT DECISION.**

There is nothing left to shorten, and the countermeasure has not changed because
no other one has worked: **enumerate and state at the point of change.** Writing
"what property does this value need?" before writing the check would have caught
it; writing it afterwards did.

---

## BJ4 - "NO TRACKED FILE CARRIES A WORKING CREDENTIAL", AS A CHECK

`.env.example` being clean is one file staying well-written. The control is
`test/no-committed-secrets.test.js`, in CI, which reads what git tracks.

**Scope**: env templates, compose files, application source, schema, workflows -
everything a self-hoster deploys. `Backend/test/` is excluded **with a property
rather than by a blanket skip**: its fixtures are credentials for nothing.

It proves itself three ways, because a scan is the easiest thing in the world to
write vacuously:

1. It fires on a planted `JWT_SECRET=...` (injection, AV2).
2. It does NOT fire on `<placeholder>`, `${REFERENCE}`, `CHANGEME` or the
   `ci-only-*` values the workflows use for a database that lives ninety seconds.
3. **It asserts it actually matched files.** A scope pattern that silently stops
   matching would report a clean sweep over nothing - the BH3 shape, applied to
   the check itself.

Current result: **clean.** The `ci-only-*` workflow values are deliberate and
named as such; pushing them into repository settings would make them harder to
read and no safer.

### And a second env template nobody had looked at

`Backend/.env.example` exists alongside the root one. It carries no live
credentials - every secret is a `<placeholder>` - but it is **stale and
actively misleading**: it documents `MONGODB_URI` as the datastore and contains
no `DATABASE_URL` and no MySQL variables at all.

Two files claim to be the environment template and disagree, and the one a
self-hoster might follow points at the store this project has spent six packages
leaving. It is removed with the request-path Mongoose in this package.

I found it only because BJ4's scan enumerated tracked files. Checking "the
`.env.example`" by name would not have - AY2 again.


---

## BH3 - THE VACUITY SWEEP: three instances, and the third was in the deletion gate

> **A test that can pass while its subject is removed is not a test. It is a
> comment with a green tick.**

Two instances were known before the sweep: PAY-02 (a removal verified by
reference-counting when runtime registration was the property) and BH5's forged
callback (signed with the real salt against an endpoint using a blank one, so it
would have been refused for a HASH MISMATCH and passed while proving nothing).

The sweep looked for two signatures across all twenty suites.

### Signature 1 - a refusal assertion that accepts ANY error

**One instance, and it was mine.** `null-minted.test.js`'s "the refusal writes
NOTHING" used `assert.rejects(fn)` with no matcher. The test's point is the
write-nothing assertions that follow - and those would hold just as well if the
call had rejected because of a typo in the options object. Now asserts
`ERR_SOURCE_EMPTY`.

Everything else already asserted a code or a message. `destructive-jobs.test.js`
is the model: specific codes, a positive control that the purge DOES run with
both gates open, and a test that discriminates WHICH gate refused.

### Signature 2 - a scan that reports clean because it scanned nothing

**One instance, in the worst possible place: `bridge-exit-check.js`**, the gate
that authorises deleting the bridges. A renamed directory or a changed suffix
would empty the suite list, skip every loop body, find no offender, and print
"AE3 PART 1 PASSES" on zero evidence.

`migration-state.test.js` **already had this property** - *"CONTROL FAILED:
nothing imports models/X, so the scan finds nothing"* - and the exit check did
not. The control existed one suite away. **AY2, seventh instance.**

Both now assert they matched files, and name three suites explicitly, because a
count alone would not notice one file dropping out of the pattern.

### The countermeasure BH2 asks for

> **An acceptance criterion measures the OUTCOME, never the presence of the
> change.** "The guard is called" is not a finding; "the forged callback is
> refused" is. This is already how the timing work was accepted and is now
> standard for every fix.

---

## BH3b - AND THE SWEEP FOUND A THIRD BY DOING THE DAMAGE AGAIN

While re-running `null-minted.test.js` after tightening it, **the suite NULLed
the two restored category `legacy_id`s a second time.**

The first damage came from pointing the suite at a scratch MongoDB, and was
closed by `assertSourceMatchesMySQL()`, which checks the REAL MongoDB before any
write. **That guard cannot see this one.** BB1's tests pass a STUBBED `Category`
whose `find` returned a fixed list, so every row the suite did not create looked
absent from MongoDB and was nulled - through the one path where the real
database is never consulted.

> **A guard on the real dependency does nothing about a stub that lies about it.
> As far as the code under test is concerned, THE STUB IS THE DEPENDENCY.**

`sourceWith()` now resolves every id the suite did not create against the real
collection, and invents an answer only for its own fixtures - so each test
controls exactly the variable it is about. A regression test asserts the
property directly.

**That regression test is currently vacuous, and saying so is the point.** It
iterates the rows the suite did not create, and those rows now have NULL
`legacy_id` because this suite nulled them. It becomes live the moment they are
restored - which is the third thing the sweep is about: a test whose fixture is
absent proves nothing, quietly.


---

## BH1 - THE RETROACTIVE CHANNELS AUDIT

BG4's clause applied backwards to every SEC-08 closure. Five channels: **body,
status, timing, response size, error-path ordering.**

| Endpoint | Body | Status | Timing | Size | Ordering |
|---|---|---|---|---|---|
| `POST /signup` | closed 3.5a | closed | **was 237.7 ms - closed BG1** | clean* | clean |
| `POST /login` | closed | closed | **was 236.0 ms - closed BG1** | clean | clean |
| `POST /signup/verify-otp` | closed | closed | **was 240.7 ms - closed BG1** | clean | clean |
| `POST /signup/resend-otp` | closed | closed | **5.2 ms - accepted BG3** | clean | clean |
| `POST /login/resend-otp` | closed | closed | **6.2 ms - accepted BG3** | clean | clean |
| `POST /forgot-password/request` | closed | closed | **6.3 ms - accepted BG3** | clean | clean |

\* `/signup` returns 140 bytes for a known address and 137 for an unknown one.
The difference is the submitted address echoed back - a value the CALLER chose -
so it carries nothing the caller did not already know. Compared with the echo
normalised rather than raw, and the reason is in the test.

### The answer to "expect more than one"

**Only timing was channel-partial.** Response size and error-path ordering are
clean on all six, including the malformed-request case where a missing password
is rejected before the account lookup on both branches.

That is a NEGATIVE result from a rule applied systematically, and it is worth
more than the same conclusion by inspection: SEC-08 was marked closed while
/login was measurable at 60x, so inspection had already been wrong here once.

---

## BH2 - PRESENCE IS NOT APPLICATION

> **A fix can be correct, in the right file, for the right reason, and still not
> execute.**

| Instance | Verified by | The property that actually mattered |
|---|---|---|
| **PAY-02** | reference-counting an import | runtime model registration |
| **BG1 / `/signup/verify-otp`** | the fix being present in `verifyPassword` | whether the request REACHES it - the route returns at `if (!pending)` first |

Both times the change was right and inert. Both times **only measurement caught
it**; in the second, inspection had already reported success.

### The countermeasure

> **An acceptance criterion measures the OUTCOME, never the presence of the
> change.** Not "the guard is called" but "the forged callback is refused". Not
> "the import is gone" but "the model is not registered at boot". Not "the
> equaliser is in the branch" but "the two branches now take the same time".

This is standard for every fix from here, not only timing ones. It is already
how BH5's guard was accepted - the assertion is that a forged callback leaves
the donation `Pending`, not that `assertSigningConfigured` appears in the file.


---

## PACKAGE 3.6 - THE REQUEST PATH LEAVES MONGODB

Run in BA2's corrected order: the AK3 coupling first, then the evidence, then
the deletions.

### AE3, both parts

**Part 1 PASSES.** Eighteen suites green in one run, **zero MongoDB fallbacks**,
via `test/bridge-exit-check.js`. Two suites are named as run elsewhere rather
than skipped: `trust-proxy` (host, through nginx) and `no-committed-secrets`
(needs `git`, absent from the api image).

**Part 2 is satisfied for users and donations and DEGRADED for categories.**
The shared database holds one ETL-migrated user and five migrated donations
carrying real `legacy_id`s, exercised by every route suite. The two migrated
categories have NULL `legacy_id` **because this project's own test suite nulled
them twice** (BH3b) and they await restoration. Stated rather than glossed: the
category half of part 2 rests on fixtures, not on ETL-produced rows.

### What was deleted, and what each consumer became

| Deleted | Consumer | Now |
|---|---|---|
| `services/legacyBridge.js` | `idShape` in donations + payment | `utils/idShape.js` - never bridge logic, and a helper living in a file named after a temporary mechanism is how the mechanism outlives its purpose |
| `services/categoryBridge.js` | `countCategories` in admin | `repositories/categories.countActive()` - it never consulted MongoDB, it delegated straight to that file |
| `services/userBridge.js` | `resolveAuthUser` in both middlewares | `repositories/users.resolveForAuth()` - **MySQL only** |
| `test/category-bridge.test.js` | - | gone with its subject |
| `config/db.js` + `connectDB()` | `app.js` | nothing. The request path opens no Mongoose connection |
| `Backend/.env.example` | - | the root template is authoritative (BK2) |

### The behaviour change, stated as one

> **An account that exists only in MongoDB can no longer hold a session.**

The bridge used to resolve it and log `[AUTH-DECISION-FROM-MONGO]`. That is safe
only because the ETL has run, so **the ETL is the thing standing between a real
donor and a locked account** - ADR-056's constraint, and the reason AE3 demanded
evidence before this deletion rather than after.

### The coupling the suites had, made visible

Seven suites asserted `mongoose.connection.readyState === 1` after importing
`app.js` - they were relying on the APPLICATION to open a MongoDB connection as
a side effect of being imported, for their OWN fixtures. Each now connects for
itself.

That dependency was invisible while it was satisfied. Removing `connectDB()` is
what surfaced it, which is BA2 once more: a component's job ending does not
remove what quietly depended on it.

### ADR-047, first half only

`MONGODB_URI` is out of the api service. **The `mongo` service stays** - 4b
restores a production snapshot into it to rehearse the cutover, and the ETL and
AK3 fixtures still read it. AZ2 found ADR-047 wrong precisely here.

### Acceptance, measured

- `docker compose up` with **no override**: four services, api **healthy**
- `GET /api/health` -> `200 {"status":"ok"}`, `GET /api/categories` -> `200`
  with real rows, both through nginx
- `mongoose.modelNames()` after importing `app.js`: **`[]`**

The last one is the boot-registration gate's property proved directly rather
than asserted. **The gate itself STAYS** - BH4 asked for it to go with the
request path, and ADR-059 says it cannot: it is the evidence for this package's
work, and it goes with `models/` in 4c.


---

## U-6 CLOSED - and the bump everyone had queued would NOT have fixed it

Three **HIGH** advisories: `deepmerge-ts < 8.0.0` (stack exhaustion on recursive
object graphs), reaching the tree through `prisma -> @prisma/config`.

### Two things the obvious fix gets wrong

**1. It is in the PRODUCTION tree, though the declaration says otherwise.**
`package.json` lists `prisma` under `devDependencies`. The tree says:

    @prisma/client@6.19.3  (a PRODUCTION dependency)
      -> prisma@6.19.3
        -> @prisma/config@6.19.3
          -> deepmerge-ts@7.1.5

`npm audit --omit=dev` reports all three. U-6 recorded this discrepancy and it
still holds: **the declaration is not the tree**, and only running `npm ls`
distinguishes them.

**2. UPGRADING PRISMA WOULD NOT HAVE FIXED IT.** The advisory's vulnerable range
for `prisma` is `6.13.0-dev.1 - 8.1.0-dev.4` - **which includes all of v7.** The
queued "bump Prisma" task, performed as written, would have moved 6.19.3 to
7.10.0, changed a major version of the data layer, and left three HIGH
advisories in place while looking like remediation.

`npm audit fix` proposes `prisma@8.0.0-rc.15` - a release candidate, which is
not a thing to put under a payment system.

### What was actually done

An `overrides` entry pinning `deepmerge-ts@^8.0.0`. The vulnerability is in
`deepmerge-ts`; the fix is in `deepmerge-ts@8`; nothing else needs to move.

    npm audit  ->  found 0 vulnerabilities
    deepmerge-ts@8.0.2 resolved under @prisma/config@6.19.3

Verified by OUTCOME (BH2), not by the version string: `npx prisma generate` runs
inside the container, and `data-layer` + `schema` pass 57/57 against the real
database. An override that silently broke the client would show there.

> **An advisory names a vulnerable PACKAGE and a vulnerable RANGE. "Upgrade the
> thing that depends on it" is not the same fix, and here it would have changed
> a major version and closed nothing.**


---

## BN1 - A GUARD ON A REAL DEPENDENCY IS VOID WHEN A STUB ANSWERS FOR IT

> **The guard was correct, and it never ran.**

`assertSourceMatchesMySQL()` consults the real MongoDB before `null-minted`
writes anything. BB1's tests passed a STUBBED `Category` whose `find` returned a
fixed list - so inside those tests the stub WAS the database, the guard's
subject was never consulted, and every row the suite did not create looked
absent and was nulled.

**Second time a control was bypassed rather than wrong.** PAY-02's import check
was correct and measured the wrong property; this guard is correct and was not
in the path. Both are AV2/BH2: *the property verified was not the property that
mattered.*

### Added to the standing rules

> **Any test that stubs a datastore a guard consults must either resolve against
> the real store, or assert that the guard was reached.**

`sourceWith()` now resolves foreign ids against the real collection and invents
answers only for its own fixtures. The two `countDocuments: 0` stubs go further
and **throw from `find()`** - if the emptiness guard ever stops refusing first,
that says so loudly instead of silently reporting every row as minted.

### THE ONE PLACE THE RULE IS BROKEN ON PURPOSE

Test 7 needs a source that resolves NOTHING, which a truthful stub cannot
produce once the database holds real migrated rows. Those two needs are in
genuine tension, and the resolution is to separate them rather than weaken the
truthful one:

- the lying stub lives in that test alone;
- its safety argument is **specific** - that run must REFUSE BEFORE WRITING, and
  that is the property under test;
- and the test asserts the foreign rows survived, so a lying stub cannot destroy
  one without the test reporting it.

### The audit BN1 asked for

| Suite | Verdict |
|---|---|
| `null-minted.test.js` | **the only suite that fabricates a datastore.** All four stubs accounted for above |
| `etl.test.js` | passes the REAL Mongoose models (`{ User, Category, Donation, PendingSignup }`). No bypass |
| `categories-characterisation.test.js` | same - real models handed to the real ETL |
| `data-layer.test.js` | inspects `require.cache` to assert Mongoose is not loaded. A read, not a stub |
| every other suite | no fakes. There is no mocking library in this project at all |

**One instance, already fixed.** Reported as a "nothing" answer for the rest,
because an audit that lists only hits cannot be told from one that stopped early.

---

## A LOCAL DATABASE DOCUMENTED AS EPHEMERAL WAS USED AS A SOURCE OF TRUTH

`docker-compose.legacy-mongo.yml` says of the `mongo` service:

> "No volume, deliberately. State that survives a restart would start looking
> like a development database people rely on."

**It started looking like one anyway.** Package 3.6 treated `kindledger_legacy`
as AE1-a's oracle, and `null-minted.test.js`'s guard consults it before deciding
what to destroy. A `docker compose down` then removed the container and every
document in it, exactly as the comment promised.

The consequence is the finding AE1-a is *about*, demonstrated on the development
stack: **the restored legacy_id values pointed at nothing, so minted and genuine
became locally indistinguishable.** The only reason the restored ids survived
the next test run is that the guard refused.

> **A comment saying a thing is ephemeral does not stop people depending on it.
> A cheap way to rebuild it does.**

`scripts/rebuildLegacyMongo.js` reconstructs the collection from MySQL's own
legacy_id values - the ids are what the oracle needs, and every consumer asks
only whether a document with that id EXISTS. Idempotent, never updates an
existing document, refuses a non-local target, and writes a deliberately
unusable password hash so the fixture can never authenticate anyone.

It restores the oracle and AE3 part 2. It does not restore the original
documents, and nothing needs them.

---

## BN3 - THE QUEUED FIX WAS ITSELF AN INHERITED CLAIM

U-6's instruction was "bump Prisma". It assumed **a bump fixes an advisory**,
without checking the vulnerable range - and the range covers all of v7, so the
bump would have changed a major version of the data layer and closed nothing
while looking like remediation.

Correct-looking, repeated, load-bearing: the signature holds. The generator is
not the age of the claim or who wrote it - it is a confident sentence written
near a decision, and this one was in the work order itself.

> **An advisory names a vulnerable PACKAGE and a vulnerable RANGE. "Upgrade the
> thing that depends on it" is a different claim and needs its own check.**

---

## BN4 - WHAT A NEGATIVE RESULT IS WORTH

BH1 checked five channels across six endpoints and found **only timing**
partial. Thirty of thirty-five cells clean.

That is evidence, and the same conclusion reached by inspection would not have
been - **inspection had already marked SEC-08 closed while /login measured 60x.**
The value is not in the cells that were clean; it is that the rule was applied
to all of them by something other than judgement about where to look.

The same holds for BJ1's compose audit: 35 of 36 variables correct, and the one
that was not was the payment secret.


---

## BO2 - THE STRONGEST AZ3 EVIDENCE YET: THE WARNING PREDICTED THE OUTCOME

`docker-compose.legacy-mongo.yml` says of the `mongo` service:

> "No volume, deliberately. State that survives a restart would start looking
> like a development database people rely on."

Package 3.6 then made that database **AE1-a's oracle** - the thing distinguishing
a minted legacy_id from a genuine one - and `null-minted.test.js`'s guard
consults it before deciding what to destroy. A `docker compose down` destroyed
it, and the restored ids pointed at nothing.

### Why this is the strongest instance

| | |
|---|---|
| AZ3 | correct reasoning failed to travel **three functions** |
| BA3 | failed to travel **three lines**, same author, same session |
| BG4 | **zero distance** - the author knew the class and wrote a claim it contradicts |
| **BO2** | the warning was **correct, specific, written at the site, and read by the author who then built a dependency on the very thing it warned about** |

The comment did not merely fail to prevent the outcome. **It described the
outcome in advance**, in the sentence the author read while wiring the
dependency. There is no version of that comment that would have worked.

> **THE COUNTERMEASURE IS NOT BETTER COMMENTS.** It is making the thing
> reproducible, so that depending on it is cheap to recover from rather than
> forbidden. `scripts/rebuildLegacyMongo.js` rebuilds the oracle from MySQL's
> own legacy_id values in one command.
>
> **Reproducible beats precious.** A resource that must not be lost is a
> resource whose loss is a crisis; a resource that can be rebuilt is neither.

---

## BO3 - A PROXY APPLIED SYSTEMATICALLY IS WORSE THAN JUDGEMENT

> **A systematic negative result is evidence only when the rule measures THE
> PROPERTY. When it measures a proxy for the property, applying it everywhere
> does not make it true - it makes it look rigorous.**

Paired with BN4, which stands as stated: BH1's thirty-of-thirty-five clean cells
are evidence *because* the rule measured the channels directly.

The 5.1 UI audit counted `catch` blocks and called it error handling. The count
was accurate; the conclusion was false; two of seven items were wrong.

### The audit BO3 asked for: every systematic check in this project

| Check | Measures | Verdict |
|---|---|---|
| **AT4's import scan** (`migration-state.test.js`) | "no file outside the allowlist IMPORTS a migrated model" | **PROXY** - importing is not writing. **Already paired**: the boot-registration gate below exists *because* this proxy failed as PAY-02, and its comment says so. The gap is also empirically EMPTY: nothing writes MongoDB without importing `models/X` - the only raw `mongoose.connection` uses in the tree are `.close()` in the ETL and scripts |
| **The boot-registration gate** | `mongoose.modelNames()` on the booted process, as an EXACT SET | **PROPERTY.** Asks the running system. Catches both directions - a model dropped (PAY-02) and one reintroduced |
| **`bridge-exit-check.js`** | the fallback log lines the bridges emit | **PROPERTY** - the line is emitted exactly when a fallback occurs, so it observes the event rather than a correlate. **One dependency worth naming**: it measures the LOG, so deleting the `console.warn` would report clean. Moot now that the bridges are deleted, and it applies to anything that replaces them |
| **`no-committed-secrets.test.js`** | "no non-placeholder value under a CREDENTIAL-SHAPED NAME" | **PROXY**, and now says so in the file. A real secret stored as `FOO=8f3a...` is invisible, and no refinement of the name pattern fixes that - the information is not in the name. Kept because the failure it catches is the one that happens |
| **`preflight-findings.test.js`** | the invariant at construction time | **PROPERTY.** It throws when the bad thing is built, not when somebody looks |
| **`password-timing.test.js`** | bursts one address until refused | **PROPERTY.** "A limiter is in the chain" and "the endpoint is limited" are different claims, and it tests the second |
| **`signup-timing.test.js`** | the quantity itself, in milliseconds | **PROPERTY** |
| **`destructive-jobs.test.js`** | specific error codes, plus a positive control that the purge DOES run with both gates open | **PROPERTY** |
| **`null-minted.test.js`** | the rows afterwards | **PROPERTY** |
| **`schema.test.js`, `server-guard.test.js`** | database behaviour and version parsing | **PROPERTY** |
| **The 5.1 UI audit** | grep counts | **PROXY, and it failed.** Corrected in `docs/ui-audit.md` rather than deleted |

**Three proxies out of eleven.** One is paired and its gap verified empty; one
now declares its own limits in the file it lives in; one failed and is corrected.
No unpaired, undeclared proxy remains.

---

## BO4 - "DO WE HANDLE BUG-11's SHAPE?" ANSWERED CORRECTLY ABOUT THE WRONG SUBSET

Seventeen frontend reads of a server message. Sixteen correct, one - the SUCCESS
path of `ChangePassword` - still reading `data.msg`, which BUG-11 removed.

**It survived because `utils/api.js` normalises FAILURES** to
`data.error || data.message`. Every error path was therefore already right, so a
reader asking "do we handle the new shape?" would look at the error handling,
find it correct, and answer yes. **The one site that did not was on the success
path, which reads the body directly.**

### The same shape as the timing channel

| | The question | The honest answer | Why it was missed |
|---|---|---|---|
| **SEC-08** | "is the oracle closed?" | closed in the BODY, open on the CLOCK at 60x | the body was checked because the body was the finding |
| **BUG-11** | "do we handle the new shape?" | handled on every FAILURE path, missed on one SUCCESS path | failures were checked because failures were the finding |

> **A question answered correctly about the subset the original finding named
> will keep being answered correctly while the remainder drifts.** The
> countermeasure is BG4's channels clause generalised: name the subset the
> answer covers - "closed in the body", "handled on the error paths" - and the
> uncovered part becomes visible instead of implied.


---

## BQ1 - `bridge-exit-check.js` IS RETIRED, BECAUSE IT IS NOW VACUOUS BY CONSTRUCTION

It measured the **log lines** the bridges emitted on a fallback. That was a fair
observation while the bridges existed - the line was written exactly when the
event occurred.

**Package 3.6 deleted the bridges.** Nothing emits those markers any more, so the
check can never fire. It would report a clean sweep for ever, on a subject that
no longer exists - **exactly the shape BH3 was commissioned to find, and this
check is where BH3 found one.**

BQ1 offered "retire it or make it measure the count directly". The count cannot
be measured: `fallbackCount()` went with `legacyBridge.js`. So it is retired.

### What is kept, and what is not

- **Retired:** the AE3 apparatus - marker scanning, the exclusion list, the
  `readyToDelete` framing. AE3 was an EXIT CONDITION for a deletion that has
  happened. An exit condition outlives its usefulness the moment you are through
  the exit.
- **Kept as `npm run test:all`:** the plain "run every suite and say which
  failed" runner, with the scan guard that BH3 added. That part was useful
  independently of bridges and is the only single command that runs the lot.
- **Kept in the map:** the finding. The check's own defect - a clean report over
  zero suites - is recorded under BH3 and does not depend on the file surviving.

> **A gate built for a migration is a gate with an end date. Leaving it in place
> afterwards does not make it a safety net; it makes it a green tick with no
> subject.**

---

## BQ2 - A CLOSURE CHECK SCOPED BY THE FINDING'S DESCRIPTION INHERITS ITS BLIND SPOTS

Two findings, one shape:

| Finding | Described as | So verification checked | What drifted |
|---|---|---|---|
| **SEC-08** | "the responses differ for a known and an unknown address" - a MESSAGE difference | the body, and later the status | **the clock.** /login was measurable at 60x while SEC-08 read CLOSED |
| **BUG-11** | "the error shape is inconsistent" - an ERROR-shape problem | every error path, all sixteen of them | **the success path.** `ChangePassword` still read `data.msg` |

In both cases the verification was correct, thorough, and scoped by the
sentence that named the finding. **The finding's own wording decided what got
looked at**, and the wording was a description of where it had been NOTICED, not
a statement of where the property had to hold.

> **VERIFY THE PROPERTY, NOT THE FINDING'S FRAMING OF IT.**
>
> "Responses are indistinguishable" is the property; "the message is the same"
> is the framing. "Callers read the response shape correctly" is the property;
> "error handling uses the new shape" is the framing.

The practical form is BG4's channels clause generalised, and it is cheap: when
closing a finding, **write down the subset the closure covers** - "closed in the
body", "handled on the error paths". The uncovered remainder then has to be
looked at to be dismissed, instead of being invisible because nobody phrased it.


---

## BT1 - "RE-ENCODE TO BE SAFE" SHIPS AN SVG PARSER. BE2's SECOND INSTANCE.

> **The obvious implementation of "re-encode every upload so nothing malicious
> survives" exposes an SVG parser to unauthenticated input, while appearing to
> close the SVG hole.**

Two correct intentions:

- **Reject SVG**, because it is XML that carries script and would be served from
  our own origin.
- **Re-encode everything**, because that is what neutralises a polyglot.

Composed, they produce the opposite of both. `sharp` lists `svg` among its INPUT
formats, so "decode it and see whether it is an image" RASTERISES the SVG and
accepts it - and the decode runs librsvg against attacker-controlled XML before
any check has looked at it. The implementation looks like it works, and the SVG
test passes because the file was accepted as a PNG.

This is BE2's composition class - two independently correct controls producing a
vulnerability by interaction - and the second instance after SEC-18 x SEC-08.
The difference is that this one was caught before shipping, by reading the
library's format list rather than its documentation's intent.

**The fix is order: identify the container from MAGIC BYTES before the decoder
is given the buffer.** And the test asserts its own premise - it first proves
sharp really does rasterise the SVG, so the refusal cannot be mistaken for the
decoder failing.

### The general form, for Phase 6's self-hosting documentation

> **An image library's INPUT FORMAT LIST is an attack surface list. A decoder
> that accepts a format you have banned will accept it on your behalf.**

The same sentence covers every parser handed untrusted bytes: the formats it
supports are the parsers you are running, whether or not you meant to.

### The same shape, one layer up: multer's storage default

A disk-backed `multer` writes the raw upload to a temporary file **before any of
our checks run** - unvalidated attacker bytes landing on the same volume the
site serves from. `memoryStorage` with a byte limit is cheaper and keeps the
bytes out of the filesystem until they have been proved to be an image.

Convenient defaults are chosen for convenience. This one is not wrong; it is
wrong HERE, and the difference is only visible if you ask what the default
actually does with the bytes.

---

## BT2 - THREE THINGS TO KEEP AS PRACTICE

1. **`storeLogo` takes no filename and no content type.** Not validating an
   input - REMOVING it. There is no parameter for `../`, a null byte or a lying
   `Content-Type` to arrive through, so none of them has to be anticipated.
   Prefer this form wherever it is available; a field that does not exist cannot
   be got wrong.

2. **Every test asserts its own premise.** The bomb test asserts the bomb is
   SMALL, or it would prove only that the byte limit works. The polyglot test
   asserts the file is a valid PNG. The SVG test asserts sharp accepts SVG.
   BH3's rule, applied without being asked, and each one is a test that would
   otherwise pass for the wrong reason.

3. **Store, repoint, delete.** Any failure leaves a working site - an orphaned
   file, or an old logo still serving. Deleting first would leave a row pointing
   at nothing. The order is the safety property, not the tidiness.

---

## BT3 - TWO NEW DEPENDENCIES, FOR PHASE 6's REVIEW

| Package | Why | For the review |
|---|---|---|
| `sharp` | decode and re-encode uploaded logos | **Apache-2.0**, compatible. **Carries NATIVE BINARIES** - prebuilt for common platforms, and a self-hoster on an unusual architecture (32-bit ARM, musl, BSD) may need a build toolchain. That belongs in the self-hosting notes, not discovered at install time |
| `multer` | multipart parsing for the one upload endpoint | **MIT**, compatible |

`npm audit` after they landed: **0 vulnerabilities** in the backend.

### The frontend's two advisories, and why the headline is misleading

`npm audit` in `Frontend/` reports **2 vulnerabilities (1 moderate, 1 high)** -
`esbuild` and the `vite` that depends on it.

**`npm audit --omit=dev` reports 0.** Both are build tooling, and the esbuild
advisory is specifically about the DEVELOPMENT SERVER accepting cross-origin
requests. Nothing reaches a deployed site, and nothing reaches a self-hoster,
who receives built assets.

That is U-6's lesson pointing the other way. There, the declaration said
dev-only and the tree said production. Here the headline says HIGH and the
production tree says nothing. **Neither the declaration nor the headline is the
answer; the tree is.**

Recorded rather than fixed: the remedy is `vite@8`, a major bump of the build
tool, which is its own package and not one to fold into a router upgrade.

---

## SPEC-5 PACKAGE 5.5 - react-router v7, AND X1's ENUMERATION RE-RUN

`react-router-dom` 6.22.3 -> 7.18.4. The build is clean and no source change
was needed: this app uses `<BrowserRouter>`, `<Routes>`, `<Link>` and
`useNavigate`, all of which v7 keeps.

### X1's enumeration, re-run as its deferral required

X1 deferred the open-redirect advisory as unreachable, **conditionally** - the
recorded trigger being a post-login `returnTo` or `next` parameter.

| | Found | Dynamic |
|---|---|---|
| `<Link to=...>` targets | 34 | **0** |
| `navigate(...)` calls | 32 | **0** |
| `useSearchParams` | 2 files | values read for DISPLAY only |

Two candidates came back from the pattern and both are safe on inspection:

- `App.jsx`: `navigate(role === "admin" ? "/admin/dashboard" : "/")` - a ternary
  between two literals.
- `AdminUsers.jsx`: ``navigate(`/admin/users/${user._id}/donations`)`` - a fixed
  prefix with a server-generated id interpolated **not at the start of the
  string**, which is X1's own recorded safe shape.

`PaymentSuccess` and `PaymentFailure` read `txnid`, `amount`, `status` and
`error` from the query string and render them. **Every `navigate()` in both
files takes a string literal.**

**No `returnTo`, `next`, `redirectTo` or `redirect_uri` parameter exists
anywhere in the frontend.** X1's trigger has not fired, and the deferral still
holds after the upgrade - which is the thing the re-run was for.


---

## BU1 - THE FIRST FINDING THAT CAME FROM THE WHITELABEL FRAMING, NOT FROM SECURITY

Every finding in this map so far arrived by asking a security question. This one
arrived by asking a **product** one.

Package 5.4 replaced nine hardcoded `For Ocean Foundation` strings with the
configured organisation name, and left `"For Ocean Foundation"` as the FALLBACK
in three places - the React default, the PDF generator's parameter default, and
`index.html`'s `<title>`.

**Correct for this deployment. Wrong for a product.** A fallback renders before
the branding fetch resolves, so every OTHER charity installing this would show
For Ocean Foundation's name on their own site for that moment - and
`index.html`'s title would show it before any JavaScript ran at all.

> **A default is a decision about the installation you have not met.**

`organisationName` now defaults to empty - which renders as nothing, and
**nothing beats briefly rendering the wrong organisation**. The PDF defaults to a
generic title and `index.html` says "Donations".

SPEC-5 section 10 asked for exactly this ("no hardcoded For Ocean Foundation
string remains in the frontend") and the first pass satisfied it in spirit while
leaving four. The literal reading was the correct one.

### Why it is worth recording as a class

The security questions this project has been asking - what does an attacker see,
what does a control actually measure - do not reach it. Nothing about a fallback
organisation name is exploitable. It is wrong because **the audience changed**:
the code is no longer for one NGO, and a value that was a fact became an
assumption the moment the software acquired a second possible installer.

Phase 5 is the first phase where that question applies, and it should be asked
of every remaining default before publication.

---

## BT3b - `npm audit` HEADLINES AND DEPENDENCY TREES DISAGREE IN BOTH DIRECTIONS

Two findings, one lesson, pointing opposite ways:

| | The claim | The tree | The lesson |
|---|---|---|---|
| **U-6** | `package.json` lists `prisma` under `devDependencies` | `@prisma/client` (a PRODUCTION dependency) pulls `prisma`, so three HIGH advisories were in the production tree | **the declaration was wrong** |
| **BT3** | `npm audit` in `Frontend/` reports 2 vulnerabilities, **1 high** | `npm audit --omit=dev` reports **0**. Both are build tooling, and the esbuild advisory is specifically about the DEVELOPMENT SERVER | **the headline was wrong** |

> **Neither the declaration nor the headline is the answer. The tree is.**

And U-6 added the other half, which is the one most likely to be skipped:
**an advisory names a vulnerable PACKAGE and a vulnerable RANGE.** Upgrading the
thing that depends on it is a different claim - bumping Prisma to v7 would have
changed a major version of the data layer and left all three advisories in
place, because the vulnerable range covers v7.

**Queued, not started:** `vite@8`, a build-tool major. It fixes a dev-server
advisory that reaches no deployed site and no self-hoster, so it is its own
package rather than something to fold into a router upgrade.


---

## ENV-02 (HIGH) - THE GATEWAY DEFAULT TOOK DONATIONS THAT NEVER ARRIVED

**Severity: HIGH. Fails in the direction that looks like success.**

```yaml
PAYU_BASE_URL: ${PAYU_BASE_URL:-https://test.payu.in}     # was
```

A self-hoster who did not set it ran the **entire donation flow against PayU's
sandbox**. The site works. Donors complete payments. Receipts render, the admin
dashboard fills in, donations are marked Paid.

**No money moves.**

Every symptom points away from the cause: the code is correct, the hashes
verify, the callbacks arrive, the database is consistent. **The only way to
notice is reconciling against a bank account that never received anything.**

### Beside ENV-01, because the pair is the lesson

| | ENV-01 | **ENV-02** |
|---|---|---|
| The variable | **ABSENT** | **PRESENT** |
| What it silently disabled | a security check - PayU response hashes became publicly computable | **the purpose of the software** - donations that never arrive |
| The symptom | none. A hash verified and matched | none. A donation completed and was marked Paid |

> **ENV-01 was an absent variable silently disabling a security check. ENV-02 is
> a present variable silently disabling the point of the software. Both fail in
> the direction that looks like success.**

### Why `:?` and not a runtime guard, which is where ENV-01 went

`PAYU_MERCHANT_SALT` is guarded at the point of use, because a blank salt is
**detectable by the code**: it refuses at the moment it would have signed
something, and that leaves the stack running for people not working on payments.

**A test gateway and a production gateway are indistinguishable to the code.**
Both are valid hosts, both answer, both sign correctly. There is no observation
the software can make that separates them. Only the operator knows which one
they meant, so the only place to ask is before the stack starts.

### Fixed, and asserted BY OUTCOME

- `docker-compose.yml`: `${PAYU_BASE_URL:?...}` with the two hosts named in the
  message.
- **`config/payu.js` had a SECOND fallback** - `|| 'https://test.payu.in'` -
  which would have survived the compose file being fixed. Removed. AY2 again:
  the same default, one layer down, in the file the first one is about.
- `.env.example` is **deliberately blank** with both hosts in the comment. A
  value there is inherited by everyone who copies it.
- CI asserts the stack **refuses to start**, before the `.env` is written, which
  is the only moment the variable is genuinely absent. A test grepping the
  compose file for `:?` would measure the declaration; this measures the
  behaviour (BO3).

### The only detection available, written down rather than assumed

**The first real donation after any deployment must be reconciled against the
bank before the site is announced.** There is no code-level check for this and
there cannot be one. It is in the self-hosting notes and in the 4b runbook.

---

## BW2 - THE OPERATIVE RULE FOR DEFAULTS

> **A default is acceptable when it is universal, or when it fails safe, or when
> getting it wrong is VISIBLE and CHEAP TO CORRECT.**
>
> **A default is not acceptable when an installer must get it right for their
> own context and THE WRONG VALUE WORKS.**

### It supersedes BU1's first version, and the difference is instructive

BU1 framed it as **"a fact about this deployment versus a decision about an
installation nobody has met"**. That framing found the organisation-name
fallback, which is why it was written - but applied consistently it is wrong in
both directions:

- **It flags the branding seed colours**, which are For Ocean Foundation's blue
  and therefore a local fact. Keeping them is required by SPEC-5 section 10, and
  a wrong colour is visible on first load and fixed in thirty seconds.
- **It misses the cost asymmetry entirely.** `PAYU_BASE_URL` and a hex colour
  are both local facts. One costs an NGO every donation until somebody reads a
  bank statement; the other costs a click.

The operative question is not *where did this value come from* but **what does
getting it wrong cost, and how soon does anyone find out**. BU1's version is
recorded as the weaker first attempt rather than deleted - it produced the
finding that led here.

---

## BW3 - THE OTHER THREE DEFAULTS

### `SCHEDULER_TIMEZONE`: `Asia/Kolkata` -> `UTC`. DONE.

A fact about one deployment. An NGO elsewhere had destructive jobs firing at
whatever local hour 02:00 IST happens to be for them - quietly, because a cron
at the wrong hour still fires. **Neutral beats somebody else's local time**: an
operator who wants their own hour sets the variable, and one who never thinks
about it gets a value that is wrong for nobody in particular.

### `RETENTION_YEARS`: hardcoded -> environment, with validation. DONE.

Ten years is a **legal** figure that varies by jurisdiction, and it was not even
environment-configurable, on a job that **deletes donation records**.

AT1 keeping `JOB_RETENTION_PURGE` off by default is a **mitigation, not a fix**:
nothing is deleted on a number nobody chose *until somebody turns the job on and
inherits a figure they never saw*. It now reads from the environment and refuses
a non-positive value, and the default stays 10 for continuity with this
deployment.

### `INR`: LEFT, and recorded as a constraint of the gateway rather than a default

Hardcoded in the donations repository, the schema default and the branding seed.

**It is not independently changeable.** PayU is an India-only gateway, so an
installation outside India cannot use the payment flow at all - the currency is
*downstream* of a gateway choice this project already made.

Making the currency configurable would produce a field an NGO can set to EUR and
still not be paid in, which is worse than the honest statement:

> **This software supports PayU. PayU is India-only. An NGO outside India needs
> gateway work, which is a piece of engineering and not a configuration value.**

**What would unblock it: supporting a second gateway.** Recorded as the trigger,
so the currency question is revisited then rather than being rediscovered as a
bug.


---

## FE-01 - `main`'s FRONTEND CANNOT BE INSTALLED AS COMMITTED

**Not ours. Introduced by Dependabot's grouped bump, PR #5, already merged to
`main`.**

PR #5 raised `vite` to `^8.3.0`. `@vitejs/plugin-react` `^4.2.1` resolves to
4.7.0, whose peer range is `^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`. vite 8 is
outside it.

| npm | What it says |
|---|---|
| **11** | `ERESOLVE unable to resolve dependency tree ... peer vite@"^4.2.0 \|\| ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0" from @vitejs/plugin-react@4.7.0` - the real error |
| **10** - which Node 20 ships, and which CI uses | `Cannot read properties of null (reading 'edgesOut')` - **an opaque crash naming nothing in this project** |

The symptom under the npm most likely to hit it gives no indication of the
cause.

### Fix, proven on `main`'s own tree

`@vitejs/plugin-react` `^6.1.2` (the line declaring vite 8 support) **and a
committed lockfile**. Without the lockfile npm 10 still crashes on fresh
resolution even with compatible versions - its own bug. With one, npm 10's
`npm ci` and `npm install` both succeed and the lockfile is stable across runs.
Then: vite 8.3.4 builds, and **ten routes load in headless Chromium with zero
uncaught exceptions.**

Both Vercel projects run Node `24.x`, which satisfies vite 8's and plugin-react
6's `^20.19 || >=22.12`. The fix will not fail on the Node setting.

### Two moderate advisories that the fix does NOT touch, and why both are unreachable

`npm audit --omit=dev` on `main`'s frontend reports two `react-router` 6
advisories. They are pre-existing and the fix cannot have introduced them - it
changes one devDependency.

- **Open redirect via backslash in `<Link>`/`useNavigate`.** X1's enumeration,
  re-run in 5.5: every navigation target is a literal or a fixed prefix with a
  server id interpolated not at the start. Unreachable.
- **Constructor injection via `deserializeErrors()` in SSR hydration.** The app
  calls `createRoot`, uses `BrowserRouter`, and has no `hydrateRoot`, data
  router or hydration data anywhere. The vulnerable function only runs when
  hydrating server-rendered router state, which this client-only app never
  does. Unreachable - checked, not assumed.

Both are closed by react-router 7.18.4, which PR-F delivers.

---

## THE RULE: "NO CONFLICTS" IS NOT EVIDENCE A MERGE WORKS

Merging `origin/main` into phase-2, `Frontend/package.json` merged with **no git
conflict** to `vite ^8` - phase-2 never touched that line - while phase-2's
lockfile still pinned vite 5. **Git saw a clean merge. npm refused to install
it.**

> **For any merge touching either frontend package file, regenerate the
> lockfile with npm 10 and run `npm ci`. A clean merge of a manifest says
> nothing about whether the manifest and its lockfile still agree.**

It generalises past npm: git merges TEXT, and any pair of files that must agree
- manifest and lockfile, schema and generated client, migration and snapshot -
can each merge cleanly into a pair that no longer does. The check has to be the
tool that reads both, not the one that merged them.

---

## VERCEL - WHAT PRODUCTION IS ACTUALLY SERVING

Read from both projects, environment values not touched:

| | Frontend | Backend |
|---|---|---|
| Node | `24.x` | `24.x` |
| **Serving** | `58bdadf` - PR #14, 10 Sept, `READY` | `58bdadf` - PR #14, 10 Sept, `READY` |
| PR #5 (`17b30a1`), 18 Oct | **`ERROR`** - `BUILD_FAILED: Resource provisioning failed`, 784 ms | **`ERROR`** - same, 835 ms |

**PR #5 never reached production.** So production is still on `nodemailer` 7,
and the earlier concern that production email had been running on v10 does not
apply.

**PR #5 did not fail on FE-01.** It failed in under a second, before any install
could run - and the backend, which has no vite at all, failed identically. The
cause is account- or project-level, not code.

**It is also a DIFFERENT failure from ADR-028.** The same deployment list shows
ADR-028's commit-authorship block as `BLOCKED`. This is `ERROR` with a
provisioning message. The cause is not visible from the API and needs the
dashboard.

> **Why this matters now: the hotfix is planned as "merge and deploy now".** If
> provisioning is still failing, the merge will succeed and the deploy will not,
> and production will keep serving the auth bypass while the PR shows as merged.
> **The hotfix's deploy has to be confirmed `READY`, not assumed** - and the
> provisioning failure is worth diagnosing before relying on it.

---

## BZ4 - AN UNRELATED PROJECT'S BRANCHES ARE IN THIS REPOSITORY

`origin/setup-12` and `origin/setup-13` (identical) are **"Sentinel"**
(`sentinel-tip`): their own initial commit on 22 Feb, no shared history with
`main`, lowercase `backend/`/`frontend/`, a TypeScript frontend. **12 of 13
commits are by Viraj.**

They contain a fallback secret - `SECRET_KEY=${SECRET_KEY:-change-me-in-production}`,
three times - the JWT-fallback shape: a working key whenever the variable is
unset.

**Left alone deliberately.** It is a colleague's work, possibly live elsewhere.
It is added to Phase 6's scrub scope as a decision that **needs Viraj and is
Gary's to make.**

---

## BZ5 - NODEMAILER 10: THE CORRECTION, AND WHAT IS STILL UNPROVEN

Phase 2's own commit 3 had already upgraded `nodemailer` to `^10.0.3` -
identically to Dependabot, which is why that line did not conflict. Every
signup and login suite reaches `createTransport().sendMail()` and fails at the
SMTP handshake with `EAUTH`; an API break would throw before that.

**Delivery is still unproven**, and cannot be proven without a real mail server.
**One real OTP after deployment is the only proof**, and it is in the 4b
runbook.


---

## CB2 - FOUND WHILE BUILDING THE ENVIRONMENT LIST

Full list: `docs/deployment-environment.md`. These are the items that are
findings rather than configuration.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| CB2-1 | **Frontend CSP `connect-src` hardcodes the old backend hostname** (`Frontend/vercel.json`). Any new backend host is blocked by the browser | **Blocks step 5** | **CLOSED in post-F (#33), CX2.** `https://kindledger-api.vercel.app`; the old host removed |
| CB2-2 | **Tracked `Frontend/.env` names the old backend.** If `VITE_API_URL` is unset on the new project, the build falls back to a hostname that will have no owner once the old project is deleted. **The CSP also allows that host.** Whether `*.vercel.app` names are re-claimable is UNVERIFIED | **High if claimable** | Same PR: remove the value so the fallback is `localhost` (fails loud) |
| CB2-3 | **No `prisma generate` in the backend build.** Prisma documents stale-client failures on Vercel's dependency cache. Not reproduced: the cache cannot be simulated locally | Medium. The first deploy works | **Post-F: `"vercel-build": "prisma generate"`.** Not postinstall, which would have broken the Docker build: the Dockerfile runs `npm ci` before copying `prisma/`. Found while making the change |
| CB2-4 | **`REDIS_URL` absent means per-instance in-memory rate limits on serverless.** Fails silent | **High on Vercel** | Required in the list. Check the boot log after first deploy |
| CB2-5 | **`PRISMA_CONNECTION_LIMIT` default of 10 is derived for one container.** On serverless it multiplies by instance count | Medium | Derivation in the list. Start at 1 |
| CB2-6 | **Logo upload and the scheduler cannot work on Vercel.** Read-only filesystem; no long-running process. `UPLOADS_DIR=/tmp` or `SCHEDULER_ENABLED=true` would turn a loud failure into a silent one | Recorded | Documented as unsupported on Vercel. DEF-05 |
| CB2-7 | **A MongoDB credential was set on the FRONTEND project** (Atlas Marketplace integration, production). Vite only bundles `VITE_*`, so it was not shipped to browsers | Low | Not carried over |
| CB2-8 | **Four secrets were stored as readable, not Sensitive.** Vercel flagged `MONGODB_URI`, `JWT_SECRET`, `EMAIL_PASSWORD`, `PAYU_MERCHANT_KEY` as `readable-secret` | Low | New project: create all as Sensitive |
| CB2-9 | **Email `from` is hardcoded `"For Ocean Foundation"`** in four places in `config/email.js`. BU1's whitelabel class, missed by SPEC-5 because SPEC-5 covered the UI | Low. Wrong for any other installer | **CLOSED by CP1.** All 17 occurrences - not 4: the sender, greetings, sign-offs and footers - come from branding's organisation name. Pinned by `test:email` "CB2-9" |
| CB2-10 | **`npm run test:bridge` points at a test deleted in 3.6** | Trivial. Fails loud | **CLOSED in E (#31), CM1.** The script and its CI step were removed with the bridge. CI found it the first time the PayU job could start |

**And one correction to how ENV-02 had been described.** "The stack refuses to
start without `PAYU_BASE_URL`" is true of **compose only**. Vercel has no
compose file. There, a missing value fails loud at the first donation, because
there is no fallback (BW1), and a **wrong** value is still silent. The list says
so.

### Checked and clean

**PayU salt history.** Every salt-shaped value ever committed (`git log --all
-G`) is the `TEST…` fixture in a test file. No evidence the production salt was
ever in the repository, so carrying it over is not contradicted.

## CD - THE OLD VERCEL PROJECTS STAY

**CD1: the plan changed.** Gary is creating new frontend and backend projects
and **keeping** the old ones, rather than deleting them. Applied in
`docs/deployment-environment.md` §1.2, §6, §7 and §8, and in the 4b runbook.

| Was | Now |
|---|---|
| Secure the Atlas source before deleting the projects (env doc §7.1) | **Withdrawn.** Nothing is deleted. It returns if deletion does |
| Recover carried-over values from source systems | **Copy from the old backend.** All nine COPY values are stored there as readable `encrypted`, so they can be revealed |
| CB2-2: the old `*.vercel.app` name may be claimable once released | **Gone.** The name is not released. **`Frontend/.env` still gets fixed**: it is wrong, and while the old backend serves, a fallback build silently reaches it, on MongoDB, with SEC-03 |
| SEC-03 stays live until the new backend is up | **Unchanged in substance.** It is now tied to an explicit act: the window closes when the old backend is **paused** (runbook §3.4), not when the new one comes up |

**CD2: risks the plan change creates, each a runbook step, not a note.**

| # | Risk | Severity | Runbook step |
|---|---|---|---|
| CD2a | **Two live backends.** Donations split between MongoDB and MySQL, and anything the old one takes after the ETL never reaches MySQL | **High** | §3.4 pause inside the freeze. §6a.1 re-confirm before reopening. §6 rollback order never passes through "both serving" |
| CD2b | **The old projects serve `58bdadf` until they are turned off** | **High** (SEC-03) | §3.4 (backend), §6a.4 (frontend). Confirmed by request, before and after |
| CD2c | **Credentials crossing over.** MySQL credential on the old backend, MongoDB credential on the new | **High** | §1.6, by name, both projects, including the Atlas integration. Repeated at §6a.2 |
| CD2d | **The old projects are still Git-connected.** Production deploys on every push to `main`. Only `Resource provisioning failed` is stopping them | **High once provisioning works.** Post-F's CSP change would break the old frontend, and MySQL-era backend code would break the old backend | **CLOSED (CI2, 3 Nov 2026).** Gary disconnected Git from both before any PR merged. **Not in the CD brief; found while checking the projects** |
| CD2e | **A copied host variable reproduces CD2a through configuration.** A copied `NOTIFY_URL`/`SUCCESS_URL` sends PayU's confirmations to the old backend. A copied `VITE_API_URL` sends everything | **High**, silent | Env doc §6: **REWRITE** action (8 names). Runbook §6a.3 |

**A correction to CD2a's wording.** "Two backends pointed at the same Atlas
cluster" happens literally only if CD2c is also broken. After 3.6 the new
backend reads no MongoDB on the request path. The general form, which needs
nothing else to go wrong, is two backends each taking donations into a
different store. The steps above cover both.

**CD3: copy-across column.** Env doc §6 gives each of the 36 backend names an
action, and §2.1 and §2.2 carry the same column. Gary types in **21 on the
backend and 1 on the frontend**. The other 15 stay unset. The brief's three
actions became five. **REWRITE** is CD2e. **DO NOT SET** covers the
13 names that must stay off Vercel.

**Checked, not assumed:** the old projects' variable NAMES were re-read for
this (21 on the backend, 2 on the frontend). Values were not decrypted.

## ENV-03 (HIGH) - A CORRECT VALUE IN THE WRONG PLACE

**Recorded as a finding in its own right (CE4).** It started as CD2e.

Copy `NOTIFY_URL` from the old backend to the new one and nothing is wrong with
the value. It is a well-formed URL, it answers, and the endpoint behind it
verifies PayU's hash correctly. **It is the old backend's endpoint.** PayU's
server-to-server confirmation goes there. While the old backend is up, it
accepts the confirmation and records the donation as Paid **in MongoDB**. MySQL
keeps it Pending. Neither side errors. Nothing in either log looks wrong.
`SUCCESS_URL`, `FAILURE_URL` and `CANCEL_URL` do the same through the donor's
browser. `VITE_API_URL` does it for every request the new frontend makes.

**Beside ENV-02, because the pair is the class.** ENV-02 was a valid value from
the wrong environment (sandbox). ENV-03 is a valid value from the wrong
deployment. In both, the code has no way to tell. Every check it could run
passes.

| | |
|---|---|
| Names affected | 8: `ALLOWED_ORIGINS`, `SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL`, `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL`, `VITE_API_URL` |
| Fails | **SILENT** while the old backend serves. Loud once it is paused, except that a donation confirmed during the gap is already in the wrong store |
| Why the copy is likely | The env list said "copy from the old project" for its neighbours. A person setting 21 variables by hand copies in runs |
| Control | Env doc §6 gives these a separate action, **REWRITE**, so no row says COPY. Runbook §6a.3 checks them by host before donations reopen. Pausing the old backend at §3.4 turns the failure loud |
| Not a control | The application. It cannot know which deployment it is |

## CE5 - THE DEPLOY SEQUENCE, SETTLED

Env doc §8 said production serves `58bdadf` "through 4b and 4c". ADR-062 said
the new projects come "after Phase 4c". The runbook assumed donations land in
MySQL at the end of 4b. **The runbook was right.** The new backend goes live at
the **end of 4b, inside the freeze**, before donations reopen. 4c is cleanup
afterwards.

Fixed: env doc §8 (rewritten around the sequence), ADR-062 (annotated in
place), and the runbook. The runbook verified through the application (§5.5)
but never deployed it, so a §4a now deploys it. AL3 grep for other statements
of the sequence (`4b and 4c`, `after Phase 4c`, `step 5`, `nothing deploys`,
`first deploy`, `4c`): the remediation map's 4c/4d table and the runbook's §8
already say 4c is cleanup after 4b. Nothing else stated the order. The same
pass caught runbook §7a. It still said "the stack refuses to start" without
`PAYU_BASE_URL`, which is the compose-only claim CB2 corrected. Fixed.

## THE OCCUPIED SLOT: A CONFIGURED CHECK THAT CANNOT RUN IS WORSE THAN NO CHECK (DT1)

Named on 10 Nov 2026, after the third real defect found the same way: **by
making a check that already existed actually run.** A missing check is visible
- someone asks "do we lint?" and the answer is no. A configured check that
cannot run answers "yes" to that question for ever. It occupies the slot where
the real one would go, and nothing reports its absence.

| | The check that existed | Why it could not run, or ran on the wrong thing | What it hid |
|---|---|---|---|
| **CI-01** (below) | The Schema and MySQL CI jobs | mysqld flags in a service's `options:`; Docker refused them, every run, since Phase 1a | Every "N/N green" for MySQL was nobody's result. Five defects surfaced the day it ran (CM1) |
| **RATE-01 / RATE-02** (DH1) | Every suite that exercises a rate limiter | All of them run without `REDIS_URL`, on per-limiter memory stores - never the configuration that ships | The reset-code cap at 5 a minute, not 5 per 15; an instance answering 500 on every limited route after one Redis timeout |
| **FE-02** (below) | `npm run lint`, configured in `Frontend/` | ESLint 8 pinned against an ESLint 9 config; it died before reading a file, and no workflow ran it to notice (LINT-01) | **The admin Donations page crashing on every render, for seven weeks, in production** |

**The rule it gives:** a check counts only once it has been seen to fail. A
check nobody has watched go red has not been shown to run at all.

### FE-02 (High) - the admin Donations page crashed on every render, from 22 Sep to 10 Nov. FIXED (DT1)

`Frontend/src/pages/DonationsPage.jsx` calls `useBranding()` on its first line.
SPEC-5 5.4 (`6566b41`, 22 Sep 2026) added that call when it replaced the
hardcoded organisation name - **and never added the import.** Every render
threw `ReferenceError: useBranding is not defined`. The page is `/donations`,
linked from the admin navbar twice and from the admin dashboard.

**Why seven weeks.** A missing import is not a build error. `vite build`
resolves imports, and there is no import here to resolve - only a free name,
which is looked up when the function *runs*, and a build never runs a
component. So every Vercel deployment of the frontend **built successfully**
with the crash inside it. (CI builds nothing in `Frontend/`; no workflow touches
it.) Two things could have caught it: the lint, which had never been able to
run (LINT-01's `no-undef`), or opening the page, which no test does.

**Fixed:** the one import. **Proved both ways** in a production build, with an
admin-role token planted client-side (no API involved): before,
`ReferenceError: useBranding is not defined` on render; after, the page mounts
and runs its effects - it requests `/api/donations` and
`/api/donations/filter-options`.

**Not fixed here:** FE-03, the same shape in `/admin/categories`
(`ConfirmModal` and the delete-modal state never defined, since the first
commit). Nothing links to that route; it goes with the lint fix.

---

## CI-01 (HIGH, for what it hid) - NO MYSQL JOB HAD EVER STARTED IN CI. FIXED (CM1)

Found when the stack was pushed on 3 Nov and every branch went red.

The workflows pass `--character-set-server=utf8mb4`,
`--collation-server=utf8mb4_0900_ai_ci` and `--default-time-zone=+00:00` in a
service container's `options:`. GitHub hands `options:` to `docker create`,
and these are **mysqld** arguments, so Docker rejects them: `unknown flag:
--character-set-server`, exit 125, at "Initialize containers". The flags
arrived with Phase 1a (`4142de7`, PR #11). **The Schema workflow has failed on
`main` at that step on every run since then.** The same block is in
`app-tests.yml` twice (the data-layer job from AA1, and the job that grew a
MySQL service in package 3.1).

**What it meant:** until the fix, every "N/N green" in this map and in the commit history was
a local or in-container run. That evidence is real, but **CI has never
independently confirmed any MySQL suite.** The commits said "CI status
UNCONFIRMED" at the time, and this is the answer. Only the MongoDB-only job
(PayU callbacks and reset controls) has ever passed in CI, on A and B.

**FIXED (CM1), at the earliest point each block exists.** The service
`options:` keep only the health check. A "Configure MySQL as docker-compose.yml
does" step applies the three settings with `SET PERSIST` once the server is
up, reads them back with the database's defaults, and fails unless all five
match compose. The `schema.yml` fix is in PR 1 (#24), so every PR inherits it.
The two `app-tests.yml` blocks are fixed in the PRs that add them: B (#28) for
the data-layer job, C (#29) for the PayU job. A merge cannot rewrite lines a
branch adds itself. The secrets check moved to its own job with no services in
E (#31), where the test first exists.

**Proved in CI, not asserted.** Pass counts from the job logs:

| Where | Suite | CI result |
|---|---|---|
| PR 1 (#24) | server-guard, schema, drift gate (twice) | 14/14, 30/30, clean |
| B (#28) | data-layer (with the Redis store assertion) | 26/26 |
| B (#28) | payment-callbacks, auth-reset, trust-proxy | 17/17, 6/6, 4/4 |

### What the first full CI run found (CM1)

Fixing CI-01 let every step run for the first time. Five things surfaced that
local and in-container runs could not see. Each was fixed in the PR whose range
introduced it, and each PR was re-run until green:

| Where | Finding | Fix |
|---|---|---|
| D (#30) | **A vacuous test.** `payment-characterisation`'s "QUIRK (SEC-19)" asserted `details: error.message` was present. 3.4 removed the leak and left a comment saying so, and the test's regex matched the comment. It passed while unable to tell fixed from broken | Flipped to "SEC-19 CLOSED: no payment handler returns err.message to the client", on comment-stripped source with a non-vacuity check. Checked both ways: clean on the branch, both of `main`'s leaks caught |
| E (#31) | CB2-10: the bridge test's CI step and script outlived the bridge | Removed |
| E (#31), F (#32) | **The whole-suite runners hard-coded MongoDB at `mongo:27017`**, the compose hostname, so on a runner every MongoDB suite failed there while passing in its own step | The server comes from `TEST_MONGODB_URI`; the database name stays derived per suite; an Atlas host is refused. E also gets F's `null-minted` database exception, which it lacked |
| E (#31) | **`signup-timing` and `password-timing` never set `JWT_SECRET`**, so `config/jwt.js` threw before either measured anything | Both set the same test-only value as every other suite |
| F (#32) | **`branding.test.js` uploads into `/var/lib/kindledger/uploads`**, which only the api container's Dockerfile creates. Two upload tests got a 500 | A scratch directory unless `UPLOADS_DIR` is supplied, as `logo-upload.test.js` already did |

**The class:** three of the five passed only inside the api container, whose
environment and filesystem supplied what the suite assumed. "Every suite green"
before CM1 meant "green in one environment". The runners now print the
failing assertions under a FAIL, so the next one of these explains itself.

Every count above reports 0 skipped and 0 todo. The PR descriptions carry
the counts for every branch.

**Found beside it, and fixed in post-F:** the ENV-02 step "The stack REFUSES
to start without PAYU_BASE_URL" ran `docker compose config` with nothing set.
Compose reports only the first missing required variable, and that was
`DATABASE_URL`, so the step tested the wrong guard and failed. It passed
locally because the checkout had a `.env`. The step now supplies the other
five required variables. Checked both ways against a clean copy of the
compose file: it refuses naming `PAYU_BASE_URL`, and accepts once that is set.

## CG1 - THE REPOSITORY STAYS PUBLIC: WHAT IS EXPOSED, CHECKED 3 NOV 2026

**Decided by Gary: public deliberately, rotate rather than scrub.** No history
rewrite: it would break all ten stacked PRs and every clone. The Phase 6
checklist §0 and §1 carry the consequences.

### a. `for_ocean_security_review.md` is on `main`'s front page, not just in history

Added at `bacd6d9` (24 May, "CloudPeak update"), removed in package 3.0
(`6cfec20`), and from `main` itself by PR 1 (#24, CH1). **Until #24 merges
the file sits at the root of `origin/main` and of 17 other public
branches**, including the heads of the first five PRs as first opened. ADR-030 called it
"never public", which assumed a private repository and no longer holds. It
remains in history whatever happens to `main`.

Most of its ~40 findings were fixed before production's `58bdadf`
(SECURITY-REVIEW.md appendix A). **What it describes that production still
has.** Production is `58bdadf`; none of the stack's fixes are merged or
deployed:

| Its ID | Now | In production (`58bdadf`) | Fixed where |
|---|---|---|---|
| BE-HIGH-03 | SEC-04: rate limiting non-functional | **Open.** In-memory default limiter, per instance on serverless | D (#30), package 3.2 |
| BE-HIGH-06 | SEC-08: account enumeration on four endpoints | **Open** | D (#30) and E (#31) |
| BE-MED-09 | SEC-16 / BUG-02: admin status writes unvalidated | **Open** | D (#30) |
| BE-HIGH-07 | SEC-15: JWT in `localStorage` | **Open, everywhere.** Not fixed on the stack either | Not scheduled |
| BE-MED-07 | Seeder sets `Password@123` for 1000 users | **Open in the legacy seeder** (see c) | Seeder deleted in 4c |
| BE-MED-11 | SEC-12: no lockfiles to audit | **Open** | B (#28) |
| LOW-02 | SEC-17: `Frontend/.env` tracked | **Open.** Post-F empties it; still tracked | Post-F (#33), partially |
| LOW-03 to LOW-05 | Duplicate files, dead PDF generators, `console.log` sprawl | Open (hygiene) | Not scheduled |

**Mitigating, and recorded, not leaned on:** production's backend answers
**every** request with `FUNCTION_INVOCATION_FAILED` today, because MongoDB
rejects its credentials (CI1, below). So nothing in that table is reachable
while it stays down. That is an availability failure
standing in for access control, the same shape SEC-03 was recorded with.

### b. The JWT fallback is permanently public; production does not use it, confirmed by behaviour

Fallback literals ever committed, values not reproduced here: **30 characters**
in `Backend/config/jwt.js` from `e11a09e` (17 Jan) to `bacd6d9` (24 May), both
ancestors of `main`; **43 characters** as a test fallback in
`Backend/test/branding.test.js` from `3db866a` (22 Sep); 10 characters inside a
comment in the secrets test.

**Production is not using the 30-character one. Shown by behaviour, without
reading the secret.** Production's `app.js` requires `routes/auth.js` (line
12), and so `config/jwt.js`, which throws at load if `JWT_SECRET` is missing or
under 32 characters, **before** `connectDB()` (line 88). Production's runtime
logs for 3 Nov show every request reaching "MongoDB Connection Failed". So the
guard passed, and the value is at least 32 characters.

**Production is not using the 43-character one either.** Vercel records the old
backend's `JWT_SECRET` as created with the project on 22 Jan and never edited.
The test value first appeared eight months later. This is metadata, so it would
miss a value copied *out* of production into the test. Nothing suggests that
happened, and rotation (CG2) makes it moot.

### c. `Password@123`: no current code path, one data path

At `main` and every stack tip it appears only in `Backend/scripts/seedDatabase.js`
(the legacy MongoDB seeder, which refuses to run unless `NODE_ENV` is not
production **and** `ALLOW_SEED=true`), its README, the top-level README's
warning, and a comment in the MySQL seeder explaining why that one generates a
random password per run. **No application code uses it.** The seeder an
installation runs today (`npm run db:seed`) never produces it.

**The one way it reaches a current installation is data.** If the legacy
seeder ever ran against production MongoDB, those hashes are in production, and
the ETL copies password hashes verbatim. 4b runbook §2.2 checks every
production hash against it **before** the ETL. Unknown until then.

### Two things found while checking, both urgent

**1. Production's MongoDB cluster name did not resolve.** At 08:33 UTC on
3 Nov every production request failed with `querySrv ENOTFOUND
_mongodb._tcp.foroceanfoundation-db.fbjyfvb.mongodb.net`, and Google DNS
returned NXDOMAIN for the SRV record. I read that as a possibly deleted
cluster. **That reading was wrong. Corrected under CI1 below.**

### CI1 - CORRECTION: THE CLUSTER WAS PAUSED, AND THE CREDENTIALS ARE ALSO REJECTED

**What happened:** the cluster is on Atlas's free tier, which **auto-pauses
after 30 days with no activity**. A paused cluster's hostname is withdrawn,
which is what the NXDOMAIN was. **Gary resumed it on 3 Nov. It was never
deleted.** The deleted-cluster reading above was wrong.

**The earlier entry, "MongoDB rejects the application's credentials", was NOT
wrong, and stands.** After the resume, the SRV record resolves again, and
production's next request (08:55 UTC) failed differently: `MongoDB Connection
Failed bad auth : Authentication failed`. So two things are true at once:

| Layer | State on 3 Nov | Evidence |
|---|---|---|
| Cluster | Paused by the free-tier auto-pause, then resumed by Gary | NXDOMAIN at 08:33; SRV resolves after the resume |
| Production's `MONGODB_URI` credentials | **Rejected** | `bad auth : Authentication failed` at 08:55, after the resume |

While the cluster was paused, the DNS failure **hid** the credential failure.
That is why the first reading looked like a contradiction of the map.

**Consequences:**

- **Production is still down, and SEC-03 is still unreachable**, now because of
  the credential rejection again. That is an availability failure, not a fix.
  **If anyone restores production's MongoDB credentials, the SEC-03 bypass goes
  live with it.** Git is disconnected (CI2), so merging #24 will not deploy the
  fix.
- **4b depends on a free-tier cluster that pauses itself and has no backups.**
  Runbook §1.8 (keep it awake, export early), the RUNNING check before §3, and
  §3 step 6 (export inside the freeze and prove it restores) are the controls.
  Without step 6 the rollback in §6 rests on nothing.
- **Auto-pause cannot be disabled on the free tier.** Atlas documents no
  setting, and you cannot pause or unpause one on a schedule. It stays awake
  through activity, so connect at least weekly, or move to a paid tier for the
  cutover window (Gary's call).

### CI2 - CD2d CLOSED

Gary disconnected Git from both old Vercel projects on 3 Nov 2026, **before**
any of the ten PRs merged. A merge to `main` can no longer reach them.
Recorded consequence: the hotfix's merge will not deploy either (runbook
§1.7).

**2. `main` publishes a GPL v3 `LICENSE` today.** It sits beside ISC in
`Backend/package.json` (ADR-029). ADR-061's reassurance, that the GPL commit
`4f3b7ec` was made while private so no public grant exists, does not survive a
public repository. Apache-2.0 arrives in E (#31). **What the published GPL text
means for the versions under it is a licensing question for Gary.** Recorded,
not answered.

## SEC-15 (MEDIUM) - OPEN, AND NOT FIXED ANYWHERE (CH3)

**Status, stated plainly: OPEN in production, OPEN on every branch, and until
now in no package.** None of the ten PRs touches it. Earlier maps carried it
as "R", which read like a deferral. It was a gap. It is also named, with its
locations, in the old review that is permanently public (CG1). **Assigned to
package 4e.**

**What it is:** the login token is a bearer JWT kept in `localStorage`, and
every authenticated call sends it in an `Authorization` header. Any script
running on the frontend's origin can read it. The CSP narrows how such a
script could arrive. It does nothing once one has, and then the token is
stolen outright, valid for its full lifetime (1 hour), from anywhere.

**What fixing it takes.** The fix is to keep the token where script cannot
reach it: an httpOnly, Secure cookie set by the backend. **That changes the
auth flow, and it is not small:**

| Area | What changes | Size, measured at the stack tip |
|---|---|---|
| Backend: issuing | The login-OTP and signup-OTP completions set the cookie instead of returning the token in the body | the auth routes that issue tokens |
| Backend: reading | `authMiddleware`, `adminAuth` and the auth check in `payment.js` read the cookie | 3 readers. `cookie-parser` and `credentials: true` are already in `app.js` |
| Backend: logout | **New endpoint.** Logout is client-side today (delete from storage). An httpOnly cookie can only be cleared by the server | 1 route |
| **CSRF** | **New exposure.** A cookie is sent automatically, so every state-changing route becomes forgeable from another site unless the cookie is `SameSite=Lax` or `Strict`, or the routes check a CSRF token. **The PayU callbacks are cross-site POSTs by design** and must stay outside cookie auth: they authenticate by hash | every POST, PUT, PATCH and DELETE |
| Frontend: storage | Remove every read and write of the token | **23 call sites in 11 files** |
| Frontend: requests | Every authenticated `fetch` sends `credentials: 'include'` instead of a header | 12 `fetch` calls, 7 header sites in 6 files |
| Frontend: "am I logged in?" | Today it is "is there a token in storage" (`App.jsx`). Script cannot see an httpOnly cookie, so the app has to ask the server (`/api/auth/me`) on load | the app's auth state |
| Tests | Every suite that authenticates sends `Authorization: Bearer`. Either the readers accept both during a transition, or the harnesses learn cookies | **6 of the 21 suite files** send an Authorization header |

**The constraint that decides whether it is possible at all: same-site
hosting.** `vercel.app` is on the Public Suffix List, so
`<frontend>.vercel.app` and `<backend>.vercel.app` are **different sites**. A
cookie from the backend is then a **third-party cookie**, which current
browsers increasingly block outright (Safari already does). **With the two
new projects on separate `*.vercel.app` names, SEC-15 cannot be fixed this
way.** It needs either:

- **one custom domain for both** (for example `donate.example.org` and
  `api.example.org`, which are same-site), or
- **the frontend proxying `/api` to the backend** through a Vercel rewrite, so
  the browser only ever talks to one origin.

**That decision is being made now, for a different reason:** the CSP hostname
that keeps post-F (#33) a draft (CB2-1). **Choose the new hostnames with 4e in
mind, or 4e starts by undoing them.**

**Why not inside 4b:** rotating `JWT_SECRET` at the cutover already signs
everyone out, which makes it tempting. But it would add an auth-flow change to
the one window whose length is set by verification (runbook R3). It goes after
4b and stays its own package.

## BRAND-01 (LOW) - THE BRANDING PUT CAN WRITE THE STORAGE FIELDS

Found by an automated review while preparing PR F. **Confirmed by reading the
code. Not yet fixed.**

`PUT /api/admin/branding` copies every field in `branding.WRITABLE`
(`repositories/branding.js`), and that list includes `logoPath`, `logoMime`
and `faviconPath`. Those were meant to be set only by the logo upload.

| | |
|---|---|
| `logoMime` | Sent verbatim as `Content-Type` by the public `GET /api/branding/logo`. An admin can set `text/html`. `nosniff` is set and the file body is a re-encoded image, so getting script out of it is hard. It is still the wrong place to trust input |
| `logoPath` | `resolveWithin()` confines it to the uploads directory, at serve and at delete. So the reach is "any file in uploads". The next upload then **deletes** the file it names as the previous logo |
| Who | Admins only. A compromised admin account is the case |
| Why LOW | Contained to the uploads directory, admin-only, and logo upload does not work on Vercel at all (CB2-6) |

**Fix, proposed and not yet made:** a route-level allowlist for the PUT that
excludes the three storage fields. Map `logoMime` against the upload's accepted
types when serving. Require `logoPath` to match the shape the upload generates
before resolving it. It needs the branding suite, which needs the compose
stack. **Unpinned: Gary's call whether it rides in post-F or a follow-up.**


## CX2 - THE BACKEND HOSTNAME IS CHOSEN: `kindledger-api.vercel.app`

CB2-1 closes. `Frontend/vercel.json`'s `connect-src` names the new backend and
**no longer names the old one**. Keeping both would have let a frontend built
with the old `VITE_API_URL` keep working against MongoDB, which is the silent
misrouting deployment-environment §1.2 describes.

**What is verified and what is not.** On 3 Nov 2026 the name answered
`404 DEPLOYMENT_NOT_FOUND`. That proves nothing is deployed there. It does not
prove the project name is free: Vercel only settles that when the project is
created, and a taken name gets a suffix. **The confirmation is the first step of
creating the backend project, and it comes before the frontend deploys.**

**SEC-15 is not helped by this choice** and was not meant to be: two
`*.vercel.app` names are two sites. Package 4e's `/api` rewrite keeps this host
as the rewrite target, so 4e does not have to start by undoing it.

---

## CQ1 - AUTO-DELETE HEAD BRANCHES CLOSED A STACKED PR UNMERGED

**What happened.** #31 merged into `main` at 10:40:15 on 3 Nov 2026. The
repository deletes head branches on merge, so `stack/e-request-path-leaves-mongo`
was deleted - and it was #32's base. #32 closed, unmerged, at 10:40:18. `main`
was then missing all 62 files of the whitelabel work, and #33 targeted a branch
whose PR was closed.

**The cause was advice, not a mistake at the keyboard.** Turning auto-delete on
before merging #24 was my recommendation. Stacked PRs were the one case where
it does harm, and the stack was exactly what was being merged.

**Repair (CQ1).** `stack/e` restored at `f07435b`, #32 reopened and retargeted
to `main` (62 files, unchanged), #33 retargeted to `main` before #32 merged.
**No rebase was needed or done:** `f07435b` is in #32's history and `main`'s
tree is byte-identical to it, so the retarget alone produces the same diff a
rebase would, without rewriting the commits #33 is built on.

**The rule.** While any open PR targets a branch other than `main`, auto-delete
stays OFF, or every dependent PR is retargeted to `main` before its base merges.
After a merge run, check that no PR ended closed-unmerged. Auto-delete is OFF
now and goes back ON once #33 has merged.

---

## MIG-01 (HIGH) - A MIGRATION THAT FAILS PARTWAY LEAVES A PLAUSIBLE HALF-SCHEMA (CY2)

**Found while testing MariaDB (CX1), and worse than the bug that exposed it.**
`prisma migrate deploy` of the unmodified init migration on MariaDB 11.8 failed
at statement ten, on `REGEXP_LIKE()`. By then the first six tables existed,
`_prisma_migrations` held a failed row, and nothing could undo it: **DDL on
MySQL and MariaDB commits statement by statement.** The database looked nearly
right. A retry would not have fixed it; Prisma refuses to proceed past a failed
migration until it is resolved by hand.

That is the shape this project keeps meeting - ENV-01, ENV-02, BUG-02 - **a
failure that leaves a state which looks like success.** On a shared host where
dropping tables means clicking through phpMyAdmin, it is also an expensive one
to be in.

**Fix, CX1. The defence is ordering, because rollback does not exist:**

1. **Refuse before the first statement.** `npm run db:migrate` runs the guard
   first, and the guard now checks every server property the migration depends
   on: CHECK enforcement, the 0900 collations by behaviour, strict mode in both
   scopes. Every reason the migration could stop partway *because of the server*
   is a reason the guard refuses.
2. **The REGEXP change removes the one statement MariaDB could not run.**
3. **Proved both ways in CI.** `schema-mariadb` asserts the migration applies in
   full (8 tables, 1 finished migration, drift gate clean), not just exit 0.
   `refuse-unsupported` runs `db:migrate` against MariaDB 10.11 and a non-strict
   11.8 and asserts **zero tables** afterwards.
4. **Recovery is written down** (deployment-environment §1.4): drop every table
   including `_prisma_migrations`, then `npm run db:migrate` again.

**What is NOT closed, stated.** `npx prisma migrate deploy` on its own still
skips the guard; the docs say never, nothing enforces it. And a migration can
still stop partway for reasons no pre-check sees - a dropped connection, a
killed process. The guard closes the class "the server cannot run this", not
every class.

---

## CX1 - MARIADB 11.4.5+ IS SUPPORTED. HOSTINGER IS FINAL

Hostinger shared hosting runs MariaDB 11.8 and is the only host available. The
guard refused MariaDB by name on a premise - "no utf8mb4_0900_* collations" -
that MariaDB 11.4.5 made false. ADR-063 records the decision; this records what
was measured against `mariadb:11.8.9` with `mysql:8.4.13` as the reference.

| Area | Result |
|---|---|
| Email collation (c) | `utf8mb4_0900_as_ci` is an alias of `utf8mb4_uca1400_nopad_as_ci`. **22 pairs identical** on both servers, under both collations and through a unique index: jose@/josé@ distinct, case folded, trailing space distinct, Cyrillic homoglyph distinct. Config, not schema |
| CHECK (d) | **One schema change:** MariaDB has no `REGEXP_LIKE()`, so `branding_settings` could not be created. Now the `REGEXP` operator. All 10 CHECK probes then enforce identically. errno differs (3819/4025), read by nothing |
| ENUM, `ON UPDATE`, nullable UNIQUE (d) | Identical |
| Strict mode (d) | Identical except **MariaDB's default admits zero dates**. Accepted (CY1-2), then **closed by DB1**: every application session now runs MySQL 8.4's default `sql_mode`, which includes `NO_ZERO_DATE` |
| Time zone | Not a dependency. Prisma supplies `now()` itself; with the server at +05:30 both stored UTC |
| Schema suite (e) | **30/30 on both.** One assertion changed for a server SPELLING, `bigint(20) unsigned` (CY1-3) |
| Every other suite | **All pass on MariaDB 11.8**, run locally through `npm run test:all` |
| Guard at start (b) | New. On 10.11: every data route and `/api/health` answer 503, the log says why |
| TLS | **Measured: without an SSL parameter Prisma connects in PLAINTEXT**, even to a server offering TLS. `sslaccept=strict` refuses a self-signed certificate; `accept_invalid_certs` encrypts without verifying. Documented as the fallback, never "no parameter" |

### CY1-4 - THE IDLE-TIMEOUT INSTRUCTION WAS BACKWARDS, AND WHY

CX1 asked for "the shortest viable idle timeout". **That is the right answer to a
cap on SIMULTANEOUS connections and the wrong one for Hostinger's cap, which is
PER HOUR.** Under an hourly cap every reconnect is billed, and a short idle
timeout turns one long-lived connection into a new one after every quiet spell.
The reasoning for one limit was applied to the other; they need opposite
settings.

Measured with `connection_limit=1` against mariadb:11.8: 200 queries,
sequential or 50 at a time, used **one** connection; an idle lifetime of 3 s
became **two** across a 5 s pause; 3600 s stayed at one. So:
`PRISMA_CONNECTION_LIMIT=1`, and connections held as long as the server allows.
**DB1 made the second half automatic:** the MariaDB driver's pool keeps a
connection until the server closes it and replaces it before the next query, so
the `PRISMA_MAX_IDLE_CONNECTION_LIFETIME` variable CX1 added was removed again.

### DC1 - CY1-4'S PREMISE DID NOT HOLD FOR THIS ACCOUNT, AND THE SYMPTOM WAS NOT WHAT WAS DOCUMENTED

**There is no hourly cap.** `SHOW GRANTS` on the account carries no
`MAX_CONNECTIONS_PER_HOUR` clause; the 500 came from an example in Hostinger's
help centre, not from this account. CY1-4's reasoning about hourly caps is
correct in general and moot here. Its conclusion - hold connections as long as
the server allows - still costs nothing, and the binding limit is
`max_user_connections = 75` (deployment-environment §1.5).

**The documented symptom was wrong.** It said the log would show the server's
"exceeded" message. Measured with a user capped at two connections: it does not.
The pool waits 10 seconds per query, fails with `pool timeout ... active=0
idle=0`, and the server's `1226 ER_USER_LIMIT_REACHED` reaches only the
driver's logger. **Fixed:** `config/prisma.js` now logs fatal connection errors
with the server's reason, once a minute per instance - and only fatal ones,
because the same hook also receives every ordinary query error (measured: a
duplicate key and a CHECK refusal both arrived there).

**DC1 is accepted (DF2, 4 Nov 2026), and the logging fix is the valuable
part.** The connection ceiling is the failure mode most likely to take this
site down, and before the fix it was **unattributable**: the database gave a
specific reason, `1226 ... max_user_connections`, and the log showed a vague
pool timeout that reads as a network fault or a slow host. It is the AP4 shape
(below) arriving in production instead of in a test, and it is in AP4's table
now. The instinctive response to a pool timeout - a larger pool, a longer
timeout, a retry - would have made it worse: each one asks the server for
more of the 75 it has already refused.

### CY3 - STRICT MODE IS THE GO/NO-GO, AND WHAT EACH ANSWER MEANS

On shared hosting only the provider can set `sql_mode`, and Prisma 6 cannot set
it per connection. So Hostinger's `@@GLOBAL.sql_mode` decides this, and nothing
in this repository can change the answer. *[Wrong about Prisma: its own engine
cannot, but its MariaDB driver adapter can. DB1 below.]*

**If it contains `STRICT_TRANS_TABLES`:** proceed. The guard passes, CX1 ships.

**If it does not, the guard refuses and the site does not run.** That is
correct, and here is what the refusal is preventing - measured on mariadb:11.8
with `sql_mode=''`, through the application's own write path:

| Write | Non-strict result |
|---|---|
| A hand-written INSERT with `payment_status='banana'` | **Stored as `''`. Matched by no status filter. BUG-02 by configuration, exactly** |
| Prisma create/update with an out-of-set enum | Refused by Prisma's own validation before any SQL is sent |
| A 200-character donor name (column 120) | **Silently stored as 120** |
| PayU's error text, 1500 characters (column 1000) | **Silently cut to 1000** |
| A quantity of 5,000,000,000 | **Silently clipped to 4,294,967,295** |

Every application and ETL write goes through Prisma's typed API, so the enum
case is reachable only by hand-written SQL - phpMyAdmin, a one-off script. That
narrows it; it does not close it, and the truncation and clipping rows are
reachable by the application itself, silently. **The options, none of them
configuration:**

1. **Ask Hostinger to make the account's server strict.** The only fix that
   keeps the guard as it is.
2. **A host that allows it** - a Hostinger VPS, where `sql_mode` is yours.
3. **Run on a non-strict server knowingly.** That means changing the guard to
   accept it, adding length and range validation for every column the
   application writes, and accepting that hand-written SQL can recreate BUG-02.
   That is a decision, not a fix, and it would need recording as one.

**OUTCOME: Hostinger is not strict, Gary chose 3 - and DB1 found a fourth
option that makes 3 unnecessary on the application path.** See DB1 below.

---

## DB1 - SOLVED ON THE APPLICATION PATH: HOSTINGER'S GLOBAL `sql_mode` IS NOT STRICT, AND THE APPLICATION NO LONGER DEPENDS ON IT

| | |
|---|---|
| **Was** | An accepted risk, Gary, 3 Nov 2026: Hostinger shared hosting is the only host available, and only the provider can set `sql_mode` there |
| **Status** | **SOLVED for every write the application makes** (DF1, 4 Nov 2026). Not an accepted risk any more. The application sets strict mode itself, per connection, and the guard refuses if that ever stops working |
| **What is left** | **Out-of-band SQL only** - phpMyAdmin, a hand-run session, a tool with its own client. Open, pinned in CI, mitigated by procedure (DB3 below) |
| **Removed by** | Nothing in this repository can make Hostinger's server strict, so the out-of-band residual closes only when the database leaves shared hosting (`docs/roadmap.md`). Strict mode is **not** a reason for that move any more; the residual closes as a side effect of it |

### Before building workarounds, the question DB1 asked: can the application set it per session?

**Yes, and it was proved by behaviour** against a mariadb:11.8 whose GLOBAL
`sql_mode` was `''`:

| Mechanism | Result |
|---|---|
| A `sql_mode` in the connection string - four spellings | **Ignored.** Prisma's own engine runs no SQL on connect |
| Prisma's MariaDB driver adapter, `initSql` on every new connection | **Works.** Session strict on the first connection, on the one replacing a KILLed connection, and on the one replacing a connection the server closed at `wait_timeout`. A hand-written `payment_status='banana'` was **refused (1265)** each time, with no failed query across the reconnects |

So `config/prisma.js` now builds the client on that adapter, and every
connection it opens runs MySQL 8.4's default `sql_mode` and UTC. **DB2's
boundary validation was not built, and should not be**: the database itself now
refuses, for every write the application makes, which is stronger than a
re-statement of the schema's limits in route code that could drift from them.
CY3's truncation and clipping rows - the ones the application itself could
reach - are refused by the same mechanism.

**Proved again in CI** (`refuse-unsupported`): on a non-strict 11.8,
`db:migrate` proceeds with the warning, and the application's own invalid write
is refused.

### What the guard does now

- Unsupported version or missing collations: **still REFUSES.**
- The application's own SESSION not strict: **still REFUSES** - it would mean
  `initSql` did not take, and every write would be exposed.
- The server's GLOBAL not strict: **WARNING** on every cold start, naming what is
  not enforced. A warning and not a refusal because the GLOBAL now governs only
  out-of-band SQL, which the application cannot refuse on anyone's behalf.

### DB3 - WHAT IS STILL UNPROTECTED, PLAINLY: OUT-OF-BAND SQL, OPEN

| Writer | Covered? | How it is held |
|---|---|---|
| The API, every route | **Yes** | strict session; CI proves the refusal |
| The ETL (`npm run etl`, `etl:null-minted`) | **Yes** - it uses `getPrisma()` | `server-guard.test.js` "DB3": fails if any source file builds its own `PrismaClient` |
| `npm run db:seed` | **Yes** - moved onto `getPrisma()` in DB1 | same test |
| A future admin import, if it uses `getPrisma()` | Yes | same test, which fails if it does not |
| **phpMyAdmin, a hand-run SQL session, any tool with its own connection** | **NO** | **Pinned in CI:** an outside client's `'banana'` is stored as `''` on the non-strict server, and the job asserts it. If Hostinger ever becomes strict, that step fails and this row can close |

The last row is the residual, **and the only part of DB1 still open**. It is the
BUG-02 shape exactly: a donation in the table and in no report. The mitigation is procedural - **write nothing by
hand**, and if a correction must be made, `SET SESSION sql_mode =
'STRICT_TRANS_TABLES';` first in the same SQL tab (deployment-environment §1.5).

---

## DB4 - TLS WAS AVAILABLE AND OPTIONAL. THE APPLICATION NOW REQUIRES IT

Hostinger reports `have_ssl = YES` and `require_secure_transport = 0`: TLS
works, and the server accepts plaintext too. CX1 measured that a
`DATABASE_URL` without an SSL parameter connects **in plaintext**, and only
documented it. **DB4 enforces it:** the guard reads `Ssl_cipher` on the
application's own connection and refuses if it is empty, for any host that is
not loopback, RFC 1918, IPv6-local or a single-label service name. A dotted name
counts as public even if it resolves privately - fail closed.

Measured from a host the guard treats as public: no parameter **refused**;
`sslaccept=strict` encrypted (and accepted MariaDB 11.8's own self-signed
certificate - MariaDB 11.4+ clients can verify it against the account's
password; **interception was not tested**); `accept_invalid_certs` encrypted
without verification.

---

## DF3 - MERGING #33 DEPLOYED THE BACKEND TO PRODUCTION, WITH NO VARIABLES

#33 said "merging deploys nothing". By the time it merged that was false: the
`kindledger-api` project had been connected to the repository, with `main` as
its production branch. Checked on Vercel, 4 Nov 2026:

| | |
|---|---|
| Deployment | `dpl_58VuwRuDSBzMohnN5oQLf5nuQ2vF`, commit `824fef4` (the #33 merge), target **production**, state **READY**. The build passed: `prisma generate` only, no database contact |
| Variables on the project | **None**, in any environment |
| What it serves | `kindledger-api.vercel.app` is public (deployment protection excludes the production domain). **Every path answers 500 `FUNCTION_INVOCATION_FAILED`** |
| Why | `config/jwt.js` throws on load with no `JWT_SECRET`, so the process exits before any route exists. It never reached the database |
| Harm | **None found.** Nothing writes, nothing connects, no secret is involved, and nothing points at this URL yet: donors are still on the old backend (§8 of deployment-environment) |

**This is fail-closed, and it is what should happen.** The risk is the next
step, not this one. Production is pinned to `824fef4`, which is **pre-#38**: no
request-time server guard, no strict session, no TLS refusal, no `1226` log
line. If the variables are added and that deployment is **redeployed**, it boots
- and connects to Hostinger without any of DB1, DB4 or DC1. Recorded in
deployment-environment §8: **the first deploy with variables must be #38's
merge, not a redeploy.**

---

## DH1 - THE FIRST DEPLOY WITH VARIABLES: WHAT IT SHOWED (10 Nov 2026)

#38's merge deployed `182a23e` to production (`dpl_DGtCDa81aKVbF6BAeU8x6mRPAK1V`,
READY), the first deploy with variables. Read from the live URL and its
runtime log:

| Check | Result |
|---|---|
| `/api/health` | **503 after 10 s**, `{"status":"unavailable"}` |
| Data routes | 500 after 20 s (two queries, each waiting the 10 s pool timeout) |
| Why | **`[prisma] the database refused a new connection: -3008 ENOTFOUND getaddrinfo ENOTFOUND srvNNNN.hstgr.io`**. The `DATABASE_URL` on the project holds deployment-environment §1.4's **placeholder** hostname, not Hostinger's |
| `[serverGuard] ... supported`, the GLOBAL `sql_mode` warning | **Absent**, correctly: no connection, so no verdict. An unreachable server is not cached and not refused (ADR-039) |
| `[rateLimiters] store=redis` | **Present** |
| `db:migrate` | **Not run.** `DATABASE_URL` is Sensitive on Vercel, so it cannot be read back, and with a placeholder host there was nothing to migrate against. The guard runs before any DDL, so a run against this URL could not have left a partial schema |

**DC1's log line paid for itself on the first request.** Without it the log
would show only `pool timeout ... active=0 idle=0`, which reads like the
connection ceiling or a slow network. With it the cause was the first line.
(It says "refused" for a DNS failure. The wording is DC1's and is broader than
the case; the code it carries is what to read.)

The same log carried three things nobody had seen in CI, because CI never runs
the limiters against Redis. Two are defects; one is not.

### RATE-01 (Medium) - every limiter shares one Redis store, so they all get the LAST limiter's window

`config/rateLimiters.js` hands **one** `RedisStore` to every limiter.
`rate-limit-redis`'s `init()` does `this.windowMs = options.windowMs`, and its
increment script sets each new key's expiry from that one field. The last
limiter to initialise sets the window for all of them. Module-load order is
`authLimiter` (60 s), `resetAttemptLimiter` (15 min), `paymentInitiateLimiter`
(60 s), so **every key expires after 60 seconds.**

**Proved, not inferred:** the real `rate-limit-redis` 6.0.1 and
`express-rate-limit` 8.7.0, wired as `createLimiter` wires them, with a stub
`sendCommand` recording what reaches Redis. A reset-attempt key goes out as
`EVALSHA sha 1 rl:reset-attempt:addr:x 60000` - **60,000 ms, not 900,000.**

**The consequence:** AQ1's per-address reset cap is 5 guesses per **minute**,
not per 15 minutes - about 75 per code lifetime instead of 5. The cap's main
job (the response is uniform, so the count is not an oracle) still holds; its
rate does not. `express-rate-limit` says so itself: `ERR_ERL_STORE_REUSE` in
the production log. **Invisible without Redis**, because each limiter then
builds its own MemoryStore. The comment above `createLimiter` ("every limiter
shares one store instance ... kept apart by key prefixing") is right about the
keys and wrong about the window.

**FIXED (DJ1):** one `RedisStore` per limiter, on the one shared connection.
Keys are unchanged; each limiter's `name` already kept them apart.

### RATE-02 (High for availability) - one Redis timeout at cold start breaks every limited route on that instance

`init()` stores the `SCRIPT LOAD` promise. If it rejects (the pdx1 cold start
at 09:44 logged `async error during store initialization. TimeoutError` three
times), it stays rejected: every later `increment` awaits it and re-throws, and
the only retry path is a `NOSCRIPT` reply, which never comes.
`passOnStoreError` is false, so each request errors.

**Proved with the same stub:** Redis times out once, during init, and is
healthy afterwards. Three requests to a limited route: **500, 500, 500.**

**The consequence:** on an affected instance, login, signup, the OTP routes,
password reset and **donation initiation** answer 500 until Vercel recycles
the instance - with Redis healthy the whole time. It looks intermittent for
the same reason DC1 does: only some instances are affected.

**FIXED (DJ1):** the store remembers `init()` instead of running it once. A
failed one is forgotten, and the next request runs it again before counting.
Only the library's public store methods are used.

**Not changed, and DECIDED (DK3, Gary, 10 Nov 2026): fail closed.** While Redis
is unreachable, a limited request is **refused** (500), not let through
uncounted. **Why:** these are login, signup, password reset and donation
initiation, and a limiter that failed open could be switched off by anyone
able to make Redis unreachable - it would disable itself exactly when attacked.
The test "PINNED, A DECISION" holds it; changing it is a change of decision.

### DK3 - a comment described behaviour the code never had

`config/rateLimiters.js` said that if the Redis connection never succeeded,
"the limiter fails open on that request rather than taking the process down".
**It never failed open**: `passOnStoreError` was always off, so the request was
refused. ADR-042's "the limiter degrades instead" was read the same way. Both
are corrected; the ADR is amended rather than rewritten.

**The same class as SEC-19's vacuous test** (CM1, row D): there, a test's regex
matched a *comment* saying the leak was removed, so it passed whether or not
the code was fixed. Here a comment asserted a security property - and the
opposite one - that nothing checked. In both, prose about the code was
standing in for the code. The remedy is the same: a test that exercises the
behaviour. The fail-closed behaviour now has one, and the comment cites it.

### RATE-01 and RATE-02: proved broken, fixed, proved fixed

`test/rate-limiter-redis.test.js` replaces only the `redis` client, through
`require.cache`, with an in-memory Redis that answers rate-limit-redis's two
scripts on a clock the test controls. Everything above it is real:
`config/rateLimiters.js`, rate-limit-redis, express-rate-limit, mounted on
routes, created in production's order. The assertions are HTTP status codes.

| Test | Before the fix | After |
|---|---|---|
| RATE-01: the reset cap still refuses 61 s after it refused | **200** (expected 429) | 429 |
| RATE-01: the login window is still 60 s | pass | pass - guards against giving every limiter 15 minutes |
| RATE-02: Redis down at start-up, then back: three logins | **500, 500, 500** | 200, 200, 200 |
| RATE-02: after recovering, the sixth login is 429 | **500 ×6** | 200 ×5, then 429 - recovery is not a bypass |
| PINNED: Redis down, a limited route is refused | pass | pass |

**2/5 before, 5/5 after.** Mutations checked: removing the retry fails both
RATE-02 tests; sharing one store again fails RATE-01.

### How they were found, and why nothing earlier could

**Only a real Redis shows either one.** Every suite, CI and local alike, runs
without `REDIS_URL`, so each limiter builds its own MemoryStore - its own
window, and no scripts to fail to load. The first production log carried
`ERR_ERL_STORE_REUSE` and the start-up `TimeoutError` within an hour of the
first deploy with variables. **The same class as CM1's** "three of the five
passed only inside the api container": the configuration the suites exercised
was not the one that ships, so green meant "green in an environment nobody
deploys". The new suite runs the Redis configuration on every CI run.

### Not a defect: `ERR_ERL_KEY_GEN_IPV6`

A false positive. `express-rate-limit` checks the keyGenerator's **source text**
for `req.ip` without `ipKeyGenerator`. Ours passes `req.ip` to `keyFor()`, which
calls `ipKeyGenerator` (ADR-048). The collapse is asserted by `keyFor`'s own
test. Leave it, or silence that one validation with a comment saying why.

### Also found on the project

- **`SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL` and `NOTIFY_URL` are not set.**
  Without them `/api/payment/initiate` builds a form with no `surl`, `furl`,
  `curl` or `notify_url`, which PayU rejects (FAILS LOUD, deployment-environment
  §2.1; not yet observed, since no donation has been attempted). No sandbox
  donation can complete until they are set.
- **Twelve of the fourteen variables target Preview as well as Production.**
  Recorded as **DEPLOY-02**, below.
- **Four secrets are `encrypted`, not `sensitive`** - `JWT_SECRET`,
  `HEALTH_DIAGNOSTIC_SECRET`, `EMAIL_PASSWORD`, `PAYU_MERCHANT_KEY` - so the
  dashboard can reveal them (Vercel flags them `readable-secret`). §6 says
  Sensitive. The salt is `encrypted` too.

---

## DEPLOY-02 (High, deployment) - production secrets were given to every branch preview

**Found 10 Nov 2026 (DH1). Corrected on the project by Gary (DJ2).**

Twelve of the fourteen backend variables targeted **Preview** as well as
Production: `JWT_SECRET`, `HEALTH_DIAGNOSTIC_SECRET`, `PAYU_MERCHANT_KEY`,
`PAYU_MERCHANT_SALT`, `PAYU_BASE_URL`, `EMAIL_USER`, `EMAIL_PASSWORD`,
`EMAIL_SERVICE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` and `REDIS_URL`. Only
`DATABASE_URL` and `PRISMA_CONNECTION_LIMIT` were Production-only.

**Why it matters.** With Git connected, Vercel builds a preview of **every
branch** pushed to the repository, and a preview runs that branch's code with
the Preview variables. So any branch could:

- **sign tokens production accepts** - `JWT_SECRET` is the key to every
  session;
- **build and verify PayU hashes** with the real salt, which is the only thing
  that tells a genuine payment callback from a forged one (SEC-01);
- **send mail as the organisation**, with the mail password;
- **share production's rate-limit counters** through the shared `REDIS_URL`
  (DEPLOY-01), so testing a preview spends production's login budget, or the
  reverse.

What limited it: `DATABASE_URL` was Production-only, so a preview had no
database and failed closed; and the PayU values were still the sandbox's
(DI1). Neither is a control. Both were luck about which variables happened to
be unticked.

**Why an installer hits it.** **On this project Preview ended up ticked unless
someone unticked it**: every one of the twelve was added in the dashboard and
arrived on Preview (none on Development), and the Redis integration put
`REDIS_URL` on Preview without asking. *Corrected 10 Nov: this entry first said
the form ticks all three environments by default. None of the fourteen
variables targets Development, so that was not what happened here; what was
observed is stated instead.* Following the guide without being told
otherwise produces exactly this. deployment-environment §6 said "Production
only" since DF4, as a callout; it now gives the reasons and says how to check.
Recorded in the self-hosting notes too (Phase 6 checklist §5.6), because every
NGO deploying to Vercel gets the same default.

**Being corrected (DJ2, DK1), and the first pass made it worse (DEPLOY-03).**
Read from the project at 10:18 UTC, 10 Nov: nothing unticked yet; the four new
callback URLs added with Preview ticked; and after the edit that corrected
`DATABASE_URL`'s host, it **targeted Preview too**, so previews would get the
donor database - the one variable that had been Production-only. Git is connected, so the next branch
push builds a preview with all of it. **Pushes are held until Preview is empty.**

**Closes when** the project's Environment Variables page, filtered to Preview,
lists nothing. Read back from the API, not assumed.

---

## DEPLOY-03 (High, deployment) - the correction made it worse: editing a value put the donor database on Preview

**Found 10 Nov 2026 (DK2).** The first fix for DEPLOY-02 was correcting
`DATABASE_URL`'s placeholder host. **After that edit, `DATABASE_URL` targeted
Production and Preview** - read from the API, with `updatedAt` matching the
edit. Before it, it was Production-only: **the one variable on the project
that had been right.** Git was connected, so the next branch push would have
built a preview holding the donor database's credentials, running whatever
code that branch carried.

**What is known, and what is not.** The API shows the result, not the click.
Whether the edit form re-applied a Preview default or Preview was ticked during
the edit cannot be told from here, and Vercel's documentation does not describe
the form doing it. **The conclusion does not depend on which:** an environment
setting that does not reliably survive an edit to an unrelated field - the
value - **cannot be set once and trusted.** It has to be re-checked after
every edit, and it has to be checked by reading it back, because the person
making the edit was fixing the host and had no reason to look at the
environments.

**Same shape as AP4's**, one layer out: a correct change to one thing
produced a wrong state somewhere nobody was looking.

**Recorded where installers will see it:** Phase 6 checklist §5.3a and
deployment-environment §6 now say re-check the Preview filter **after every
edit**, not once at setup, and give the CLI (`vercel env add ... --environment
production`, `vercel env ls --environment preview`) as the way to set and
audit it explicitly. **Held in this repository's practice:** no branch is
pushed to the Git-connected project until the Preview filter has been read back
empty.

**Closes with DEPLOY-02**, when Preview lists nothing after the last edit.

---

## DJ4 - `docker-compose.yml` no longer requires `ADMIN_CREATION_KEY`

It was `${ADMIN_CREATION_KEY:?...}`: the stack refused to start without it, so
every Compose install carried a **live admin-creation key on the public signup
endpoint, permanently** - the opposite of deployment-environment §2.4 and of
`docs/first-run.md`, which set it once and remove it. Now
`${ADMIN_CREATION_KEY:-}`: unset or empty is the normal state.

**Proved by behaviour:** `docker compose config` with no key at all - before,
`required variable ADMIN_CREATION_KEY is missing a value`, exit 1; after, it
renders `ADMIN_CREATION_KEY: ""` and exits 0.

**What makes empty safe is pinned:** `auth-characterisation` "DJ4" asserts that
an empty or unset key refuses admin signup with 403 and writes nothing - **even
when `adminKey` is empty too**, the case a check written as
`adminKey === key` would accept - and that the matching key still works, since
first-run depends on it. Nothing asserted the refusal before.

---

## DM1 - THE PRODUCTION SCHEMA IS INSTALLED (10 Nov 2026)

Gary ran `npm run db:migrate` against Hostinger: `20260910120000_init` applied,
the drift gate clean (structural diff, 6 CHECK constraints, the email collation,
7 tables on `utf8mb4_0900_ai_ci`, 5 maintained `updated_at` columns), and the
GLOBAL `sql_mode` warning as expected. The database password was rotated
afterwards and updated on Vercel.

Read from production after #40 deployed (`dpl_6UFbo3nHtktiQWNmtDRabE31hbQn`,
`7be5544`):

| Check | Result |
|---|---|
| `/api/health` | 200 |
| `/api/categories` | 200, `[]` - an empty install |
| `/api/branding` | 200, the default row: `"Your Organisation"`, `INR`, everything else null |
| Boot log | `[serverGuard] MariaDB 11.8.9-MariaDB-log supported`, the GLOBAL warning, `[rateLimiters] store=redis`. **No `ERR_ERL_STORE_REUSE`**: RATE-01's fix is live. `ERR_ERL_KEY_GEN_IPV6` remains, the known false positive |

## DM2 - WHAT THE FIRST HAND INSTALL FOUND

**(a) `npm ci` no longer generates the Prisma client.** npm blocked Prisma's
install scripts (allowScripts), so the client was never generated and every
`npm run db:` command failed with `MODULE_NOT_FOUND`. CI and Vercel both run
`npx prisma generate` explicitly, so only a hand install could hit it - ADR-049's
class, inverted: green in every automated environment, broken for a person.
`docs/first-run.md`, the README quick start and runbook §1.9 now carry
`npx prisma generate` explicitly; Phase 6 checklist §5.1a explains why.
*Not done, and worth considering:* making the `db:` scripts run `prisma
generate` themselves would remove the step instead of documenting it.

**(b) Installing from a OneDrive-synced folder** gave `EBUSY` file locks in
`node_modules` and an incomplete install. Windows often puts `Documents` inside
OneDrive. In the self-hosting notes (§5.1a) and first-run.

**(c) The `ck_probe` "error" was the guard working, and it no longer looks
like a failure.** The guard proves CHECK constraints are enforced by inserting
a violating row; the server's refusal *is* the proof. But the guard uses the
application's Prisma client, which logs every query error, so a supported
server printed `prisma:error ... CONSTRAINT ck_probe failed` above `Database
server OK`. **Reproduced locally on MariaDB 11.8.9 and MySQL 8.4.13.**

- **Fixed:** the probe now uses `INSERT IGNORE` and counts rows. Measured on
  both servers, strict session or not: a CHECK-violating row is skipped with a
  warning and nothing is thrown. Zero rows means enforced.
- **Test:** both CI "Server compatibility guard" steps now assert a supported
  server prints `Database server OK` and no `prisma:error`. That fails on the
  old code on both servers and passes on the new one, run locally verbatim.
  **Mutation checked:** with the probe table's constraint removed - a server
  that ignores CHECKs - both servers are **refused** (`accepted a CHECK
  violation`, exit 1). The new assertion caught my own first attempt, which
  named the count `stored`, a reserved word in MySQL 8.
- **Found beside it, and fixed:** when the probe could not run, the guard said
  `note: ... could not run` and then `Database server OK (CHECK constraints
  enforced ...)` - claiming what it had just failed to check. It now says
  `CHECK enforcement NOT confirmed`. Not blocking a supported server on a probe
  that cannot run is unchanged; it was a deliberate choice.

### Measured, not acted on: the pool's validation ping sits at its own timeout

The production log showed `ER_PING_TIMEOUT` on the request after a cold
start's first. The MariaDB driver pings a connection idle for over 500 ms
(`minDelayValidation`) before reuse, with a **250 ms** `pingTimeout`. Measured
from outside on `/api/categories`: back to back, about **0.5 s**; two seconds
apart, about **0.75 s**. So the ping costs about 250 ms and usually succeeds -
**it sits at the edge of its own timeout**, and when it goes over, a healthy
connection is discarded and rebuilt (TCP, TLS, auth, `initSql`), which is the
occasional ~2 s request. **Candidate:** a longer `pingTimeout` (it cannot be
set from `DATABASE_URL` today). Not changed: it is a latency trade-off, and
`wait_timeout = 20` means validation is what keeps a server-closed connection
from failing a request (DB1).

---

## CP1 - EMAIL: RESEND FIRST, SMTP AS THE FALLBACK, NEITHER REFUSES

**What changed in `config/email.js`:**

| | |
|---|---|
| **Resend** | Used when `RESEND_API_KEY` is set, with `EMAIL_FROM` (an address on a domain verified in Resend). One `POST /emails` over `fetch` - no SDK - with the `User-Agent` Resend requires (it answers 403 without one). `RESEND_BASE_URL` exists only so the suite can point it at a local server |
| **SMTP** | The fallback, unchanged: `EMAIL_SERVICE=gmail` or `SMTP_*`, as `EMAIL_USER`. `EMAIL_FROM` is optional here |
| **Neither** | **The module refuses to load**, so the API does not start, and the error names both options. Before, it started, defaulted to `smtp.gmail.com` with no credentials and failed each login separately |
| **Contract kept** | Sends never throw: `{ success, messageId }` or `{ success: false, error }`. `/login` still answers 500 when its code cannot be sent; the SEC-08 paths stay fire-and-forget |
| **CB2-9** | The organisation name comes from branding in the sender, greetings, sign-offs and footers of all four emails; branding unreadable falls back to the default row's name rather than failing a login code. The two pieces of ocean-specific copy (the wave emoji in two headers, "a difference for our oceans") went with it |
| **Header safety** | The name in `From:` has CR, LF, quotes and angle brackets removed: a branding name cannot add a header |

**Proof:** `test/email-transport.test.js`, 11 tests, against a fake Resend over
HTTP and SMTP on a closed port - **8 failed on the old module, 11 pass on the
new.** Mutation-checked: removing the header sanitising, preferring SMTP over
Resend, and removing the refusal each fail exactly their test.

**What the refusal cost elsewhere, and how it was paid:** every app-booting
suite now sets `require('./support/email-off')` - SMTP to `127.0.0.1:1`, which
refuses at once - and the compose stack CI starts for `trust-proxy` gets the
same in its `.env`. Before, those suites set nothing and every send went out to
`smtp.gmail.com`. Local runs against MySQL 8.4 and MongoDB: `auth-char` 25/25,
`auth` 6/6, `admin` 22/22, `signup-timing` 8/8, `password-timing` 6/6 -
unchanged counts.

**The first CI run caught two boots I had missed**, because I listed only
files that `require('../app')`: `migration-state`'s PAY-02 test boots `app.js`
in a **child process** (which inherits the environment), and
`refuse-unsupported` boots it from a **CI shell step** to prove MariaDB 10.11
gets 503. Both refused to start - the refusal working, in a place that had not
configured a transport. Both now do; the 10.11 step was reproduced locally
(503, 503, 503) and `migration-state` passes 11/11. The search that finds them
is for `app.js` in any form, including `node -e` and child-process scripts.

**Production needs nothing:** it has `EMAIL_USER`/`EMAIL_PASSWORD`, so it
selects SMTP exactly as before. Switching to Resend is two variables
(deployment-environment §6, rows 37-38) and a verified domain.

## DQ1 - THE FOOTER IS ONE LINE

The copyright and "Powered by [GitHub mark] KindLedger Donation System" share
one centred, wrapping line, joined by a middot shown from `md` up; below that
they stack as two lines, so a wrapped footer never leaves a dot at a line end.
`footer_text` stays its own line (SPEC-5 §5.2). `PoweredBy` is still prop-less,
with no configuration surface. **Measured in a browser** at 1280, 768, 375 and
320 px with a real name and a ~90-character one: no page overflow, nothing
clipped, and the attribution never splits. One line at 768 px and above for a
name the length of the current one.

**Found beside it:** the frontend lint has never been able to run - LINT-01,
below.

---

## LINT-01 (High, for what it hid) - THE FRONTEND LINT HAS NEVER RUN, AND NOTHING SAID SO

**Found 10 Nov 2026 (DQ1), recorded DS1.** `npm run lint` in `Frontend/` dies
before reading a file: `ERR_PACKAGE_PATH_NOT_EXPORTED ... './config' is not
defined by "exports"`.

**Why.** The toolchain is half-upgraded. `eslint.config.js` is written for
ESLint 9 - it imports `defineConfig` and `globalIgnores` from `eslint/config`,
uses flat-config `extends`, and asks for `reactHooks.configs['recommended-latest']`
- and `@eslint/js` is already 9.x. But `package.json` pins `eslint ^8.57.0` and
`eslint-plugin-react-hooks ^4.6.0`, neither of which has those.

**Why nobody noticed.** No workflow touches `Frontend/` at all: no lint, no
build. A check that was configured, could never run, and whose absence was
invisible because nothing reported it - **CI-01's class exactly**, one
directory over. CI-01's "N/N green" meant nothing for MySQL; the frontend has
no N at all.

### What it hid: two pages that crash on render, one of them linked from the admin menu

Running the existing config on ESLint 9 (measured below) flags `no-undef` in
two files. **Both reproduced** in a production build of `main`, under an
admin-role token planted client-side (the API was not involved):

| | Page | Error on render | Since | Reached from |
|---|---|---|---|---|
| **FE-02 (High)** | `/donations`, the admin donations list | `ReferenceError: useBranding is not defined` - the hook is called, never imported | `6566b41`, SPEC-5 5.4, which replaced the hardcoded name | **The admin navbar (twice) and the admin dashboard.** Production serves this code: an admin opening Donations gets a crashed page |
| FE-03 (Low) | `/admin/categories` | `ReferenceError: ConfirmModal is not defined`; `deleteModal`, `setDeleteModal` and `confirmDelete` are never defined either | `e11a09e`, the first commit | Nothing links to it. The working pages are `/admin/categories-list` and `/admin/add-category` |

**Lint understates it.** `no-undef` caught `deleteModal`, not `ConfirmModal`:
an undefined JSX component needs `react/jsx-no-undef`, which this config does
not load. The page crashed on the component first.

### The fix, sized

| Option | Change | Verdict |
|---|---|---|
| **Upgrade to ESLint 9** | `eslint ^9`, `eslint-plugin-react-hooks ^5.2` in `package.json`. **The config stays as written** | **The smaller change.** Measured: `eslint.config.js` loads unmodified on ESLint 9.39.5 with react-hooks 5.2.0 |
| Rewrite the config for ESLint 8 | Drop `eslint/config`, `defineConfig`, `globalIgnores` and flat `extends`; wire the hooks plugin by hand; downgrade `@eslint/js` to 8 | More change, onto a major version that is no longer maintained |

**It does not pass on the current code - it surfaces a backlog.** On ESLint 9,
45 files: **17 errors and 8 warnings in 14 files.** `no-unused-vars` 12,
`no-undef` 4 (FE-02 and FE-03 above), `react-refresh/only-export-components`
1, and `react-hooks/exhaustive-deps` 8 warnings. The unused variables are dead
code (unused `err` in catches, an unused `getHeaders`, state never read); the
hook warnings are effects that call a fetch function they do not list.

**Plan, as its own PR:** fix FE-02 and FE-03 first (FE-02 is one import);
upgrade the two packages; clear the 17 errors; decide the 8 warnings case by
case; and **add a CI job that runs `npm run lint` and `npm run build` in
`Frontend/`**, so the next breakage is reported rather than discovered.

---

## DW4 - FOUR PR DESCRIPTIONS WERE WRONG, AND STAYED WRONG, BECAUSE NOBODY RE-READ THEM

Found 10 Nov 2026, rewriting every PR description in plain English. The first
three were accurate when written, became false when the facts changed, and
were never re-read. The fourth was my own error in the first pass of the
rewrite, caught by re-reading it against the record before it was relied on:

| PR | It said | What was true |
|---|---|---|
| #33 | Merging deploys nothing | The hosting project had been connected to the repository by then; the merge deployed the backend to production (DF3) |
| #9 | The licence change, as settled | It was withdrawn later the same day; the licence became Apache-2.0 in #31 |
| #11 | A unique index on PayU's payment id closes replayed callbacks | A later commit on the same branch withdrew that: the field is not covered by PayU's signature, so the index is an integrity check only |
| #13, #15-#23 | (as first rewritten) their checks had passed | Their checks were **red** - the database jobs could not start (CI-01) |

**The class:** a statement written once and left alone while the facts under it
moved. It is the same failure as the map carrying two contradictory sequences
("Map maintenance: a sequence stated twice is a sequence that will contradict
itself") - a document that is not re-read when its subject changes is not
documentation, it is history that looks current. The rewrite corrected all
four; each corrected description says what changed.

**And my own slip, which belongs here:** publishing the rewritten #31 was
chained to the step that scanned it for internal IDs, so it went out before
I read the scan. The one hit was a false positive (a measurement, "3.6 ms"),
so nothing wrong was published - **by luck, not by the check.** A check whose
result is not read before acting is the occupied slot in miniature. #28 and
#30 were scanned, read, then published.

---

## DI1 - PAYU IS ON TEST MODE DELIBERATELY: TRACKED, NOT A FINDING

**State (10 Nov 2026):** `PAYU_BASE_URL=https://test.payu.in`, with the sandbox
key and salt. **Gary's choice, for end-to-end testing.** This is not ENV-02:
ENV-02 was the sandbox reached by accident, through a default. This is the
sandbox chosen, named and dated.

| | |
|---|---|
| **Trigger to switch** | The frontend works end to end against the sandbox: a donation from the donor app completes, the callback is verified and the admin list shows it |
| **The switch** | All three values together: `PAYU_BASE_URL=https://secure.payu.in`, the production `PAYU_MERCHANT_KEY`, the production `PAYU_MERCHANT_SALT` |
| **Then** | Redeploy (variables reach only new deployments), then one real donation of the smallest amount, **confirmed in the bank** (Phase 6 checklist §5.3) |
| **Closes when** | That donation is seen in the bank account |

**The three values change together, or the result is a hash failure that
points at correct code.** A production salt with the test URL, or the reverse,
fails hash verification - at PayU, or at our callback as `invalid_hash` - and
the hashing code is correct. The same shape as PAY-03 and AP4: the fix is the
variables, never `verifyHash`.

**While on test mode, PAY-03 applies:** the sandbox truncates `firstname` to
20 characters and signs the truncated value. **Keep test donor names under 20
characters**, or run the one long-name payment PAY-03 asks for, deliberately.

---

## Counts

| State | Count | Rows |
|---|---|---|
| Closed | 38 | 6 in 3.1, 8 in 3.2, 15 in 3.3 (incl. BUG-10/11/12, ETL-01), 9 in AS7 (incl. ADMIN-01, SEC-10's sixth copy) |
| Open, assigned to a Phase 3 package | 13 | 3.1: 1 (non-atomic reorder), **3.4: 12** (incl. PAY-01, U-2's design half, and BUG-04's cron), 3.5a: 1, 3.6: 1 |
| Open, assigned to Phase 4 / 5 / 6 | 14 | P4: 7, P5: 6, P6: 1 |
| **Open and unassigned** | **5** | U-1, U-3 .. U-6. **U-2 was re-homed to 3.4 by AT2** after the package holding it ceased to exist |

**3.5 IS GONE FROM THIS TABLE, and that is the change worth noticing.** Its eight
rows did not move - they closed, except BUG-04's cron declaration which is a
deployment change. A package disappearing from a count is normally a sign rows
were dropped; here the AL3 grep is what proves they were not.

These are ROW counts, not distinct findings. An item like SEC-19 that spans five
route files appears five times, once per owning package - deliberate, because
each is a separate unit of work with separate verification, and a single row
would let four of the five be forgotten.

DEF-01 appears as U-1 and is cross-referenced from Phase 6; it is counted once,
under unassigned, because Phase 6 owning the release does not make Phase 6 the
owner of the decision.
