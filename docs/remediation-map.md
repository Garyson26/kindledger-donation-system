# Remediation map

**Package 3.0 (SPEC-3 section 3).** Every known finding in one place: where it
lives, which phase closes it, by what mechanism, and how that is verified.

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
`payment-callbacks.test.js:355` posts a malformed hash and asserts the donation
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

**Retroactive application is deliberately deferred.** `payment-callbacks.test.js:355`
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

**ASSIGNED TO GARY, production session.** Read the deployed
`FRONTEND_SUCCESS_URL` and `FRONTEND_FAILURE_URL` and compare against the routes
in `App.jsx`. If they match, this closes as a documentation defect in
`.env.example` alone. If they do not, every donor who has paid since the values
were set has landed on a blank page after a successful payment, and the finding
is considerably larger than it reads here.

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

`verifyHash()` in `routes/payment.js:46-53` guards with a **character**-length
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

`test/payment-callbacks.test.js:355` sends exactly this (`'z'.repeat(128)`) and
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
limiter store is not wired; `routes/auth.js:19-25` still constructs a default
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
| `services/categoryBridge.js` | temporary, deleted in 3.6; logs and counts every MongoDB fallback |
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

`POST /api/admin/cleanup/trigger` (`admin.js:281`) calls
`triggerManualCleanup()`, which deletes donations older than ten years, and
users older than ten years who have no donations.

**What is NOT wrong, checked rather than assumed:**

- **It is not reachable by a non-admin.** `router.use(adminAuth)` at
  `admin.js:17` guards every route in the file, including this one. A non-admin
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
(`auth.js:238-256`). The attacker is **past the credential check**, holding a
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
credentials"}`, byte for byte (`auth.js:235-239`). I assumed otherwise and the
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

### Recommended, NOT implemented - this is an audit and the fixes are decisions

1. **Warn in the signup OTP email.** "If you did not request this, ignore this
   email and do not enter the code." One template edit, in the file 3.5a owns,
   no downside. It is the single highest-value change.
2. **Do not reset `signupOtpAttempts` when a pending row already exists.** A
   small repository change; keeps the counter meaningful.
3. **Consider rate-limiting `/signup` per ADDRESS**, as AV1 did for resets - it
   bounds problems 1 and 2 without touching the flow.

Not done here because AW2 was commissioned as an audit and because the email
wording is a product decision. **Recorded with its evidence so it cannot be
inherited as "probably fine".**

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

**Recommendation: its own small package, not folded into 3.6.** The fix is a
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

**IT MUST BE REMOVED IN PACKAGE 3.6, IN THE SAME COMMIT THAT REMOVES MONGOOSE.**
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
  `GET /admin/stats` (`admin.js:27,32`). Read-only, no control, no false
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

**Outcome, read from the code:** `payment.js:612` has no authentication of any
kind. It returns the WHOLE donation record, populated - donor name, email,
phone, amount, and the payment details including `mihpayid` and `bank_ref_num`.
The only thing standing between an anonymous request and a donor's personal data
is knowing `txnid`.

**And the application publishes `txnid` into the URL bar itself.** Every callback
redirects to `FRONTEND_SUCCESS_URL?txnid=...` (`payment.js:247,304,391,471`). A
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

**Was:** "bcrypt cost 10 (`admin.js:128,220`)" - Medium.

**Outcome:** cost 10 versus 12 is a four-fold change in offline cracking cost,
and it only matters at all GIVEN a database compromise. It is hardening, not a
control that can be defeated. **Low.**

**But reading it produced a better finding than the severity.** `admin.js:140`
and `:232` call `bcrypt.hash(password, 10)` DIRECTLY - they do not go through
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
in **exactly one place in the entire codebase** - `auth.js:312`, the line that
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
by `donations.js`.** `donations.js:47`'s write is BUG-01 and has never once
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

**Fixed**: findings carry `loaderRefuses`, and those are refused BEFORE anything
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

`loaderRefuses` is KEPT as reporting rather than deleted with the flag. It no
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

A short list, because the pattern has now cost real time three times.

| Symptom | Cause | The "fix" that would have hidden it |
|---|---|---|
| The auth suites PASS and then hang forever | Wiring Redis left a socket holding the event loop | A force-exit flag - which would have hidden a genuine resource leak, in a module every process imports |
| The SEC-02 suite fails with 429 on its FIRST request | The Redis limiter is shared and persistent, so a re-run inherits the previous run's counters | Marking the suite flaky, or adding a retry |
| An injected login returns 500 | The SMTP send failing AFTER the credential check was passed | Reading the 500 as a refusal - which is what happened, and it hid SEC-03 for a full package |

The common shape: **infrastructure made correct produces a symptom that reads as
a broken test.** The natural response makes the test quiet rather than making
the system right. In all three the honest read was available immediately from
asking what the symptom would mean if the code were correct.

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

**Nine now.** Number 8 arrived during the audit commissioned because of number 7,
and number 9 during the package commissioned because of number 8. The claims do
not run out, and each pass that looks for them finds one.

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
| **3.6** | Mongoose removal | no file imports Mongoose; `fallbackCount()` zero (AE3) |
| **4b** | Production cutover: freeze, rollback boundary, J3, snapshot rehearsal | Phase 3 complete |

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
`admin.js:13` imports three of its functions, which DELETE donations and users.
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
| SEC-16 | Low | `PUT /donations/:id` writes any `status` string (`donations.js:249,293` - `findByIdAndUpdate`, no `runValidators`) | Repository accepts only enum members; MySQL ENUM rejects the rest | Test writes a junk status and expects rejection | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| BUG-01 | - | `POST /api/donations` can never succeed - builds a document without the required `donorEmail`/`amount` (`donations.js:22-33`) | Decide: supply the fields or delete the endpoint | Characterisation test records the current 400 **as current behaviour**, then the change is visible | **R** |
| BUG-02 | - | `PATCH /:id/status` accepts only lowercase `approved`/`rejected` (`donations.js:289`) while callbacks write `Approved`. **MECHANISM NOW VERIFIED BY BEHAVIOUR (AM3)** - see below | Canonical enum casing through the repository | Test asserts both casings resolve correctly; see ADR-018 for the ETL side | **R**, mechanism confirmed **X** |
| BUG-06 | - | `optionalAuth` 401s a guest holding a stale token (`donations.js:7-17`) | Catch the auth failure and fall through to guest | Test: expired token + guest donation succeeds | **R** |
| BUG-08 | - | Unbounded pagination (`donations.js:112,218`) | As 3.1 | As 3.1 | **R** |
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
| SEC-18 | **Low** (AJ3: was Medium) | bcrypt cost 10 (`admin.js:140,232`). **The real finding is that these call `bcrypt.hash` DIRECTLY instead of `repositories/users`** - two hashing implementations, one governed by policy | Route both through `users.create` / `users.setPassword` | Test asserts the cost AND that an admin password reset revokes sessions | **R**, re-derived **X** |
| **ADMIN-01** | **High** | **EVERY admin user-management operation writes MongoDB, which authentication no longer reads.** See the dedicated section above - this is not a bcrypt finding and not a `tokenVersion` finding, it is a store split | Migrate `admin.js`'s user operations, or move them into the package that owns the entity | Test: each admin operation, then assert the effect through `/api/auth/login` | **X** (AJ3) |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| SEC-21 | **Medium** (AJ3: was Low, and RESTATED) | **`isVerified` gates nothing.** It is read in exactly one place in the codebase - `auth.js:312`, the line that sets it true. SEC-05's shape. Not High only because self-service signup enforces verification structurally via `PendingSignup` | Decide whether the flag is a control. If it is, gate on it; if it is not, remove it rather than leave a field the admin UI can toggle to no effect | Test: an unverified account is refused, or the field is gone | **R**, re-derived **X** |
| BUG-03 | - | **Dashboard "approved" counter is NOT "always 0" - it counts the LOWERCASE SUBSET** (`countDocuments({status:"approved"})`, `admin.js:32`). Measured in the AR1 audit: it returned **1 when the true figure was 2**. It reads 0 only where no admin ever used `PATCH /:id/status`; anywhere else it reads a plausible fraction. **A tile showing 0 is visibly broken; a tile showing 1 of 2 is believed** | Canonical casing; follows BUG-02, and closed as a side effect of migrating the two `/stats` counts | Test: donations approved through BOTH writers, expect the tile to count both | **R**, corrected by **X** (AR1) |
| BUG-04 | - | Retention purge has never run - Vercel cron hits `/api/admin/cleanup/trigger` behind `adminAuth` (`Backend/vercel.json:15-20`) | Phase 2's `services/scheduler.js` replaces it; remove the dead cron declaration | Scheduler tests already pass; assert the endpoint is gone or authenticated by shared secret | **R** |
| BUG-08 | - | Unbounded pagination (`admin.js:80`) | As 3.1 | As 3.1 | **R** |

### `routes/auth.js` + `routes/users.js` + `middleware/`  *(trigger: users data migrated; currently 3.2)*

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| **SEC-04** | **High** | **Rate limiting non-functional** - `routes/auth.js:19-25` builds a default in-memory limiter | Wire `config/rateLimiters.js`. **This is what closes the finding** (ADR-042) | `test:auth` unchanged; assert the Redis store is in use | **R** |
| **SEC-05** | **High** | `isActive` never enforced and tokens cannot be revoked - confirmed: the flag exists on the model and `admin.js:196` toggles it, but **no route or middleware reads it**, and `tokenVersion` does not exist in `routes/`, `middleware/` or `models/` | Check `isActive` at both login steps and in both middlewares; `tokenVersion` on the token, incremented by `setPassword`/`setActive` | Test: disable an account, existing token rejected, login refused | **R** |
| **SEC-03** | **High** | NoSQL operator injection - **12+ `findOne({ email })` call sites, no `String()` coercion anywhere in `routes/` or `middleware/`** | Parameterised SQL removes the class; repositories coerce and lowercase | Test posts `{"email":{"$ne":null}}` and expects no match | **R** |
| SEC-08 | Medium | User enumeration on five endpoints | Generic responses | Test asserts identical responses | **R** |
| SEC-10 | Medium | Password policy absent in two places, inconsistent elsewhere | One shared validator across all five paths | Test each path with a weak password | **R** |
| SEC-13 | Medium | OTPs and reset codes stored in plaintext - confirmed at `auth.js:385` (`user.resetPasswordCode = verificationCode`) | Repositories store sha256 (`users.setResetCode`) | Test: read the row, assert no plaintext code | **R** |
| SEC-18 | Medium | bcrypt cost 10 (`auth.js:57,506,533`) | `BCRYPT_COST = 12` | As 3.3 | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| ADR-034 | - | A correct code at `/verify` must NOT clear the attempt counter | `users.verifyResetCode` deliberately does not reset | Already asserted in `test:auth` and `test:data-layer`; must stay true | **R** |
| ADR-033 | - | Duplicate index declarations in the Mongoose models | Moot once the models go (3.6); must not be reintroduced in the Prisma schema | Drift gate; boot logs free of the Mongoose duplicate-index warning | **X** |
| SEC-09 | Medium | Donor PII written to application logs | Strip PII; level-aware logger | Assert no PII in captured log output | **R** (ADR-032 upgraded the evidence to observed - **X**) |

### `routes/payment.js` + remaining seam  *(trigger: donations data migrated; currently 3.4)*

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| **SEC-14** | Medium | **Still live.** Malformed hash throws `RangeError` - char-length guard, byte-length decode (`payment.js:51-52`) | Validate `/^[0-9a-f]{128}$/i` before decoding | Extend `payment-callbacks.test.js:355` to assert the response status, not only the donation state | **R**, re-opened by **X** |
| SEC-06 | **High** (AJ3: was Medium) | Unauthenticated donor PII via `GET /payment/status/:txnid`, and the `txnid` protecting it is published into the URL bar by the app's own redirects - confirmed: no auth middleware at `payment.js:601` | Authenticate; random transaction ids | Test: unauthenticated request returns no PII | **R** |
| SEC-07 | Medium | Donation attribution forgery - `userId` is destructured from `req.body` at `payment.js:99` and written at `:134` | Take the user from the token, never the body | Test: post a forged `userId`, assert it is ignored | **R** |
| SEC-11 | Medium | Unauthenticated write endpoints allow storage/email flooding | `paymentInitiateLimiter` (built in Phase 2, unwired); stale-`Pending` sweep | Test the limiter fires; scheduler test for the sweep | **R** |
| **PAY-01** | Low | **`quantity` is unbounded while `extraAmount` is clamped, on consecutive lines** (`payment.js:136-137`). `quantity="99999999999999999999"` prices a donation at 1.5e23, unauthenticated. After 3.4 it becomes an unauthenticated 500 instead | One `Math.min`, with the ceiling a named constant beside `extraAmount`'s so the pair cannot drift again | Test both bounds together | **X** (AJ3) |
| SEC-19 | Low | `details: error.message` at `payment.js:443,475` | Generic message | Characterisation test | **R** |
| ADR-012 / ADR-026 | - | SEC-01 idempotency is a non-atomic read-then-write. **ADR-026 supersedes ADR-012's conclusion**: the `mihpayid` UNIQUE index is integrity, NOT the replay defence | Wrap the callback in `withTransaction` (SPEC-3 §4.3) | Concurrent-callback test | **R** |
| ADR-024 §3 / ADR-026 / ADR-027 | - | No security decision may rest on an unsigned field; unsigned text must be escaped per sink | Keep the `verifyHash` banner; escape at each sink, not at ingest | Test asserts `unmappedstatus` cannot drive the decision | **R** |
| SPEC-3 §4.6 | - | Alternate-case parser fallbacks (`.AMOUNT`, `.STATUS`, `udf_4`, `udf[4]`) | Delete them; keep the banner comment | Tests unchanged - they are unreachable today | **R** |

### Mongoose removal  *(trigger: no file imports Mongoose; currently 3.6)*

Exit criteria are SPEC-3 section 7. The map's own condition: every Phase 3
finding above is closed or explicitly deferred, and SEC-04 is reported closed
with its wiring commit, reversing the Phase 2 report.

| ID | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|
| ADR-047 | `docker-compose.legacy-mongo.yml` exists only while `config/db.js` does | Delete both | Plain `docker compose up`, four healthy, no override | **R** |

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
| SEC-15 | Medium | JWT in `localStorage` (confirmed at `LoginPage.jsx:51,81`, `SignupPage.jsx:75`) | **R** |
| SEC-17 | Low | `Frontend/.env` is tracked (confirmed by `git ls-files`) | **R** |
| SEC-20 | Low | `/tailwind-test` and `/button-showcase` routed in production (`App.jsx:162-163`) | **R** |
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
