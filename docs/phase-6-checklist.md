# Phase 6 — release checklist

**Document only. Nothing here has been executed.**

Phase 6 is the release: rotation, the publication gate, and the documents a
stranger needs before they can run or contribute to this.

> **THE REPOSITORY IS ALREADY PUBLIC, DELIBERATELY (CG1).** It was public on
> 3 Nov 2026, before this checklist's gate was met, and Gary has decided it
> stays public. Read every section below with that in mind. §0 says what it
> changes.

---

## 0. The repository went public before the gate (CG3)

> ### THE PUBLICATION GATE WAS BYPASSED BY CIRCUMSTANCE. IT WAS NOT SATISFIED.
>
> §2's gate assumed zero open findings, or redacted file and line, **before**
> the repository went public. Neither happened. Nobody should read this
> checklist later and conclude the gate was passed.

What that changes:

| | Before | Now |
|---|---|---|
| **Open findings in the docs** | Redact or close before publishing | **Already published.** `docs/remediation-map.md` lists open findings with file and line, readable by anyone. **Decision for Gary: redact file:line for everything still open, or accept the exposure.** Redacting now limits what the NEXT reader sees. It cannot recall what earlier readers saw, and history keeps the unredacted text either way |
| **Secrets** | A Phase 6 gate (`test:no-secrets` plus a human read of the tracked list) | **A per-commit check.** Every push is public the moment it lands, so a commit `test:no-secrets` would fail must never be pushed. Fixing it afterwards still leaves it public (see §1). **It runs in CI on every push, in its own job with no services** (`no-secrets` in `app-tests.yml`, from PR E onwards, where the test first exists). It used to be a step inside a job that could not start (CI-01), so before that it had never run. Nothing else's failure can stop it starting. Still run it locally before pushing anything that touches configuration |
| **History** | Scrubbed before publication | **Not scrubbed, and not going to be** (§1) |
| **Exploit-level material** | Removed before publication | `for_ocean_security_review.md` is **at the root of `main` today** and in public history. See §1.1 |

**Measured, not assumed:** an unauthenticated GitHub API read returned the
repository as public on 3 Nov 2026. ADR-028 records it as private in
September, so it has changed visibility at least twice.

---

## 1. Rotation, not a scrub (CG1)

> ### THERE WILL BE NO HISTORY SCRUB. ROTATION IS THE REMEDIATION.
>
> **Decided by Gary, 3 Nov 2026.** Rewriting history would break all ten
> stacked pull requests (#24 to #33) and every existing clone. And it
> would not undo the exposure: it changes what a future clone receives, not
> what forks, caches and crawlers already hold.
>
> **Everything listed below is permanently public.** Treat each exposed value as
> known to anyone, for good. Nothing here gets less public over time.

### 1.1 What is permanently public, and what is done about it

| Item | Where | Status, checked 3 Nov 2026 | Remediation |
|---|---|---|---|
| **The JWT fallback secret** (30 characters) | `Backend/config/jwt.js` from `e11a09e` (17 Jan) to `bacd6d9` (24 May). Both are ancestors of `main` | **Permanently public.** Production does **not** use it, **confirmed by behaviour, not inferred**: production's `app.js` loads `routes/auth.js`, and so `config/jwt.js` with its 32-character guard, **before** it connects to MongoDB. Its runtime logs reach the MongoDB connection, so the guard passed and the value is at least 32 characters. Vercel also records the old backend's `JWT_SECRET` as created with the project on 22 Jan and never edited. The value was not read | **Rotate anyway:** the new backend gets a freshly generated `JWT_SECRET` (env doc §6). A value that has never been anywhere cannot match anything in history |
| A 43-character test fallback | `Backend/test/branding.test.js` (from `3db866a`, 22 Sep) | Public, and **long enough to pass the guard**. It is a test fixture, and production's value predates it by eight months | Never use a value found in this repository as a real secret. Generating fresh (env doc §6) covers it |
| **`Password@123`** | `Backend/scripts/seedDatabase.js` (the legacy MongoDB seeder) at `main` **and at every stack tip**, plus its README and history | **No application code uses it.** The seeder a current installation runs (`npm run db:seed`, MySQL) generates a random password every run. The legacy seeder refuses to run unless `NODE_ENV` is not production **and** `ALLOW_SEED=true`. 4c deletes it. **The live risk is in data, not code:** if that seeder was ever run against production MongoDB, the ETL copies those hashes into MySQL unchanged | 4b runbook §2.2 checks every production hash against it **before** the ETL |
| **`for_ocean_security_review.md`** | **At the root of `main` and of 17 other public branches today.** Added at `bacd6d9` (24 May), removed from `main` by PR 1 (#24), the first to merge (CH1), and from the migration stack by package 3.0 (`6cfec20`) | **Not just history: it is on the repository's front page.** ADR-030's "never public" assumed a private repository and no longer holds. Open findings it describes are listed in the remediation map under CG1 | Leaves `main`'s tree when #24 merges. **It stays in history permanently**, so the remediation is closing the findings, not hiding the document |
| **`Frontend/.env`** | Tracked | Held only the public backend hostname. Post-F (#33) empties the value; the file stays tracked | Nothing to rotate |
| **`origin/setup-12`, `origin/setup-13`** | Remote branches, unrelated history | **A different project ("Sentinel"), 12 of 13 commits by Viraj**, carrying `SECRET_KEY=${SECRET_KEY:-change-me-in-production}`. **Public now along with everything else.** If that value was ever used for real in Sentinel, it is Viraj's to rotate | Tell Viraj. Deleting the branches is **still Gary's and Viraj's decision**. It would stop future clones carrying them, not undo the exposure |

### 1.2 What used to be reassurance, and no longer is

This section used to say the GPL commit `4f3b7ec` was made **while the
repository was private, so no public GPL grant exists** (ADR-061). **That no
longer holds.** `main` publishes `LICENSE` with the **GNU GPL v3 text** today,
beside `"license": "ISC"` in `Backend/package.json`: ADR-029's contradiction,
now public. Apache-2.0 arrives in PR E (#31). **Anyone cloning `main` today
receives GPL v3 text.** What that does and does not mean, as questions for an
adviser rather than answers, is in ADR-061's CH4 amendment.

### 1.3 Method: rotate, then record

1. **Generate fresh** every secret the new projects use (env doc §6, CG2). Copy
   nothing whose value could have been in a repository, a log or a screenshot.
2. **Expect** every existing session to be invalidated when `JWT_SECRET`
   changes. It is the rotation working, not a fault.
3. Record in the cutover log which values were rotated and when. Record the
   names, never the values.

No `git filter-repo`, no force-push.

---

## 2. The publication gate (AC3) - BYPASSED, see §0

> **Publication requires EITHER zero open findings, OR redaction of file and
> line for everything still open — in `docs/remediation-map.md` AND
> `docs/entity-ownership-audit.md`.**
>
> **This gate was not met before the repository went public (§0).** It is kept
> for the record of what was intended. **The redaction half is now Gary's
> decision, not a gate.**

The audit carries the same exposure in a more concentrated form: it indexes
exactly where each entity is written and read, by file and line, which is a
faster route to the seams than the finding list.

**A file added to the tracked set inherits this gate. It does not get a quiet
exception for being new** — which now includes `docs/ui-audit.md`,
`docs/phase-4b-runbook.md` and this file.

### 2.1 WHAT A GREEN `test:no-secrets` DOES NOT MEAN

> **A passing run is NOT evidence that this repository contains no secrets, and
> must not be cited as such at this gate.**

It measures *"no tracked file assigns a non-placeholder value to a
**credential-shaped name**"*. A real secret committed as `FOO=8f3a...` is
invisible to it, and **no refinement of the name pattern can fix that** — the
information is not in the name.

It is kept because the failure it catches is the one that happens: somebody
writes `JWT_SECRET=` followed by something that works.

**This gate therefore requires a human read of the tracked file list.** That is
weaker than a check, it is the strongest thing available, and per AY1 it does
not on its own carry a closure claim.

**Now that the repository is public, the check is per-commit (§0).** Run
`test:no-secrets` before every push, and in CI on every branch. Its
limitation above still applies, so it does not replace reading the diff of
anything that touches configuration. A secret pushed once is public for good.
Removing it afterwards only means rotating it as well (§1).

---

## 3. `SECURITY.md`

- How to report a vulnerability, and to whom. A named contact, not an issue
  tracker — a public issue is a disclosure.
- What is in scope: this repository. What is not: an NGO's own deployment, which
  the maintainers cannot see and cannot fix.
- Expected response time, stated honestly for a project maintained by one
  person. **An unrealistic SLA is worse than none**, because missing it teaches
  a reporter to go public next time.
- The supported version. There is one: the latest release.

### 3.1 Say plainly what the operator is responsible for

A self-hoster inherits decisions this project cannot make for them:

- **`PAYU_MERCHANT_SALT` must be set.** Without it the API refuses to build or
  verify a PayU hash — but a stack that refuses payments is still a stack that
  needs an operator to notice (ENV-01).
- **`JWT_SECRET` must be ≥ 32 characters and unique per installation.** Shared
  between two deployments, a token from one authenticates on the other.
- **`ALLOWED_ORIGINS` must list the real frontend origins.** It fails closed
  when blank — verified, not assumed — so a blank value is a broken site rather
  than an open one, which is the right direction but still needs saying.
- **The destructive jobs are OFF by default** (AT1) and each states what leaving
  it off costs. Turning one on is a decision with a data-loss consequence.

---

## 4. `CONTRIBUTING.md`

- How to run it: `docker compose up`, four services, and the acceptance that a
  plain `up` works with no override.
- How to run the tests: `npm run test:all` in the container, plus the two that
  run elsewhere and **why** — `trust-proxy` needs the nginx stack from the host,
  `no-committed-secrets` needs `git`, which is not in the api image.
- The standing rules that survive this project's phases, stated once:
  - **Measure outcomes, not presence** (BH2). A fix is verified by the behaviour
    changing, never by the change being present.
  - **Enumerate and state** (AY2). List every sibling and say whether each has
    the same property. "Check nearby" has failed repeatedly.
  - **Every closure names its channels** (BG4). Body, status, timing and
    response size are separate channels.
  - **Deletions get the injection-proof standard** (AV2).
  - **No prose-only residuals** (BB5). Every residual carries a test name or the
    word UNPINNED.
  - **A threshold needs a derivation** (BJ2), not a comfortable number.
- `db/schema.sql` is normative. Prisma follows it, and the drift gate is what
  keeps that true.

---

## 5. Self-hosting notes

### 5.1 `sharp` carries native binaries

Prebuilt for common platforms. A self-hoster on an unusual architecture —
32-bit ARM, musl without the prebuilt, a BSD — needs a build toolchain, and
**that belongs here rather than being discovered at install time**.

### 5.2 The general form worth passing on (BT1)

> **An image library's INPUT FORMAT LIST is an attack surface list. A decoder
> that accepts a format you have banned will accept it on your behalf.**

This project's logo upload rejects SVG by identifying the container from its
**magic bytes before the decoder is given the buffer** — because `sharp` decodes
SVG happily, so "decode it and see whether it is an image" would rasterise the
SVG and accept it, running an XML parser against attacker-controlled input on
the way.

The same sentence covers every parser handed untrusted bytes: **the formats it
supports are the parsers you are running, whether or not you meant to.**

The same shape one layer up: a disk-backed `multer` writes the raw upload to the
serving volume **before any check runs**. Convenient defaults are chosen for
convenience.

### 5.3 VERIFY THE FIRST REAL DONATION AGAINST THE BANK, BEFORE ANNOUNCING

**This is the only detection available for ENV-02, and there cannot be a
code-level one.**

`PAYU_BASE_URL` decides whether payments are real. The stack now refuses to
start without it - but it cannot tell whether the host you gave it is the
sandbox or production, because **both are valid, both answer, and both sign
correctly.**

So, on every new deployment and after any change to that variable:

1. Make one real donation of the smallest amount the gateway accepts.
2. Confirm it appears in the admin list and the receipt renders.
3. **Confirm the money arrived in the bank account.** Not the dashboard - the
   bank.
4. Only then announce the site.

Step 3 is the whole step. Steps 1 and 2 pass identically against the sandbox,
which is exactly what makes this necessary.

#### The last items before announcing: leaving test mode (DI1)

The new backend starts on PayU's **sandbox, deliberately** (remediation map
DI1), so the frontend can be tested end to end. When it works, these are the
**last three things done before the site is announced**, in this order:

1. **Switch all three PayU values together**: `PAYU_BASE_URL` to
   `https://secure.payu.in`, `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` to the
   production pair. Never one at a time: a production salt with the test URL,
   or the reverse, fails hash verification, and the symptom points at the
   hashing code, which is correct.
2. **Redeploy.** A changed variable reaches only new deployments.
3. **One real donation of the smallest amount, confirmed IN THE BANK** - steps
   1 to 4 above. Not the dashboard.

### 5.3a On Vercel: every variable is Production only, and stays so only if you keep checking (DEPLOY-02, DEPLOY-03)

With the project connected to Git, Vercel builds a preview of **every branch**,
and a preview gets the Preview variables. Any backend variable on Preview
hands any branch the session-signing key, the payment salt, the mail password,
the donor database, or production's rate-limit counters.

**On the first KindLedger deployment, Preview was ticked on twelve variables
added in the dashboard, a Marketplace integration put its own there without
asking, and editing one variable's value left it on Preview although it had
been Production-only** (remediation map DEPLOY-02, DEPLOY-03). The guide
already said "Production only". **So the setting cannot be made once and
trusted:**

1. **Untick Preview and Development on every backend variable** as you add it.
2. **Re-check the Preview filter AFTER EVERY EDIT** - a changed value, a
   re-added secret, a new integration - not once at setup. The page, filtered
   to Preview, must list nothing. A preview with no variables fails closed,
   which is correct.
3. **Before pushing a branch** to a Git-connected project, check again.
4. **Or use the CLI, where the environment is explicit, and audit with it:**
   ```
   vercel env add JWT_SECRET --environment production --sensitive --yes
   vercel env ls --environment preview        # must list nothing
   ```

### 5.4 The uploads volume must be persistent

Logos are stored on local disk in the `uploads` volume, deliberately — an NGO
running `docker compose up` on a small VPS should not need an S3 account. **A
host with ephemeral storage loses uploaded logos on restart.** Object storage is
recorded as a deferred option (DEF-05).

---

## 5.5 The defaults audit (BV2)

`docs/defaults-audit.md` walks every default in the codebase and asks whether it
is a fact about THIS deployment or a decision about an installation nobody has
met. **Four are facts about For Ocean Foundation**, and one of them is the most
serious item found outside security work:

> **`PAYU_BASE_URL` defaults to PayU's TEST gateway.** A self-hoster who does not
> set it runs the whole donation flow against the sandbox. The site works,
> donors complete payments, receipts render, the dashboard fills in - **and no
> money moves.** Every symptom points away from the cause.

It is ENV-01's shape at product scale: ENV-01 was a missing variable that
silently disabled a security check; this is a present variable that silently
disables the point of the software. Both fail in the direction that looks like
success.

The other three are `SCHEDULER_TIMEZONE=Asia/Kolkata`, `INR` hardcoded in three
places, and `RETENTION_YEARS = 10` - a jurisdiction-specific legal figure on a
job that deletes donation records.

**None is urgent for this deployment and all four become urgent at
publication**, which is exactly BU1's point: the audience changes, and a value
changes status without changing content.

---

## 6. Open at the time of writing

| Item | State |
|---|---|
| `SIGNUP-01` rec 3 | **Open, PINNED.** No per-address limit on `/signup`; `upsert` lets an attacker destroy a legitimate in-flight signup. A denial of registration, not a takeover |
| The 3.5a timing separation | **Open, PINNED and MEASURED.** 5–7 ms on three sha256-scale endpoints; accepted, because equalising means a dummy database write for an address that does not exist |
| AE1-a's partial-overlap case | **Open, PINNED.** An old snapshot of the right database shares most ids, so the identity guard passes by construction |
| `vite` major (frontend build tooling) | **Queued.** `npm audit --omit=dev` reports 0; the advisories are dev-server only. `vite@8` is its own package |
| Guest donation retrieval (D1 / AG4) | **Deferred with triggers**, not a phase |
| PayU on test mode (DI1) | **Tracked, deliberate.** Trigger: the frontend works end to end against the sandbox. Then §5.3's last three items. Closes when the first real donation is in the bank |
| `RATE-01`, `RATE-02` (remediation map DH1) | **Fixed (DJ1), PINNED** by `test:rate-limiter-redis` on a fake Redis: one store per limiter, and a failed store start-up is retried. With Redis unreachable a limited route is refused, not let through: **decided** (DK3), and pinned |
| `DEPLOY-02`, `DEPLOY-03`: production secrets on Preview, and an edit that put the donor database there | **Being corrected** on the Vercel project. Closes when Preview lists no variables after the last edit (§5.3a) |

**Every one carries a test.** An open residual with a test cannot change without
somebody noticing; one with a prose note can.
