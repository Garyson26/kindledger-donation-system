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

**Every refusal path asserted in packages 3.1 through 3.5 must assert the
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
donation state. That change belongs in **package 3.5**, alongside the SEC-14
fix, not now - editing a regression suite before the code it guards is changed
would break the "suites pass unchanged" property that every package between here
and there depends on.

---

## Publication gate (AC3)

This map stays tracked - SPEC-3 section 5's "updated in the same commit"
requirement cannot be enforced on an untracked file. The exposure is handled by
a checkable condition rather than by a coupling to DEF-01:

> **Publication requires EITHER zero open findings in this map, OR the map
> redacted of file and line for everything still open.**

**Recorded as a Phase 6 gate.**

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
| U-2 | `verify_payment` reconciliation | **3.5, DESIGN ONLY** - the call itself is a later package | nothing |
| U-3 | The `Cancelled` state | **Code to 3.2; the data question to the J3 session** | nothing |
| U-4 | BUG-05 redirect URLs | **Gary, production session** | nothing |
| U-5 | `for_ocean_security_review.md` at HEAD | **Done in package 3.0** - see below | nothing |
| U-6 | prisma advisory | **Trigger, not cadence** - start of every phase | nothing |

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

**ASSIGNED TO 3.5, DESIGN ONLY. The outbound call is a separate post-Phase-3
package, gated on sandbox credentials. 3.5 must not block on it.**

What 3.5 owes is that the handler **records enough to reconcile later**:
`mihpayid`, `txnid`, the signed `amount`, and the raw `status` verbatim. All
four already have columns (`db/schema.sql`, `donation_payment_details`) and
`gateway_status` is deliberately stored verbatim rather than as an ENUM, so this
is a constraint on 3.5's handler rather than new schema.

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
unclear, which affects the admin filter, the Phase 4 ETL's status mapping, and
any report that counts cancellations.

**SPLIT (AC2). The code goes to 3.2; the data question goes to the J3 session.**

PayU documents only `success` and `failure` as signed statuses. So the question
to settle from production data is narrow and answerable: **has any donation ever
actually reached `Cancelled`?** If none has, the enum carries a state nothing
writes, and the decision is whether to keep it for future use or drop it -
which is a Phase 4 schema question, not a Phase 3 handler question.

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

**Assigned to package 3.5.** Fix: validate `/^[0-9a-f]{128}$/i` before decoding.
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
in-memory limiter. Per ADR-042 the finding stays open until package 3.4 swaps
the import. Reporting it closed on the strength of the store existing is
precisely the error ADR-042 was written to prevent.

---

## Package 3.1 - COMPLETE

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
| ADR-051 | The external id stays a 24-hex ObjectId for the rest of Phase 3, because `Donation.category` is a required ObjectId ref. **Phase 4 must not read `legacy_id IS NULL` as "created after cutover".** |
| ADR-050 exit condition | `categoryBridge.fallbackCount()` must be zero over a real run before the bridge is deleted in 3.6 |
| incidental | `donations.js:265` populated `"name description price"`; two of those three are not fields on the Category schema, so it only ever returned `name`. The bridge returns the whole category - a superset. Flagged for 3.2. |

---

## BUG-10 - a single authenticated admin request triggers a bulk delete, with no confirmation (AF4)

**Severity** Medium. **Provenance X** - found by the AD2 read-dependency
analysis, which enumerates callers rather than reasoning about purpose.
**Owning package 3.2.**

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

**Mechanism.** Retire `dataCleanupService.js` in package 3.2 and repoint the
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

## BUG-11 - a refused request names its reason under three different keys

**Severity** Low. **Provenance X** - found while writing package 3.2's
characterisation tests; the refusal helper had to be widened to accept a third
key name. **Owning package 3.3** (it lives in the middleware).

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

**Standing instruction for whoever restores Atlas: the deploy-before-restore
ordering now guards TWO findings, not one.** SEC-03 becomes reachable the
instant those credentials are fixed. It is not closed until package 3.2 merges
**and deploys**.

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

## Corrected package sequence (AD2) and the Phase 3 exit criteria

**SPEC-3 section 2 sequenced by the size of the file being changed. That was the
wrong criterion** - the risk is in the files NOT being changed. Re-derived by
READ DEPENDENCY in ADR-052. A file is safe to migrate when everything reading
its data has moved, or when a bridge exists.

| Pkg | File(s) | Introduces | Retires |
|---|---|---|---|
| 3.1 | `categories.js` **(done)** | `Category` bridge | - |
| **3.2** | `auth.js` + `users.js` + `middleware/` **(swapped, ADR-055)** | `User` bridge | - |
| **3.3** | `donations.js`, and retire `dataCleanupService` **(swapped)** | `Donation` bridge | `dataCleanupService`; `PendingSignup`'s second reader; stop minting `legacy_id` (AE1b) |
| **3.4** | `payment.js` | - | - |
| **3.5** | `admin.js` | - | **all three bridges deleted** |
| **3.6** | Mongoose removal | - | minted `legacy_id`s, then MongoDB |

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
| AE1-b | Remove `mintObjectId()` from `categories.js` once `donations.js` has migrated | **3.3** - the TRIGGER is `donations.js`, not a package number. It was written when donations was 3.2; the ADR-055 swap moved it to 3.3, so **minting must continue through 3.2**. Removing it earlier breaks the donation write path, because `Donation.category` stays an ObjectId ref until donations migrate. |

**SPEC-1A section 4.1 is temporarily false** and is corrected in ADR-051(c):
its invariant that a non-NULL `legacy_id` means "migrated from MongoDB" does not
hold during the Phase 3 window. AE1(b) stops new violations, AE1(a) removes the
existing ones, and after 3.6 the invariant is true again - deliberately restored
rather than never broken.

---

## Open findings, by owning package

Phase assignments follow SPEC-3 section 2. "Mechanism" is how it gets fixed;
"Verification" is what proves it.

### Package 3.1 - `routes/categories.js`

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| - | - | **All closed. See "Package 3.1 - COMPLETE" above.** The one item deliberately left open is the non-atomic reorder, which moves to the transaction work. | | | |

### Package 3.2 - `routes/donations.js`

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| SEC-16 | Low | `PUT /donations/:id` writes any `status` string (`donations.js:249,293` - `findByIdAndUpdate`, no `runValidators`) | Repository accepts only enum members; MySQL ENUM rejects the rest | Test writes a junk status and expects rejection | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| BUG-01 | - | `POST /api/donations` can never succeed - builds a document without the required `donorEmail`/`amount` (`donations.js:22-33`) | Decide: supply the fields or delete the endpoint | Characterisation test records the current 400 **as current behaviour**, then the change is visible | **R** |
| BUG-02 | - | `PATCH /:id/status` accepts only lowercase `approved`/`rejected` (`donations.js:289`) while callbacks write `Approved` | Canonical enum casing through the repository | Test asserts both casings resolve correctly; see ADR-018 for the ETL side | **R** |
| BUG-06 | - | `optionalAuth` 401s a guest holding a stale token (`donations.js:7-17`) | Catch the auth failure and fall through to guest | Test: expired token + guest donation succeeds | **R** |
| BUG-08 | - | Unbounded pagination (`donations.js:112,218`) | As 3.1 | As 3.1 | **R** |
| ADR-041 | - | `distinct()` must keep data semantics, not enum semantics | `donations.listStatusesInUse()` | Already tested in `test:data-layer`; route test asserts the endpoint's shape | **R** |
| ADR-003 | - | Deleting a user preserves their donations - **behaviour change** | FK `ON DELETE SET NULL`; `donor.isGuest` distinguishes | Test: delete a donor, donation survives and stays attributable | **R** |

### Package 3.3 - `routes/admin.js`

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| SEC-08 | Medium | User enumeration (admin-side endpoints) | Generic responses | Test asserts identical responses for known and unknown | **R** |
| SEC-18 | Medium | bcrypt cost 10 (`admin.js:128,220`) | `BCRYPT_COST = 12` via `repositories/users` | Test asserts the stored hash's cost parameter | **R** |
| SEC-19 | Low | `err.message` to client | As 3.1 | Characterisation test | **R** |
| SEC-21 | Low | `POST /admin/users` leaves `isVerified` false, then `auth.js:242-245` silently auto-verifies (`admin.js:131-139` confirmed: no `isVerified` set) | Set `isVerified: true` explicitly; scope or remove the auto-verify branch (branch itself is 3.4) | Test: admin-created account is verified at creation, and the legacy branch does not fire | **R** |
| BUG-03 | - | Dashboard "approved" counter always 0 - `countDocuments({status:"approved"})` at `admin.js:20` | Canonical casing; follows BUG-02 | Test: seed an `Approved` donation, expect the tile to count it | **R** |
| BUG-04 | - | Retention purge has never run - Vercel cron hits `/api/admin/cleanup/trigger` behind `adminAuth` (`Backend/vercel.json:15-20`) | Phase 2's `services/scheduler.js` replaces it; remove the dead cron declaration | Scheduler tests already pass; assert the endpoint is gone or authenticated by shared secret | **R** |
| BUG-08 | - | Unbounded pagination (`admin.js:80`) | As 3.1 | As 3.1 | **R** |

### Package 3.4 - `routes/auth.js` + `middleware/` + seam

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

### Package 3.5 - `routes/payment.js` + remaining seam

| ID | Sev | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|---|
| **SEC-14** | Medium | **Still live.** Malformed hash throws `RangeError` - char-length guard, byte-length decode (`payment.js:51-52`) | Validate `/^[0-9a-f]{128}$/i` before decoding | Extend `payment-callbacks.test.js:355` to assert the response status, not only the donation state | **R**, re-opened by **X** |
| SEC-06 | Medium | Unauthenticated donor PII via `GET /payment/status/:txnid` - confirmed: no auth middleware at `payment.js:601` | Authenticate; random transaction ids | Test: unauthenticated request returns no PII | **R** |
| SEC-07 | Medium | Donation attribution forgery - `userId` is destructured from `req.body` at `payment.js:99` and written at `:134` | Take the user from the token, never the body | Test: post a forged `userId`, assert it is ignored | **R** |
| SEC-11 | Medium | Unauthenticated write endpoints allow storage/email flooding | `paymentInitiateLimiter` (built in Phase 2, unwired); stale-`Pending` sweep | Test the limiter fires; scheduler test for the sweep | **R** |
| SEC-19 | Low | `details: error.message` at `payment.js:443,475` | Generic message | Characterisation test | **R** |
| ADR-012 / ADR-026 | - | SEC-01 idempotency is a non-atomic read-then-write. **ADR-026 supersedes ADR-012's conclusion**: the `mihpayid` UNIQUE index is integrity, NOT the replay defence | Wrap the callback in `withTransaction` (SPEC-3 §4.3) | Concurrent-callback test | **R** |
| ADR-024 §3 / ADR-026 / ADR-027 | - | No security decision may rest on an unsigned field; unsigned text must be escaped per sink | Keep the `verifyHash` banner; escape at each sink, not at ingest | Test asserts `unmappedstatus` cannot drive the decision | **R** |
| SPEC-3 §4.6 | - | Alternate-case parser fallbacks (`.AMOUNT`, `.STATUS`, `udf_4`, `udf[4]`) | Delete them; keep the banner comment | Tests unchanged - they are unreachable today | **R** |

### Package 3.6 - Mongoose removal

Exit criteria are SPEC-3 section 7. The map's own condition: every Phase 3
finding above is closed or explicitly deferred, and SEC-04 is reported closed
with its wiring commit, reversing the Phase 2 report.

| ID | Finding | Mechanism | Verification | Prov |
|---|---|---|---|---|
| ADR-047 | `docker-compose.legacy-mongo.yml` exists only while `config/db.js` does | Delete both | Plain `docker compose up`, four healthy, no override | **R** |

---

## Deferred to later phases

### Phase 4 - ETL and cutover

| ID | Finding / constraint | Prov |
|---|---|---|
| ADR-013 | The ETL must never use `INSERT IGNORE` / `UPDATE IGNORE` | **X** (found by a schema test) |
| ADR-018 | The ETL must count mixed-case status values before insert; supersedes SPEC-1A's assumption that MySQL rejects them - it does not, `_ci` collation canonicalises silently | **X** |
| ADR-022 | The ETL must re-check strict SQL mode in its own preflight | **R** |
| ADR-025 | `gateway_status` will be NULL for the entire paid population at cutover | **R** |
| ADR-031 | The rollback window closes at the first real donation into MySQL | **R** |
| J3 | Admin account enumeration, the `Password@123` check, the `PendingSignup` TTL index check. **Blocked on a dedicated read-only Atlas user.** SPEC-3 §8 requires flagging again when 3.4 completes | **R** |
| - | A restored production snapshot to rehearse the ETL against. Same credential dependency | **R** |

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
| Closed | 15 | 6 closed in package 3.1 |
| Open, assigned to a Phase 3 package | 36 | 3.1: 1 (non-atomic reorder), 3.2: 8, 3.3: 7, 3.4: 11, 3.5: 8, 3.6: 1 |
| Open, assigned to Phase 4 / 5 / 6 | 14 | P4: 7, P5: 6, P6: 1 |
| **Open and unassigned** | **6** | U-1 .. U-6 |

These are ROW counts, not distinct findings. An item like SEC-19 that spans five
route files appears five times, once per owning package - deliberate, because
each is a separate unit of work with separate verification, and a single row
would let four of the five be forgotten.

DEF-01 appears as U-1 and is cross-referenced from Phase 6; it is counted once,
under unassigned, because Phase 6 owning the release does not make Phase 6 the
owner of the decision.
