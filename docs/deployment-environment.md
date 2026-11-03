# Deployment environment — the new Vercel projects (CB2)

**For: whoever creates the new frontend and backend projects (CB3 step 5).**

Every row below was taken from the code (`process.env.*` and `import.meta.env.*`
across `Backend/` and `Frontend/src`, test files excluded), and then checked
against the variable NAMES on the two old projects. Their values were not read.

**The old projects are kept, not deleted (CD1).** They stay in the team, paused
at the cutover (4b runbook §3.4 and §6a). So values marked COPY below are copied
from the old backend project, not recovered from source systems. Every COPY
value is stored there as a readable `encrypted` variable, not `sensitive`, so the
dashboard can reveal it. **Start with §6: it says what to do with each of the
36 names.**

> **A new project starts with nothing, and the Vercel CLI cannot tell you what
> is missing.** Most of these variables, if absent, do not stop the deploy. They
> make one feature fail at the moment someone uses it. The "If missing" column
> says which.

**Failure modes, as used below:**

| Term | Meaning |
|---|---|
| **REFUSES** | Every request fails, at once. You will see it on the first page load |
| **FAILS CLOSED** | The feature that needs it is refused. Visible, and safe |
| **FAILS LOUD** | The feature breaks visibly the first time somebody uses it |
| **FAILS SILENT** | Everything looks fine and something important is not happening. **These are the dangerous ones** |

---

## 1. The dangerous ones — read these first

### 1.1 `PAYU_BASE_URL` — the wrong value takes donations that never arrive

| | |
|---|---|
| Required | **Yes** |
| Correct value | `https://secure.payu.in` (real payments). `https://test.payu.in` is the sandbox |
| Source | A choice. Must match the PayU environment the key and salt come from |
| If missing | FAILS LOUD: the payment form posts to `undefined/_payment` and the donor gets an error page |
| **If wrong** | **FAILS SILENT.** Against the sandbox, donors complete payments, receipts render, the admin list fills in, donations are marked Paid, **and no money moves** (ENV-02) |

**A correction to how ENV-02 has been described.** "The stack refuses to start
without it" is true of `docker-compose.yml`, which has the `:?` guard. **On
Vercel there is no compose file, so there is no refusal.** What you get on Vercel
is the code-level behaviour: no fallback (BW1), so a missing value fails loud at
the first donation. That is acceptable. A wrong value is still undetectable by
the code.

**The only check that works:** after the first deploy, make one real donation of
the smallest amount and **confirm it in the bank account**, not the dashboard.
That is §7a of the 4b runbook and §5.3 of the Phase 6 checklist.

### 1.2 `VITE_API_URL` — if unset, the frontend talks to the old backend's hostname

| | |
|---|---|
| Required | **Yes** |
| Format | `https://<new-backend-host>`, no trailing slash, no `/api` |
| Source | The new backend project's production domain |
| **If missing** | **FAILS SILENT until the old backend is paused, then FAILS LOUD.** Vite falls back to the TRACKED `Frontend/.env`, which still says `https://for-ocean-foudation-donation-system-one.vercel.app` |
| **If copied** | **Same as missing.** The old frontend's value names the old backend. Do not copy it (§6) |

**The hostname-claiming risk is gone (CD1).** It depended on the old backend
project being deleted and its `*.vercel.app` name released. The project is
kept, so the name stays with it.

**What is left is a misrouting, not a hijack.** While the old backend is still
serving, a new frontend built with the old host works. Donors sign in,
donations go through, and every request lands on the **old** backend: MongoDB,
and the SEC-03 bypass. Nothing on screen shows it. Once the old backend is
paused, the same build fails at the first request. **The frontend's CSP allows
that hostname too** (§3.1), so the browser does not block it either.

`VITE_API_URL` is read **at build time**. Changing it requires a redeploy.

**Still remove the hostname from `Frontend/.env` and from the CSP before step 5**
(§3). It is the wrong value for every future build, and the fix costs one line.

### 1.3 `REDIS_URL` — without it, rate limiting quietly stops working

| | |
|---|---|
| Required | **Yes, on Vercel** |
| Format | `rediss://default:<password>@<host>:<port>` (`rediss` means TLS) |
| Source | A Redis provider reachable from Vercel. Vercel does not host Redis itself; its Marketplace offers providers |
| **If missing** | **FAILS SILENT.** The limiters fall back to an in-memory store. On serverless, every function instance has its own memory, so the 5-per-minute login and OTP limits become 5 per minute **per instance**, and reset whenever an instance is recycled |

The boot log says which store is in use (`[rateLimiters]`). **After the first
deploy, check the log says redis.** No user-visible symptom will tell you.

### 1.4 `DATABASE_URL` — the MySQL database

| | |
|---|---|
| Required | **Yes** |
| Format | `mysql://<user>:<password>@<host>:3306/<database>?sslaccept=strict` |
| Source | **A choice of provider.** Vercel does not host MySQL. It must be MySQL **8.4** (the schema and `db/require-mysql-version.js` assume it) |
| If missing | REFUSES. `/api/health` answers 503 and every data route errors |

**Use TLS** (`sslaccept=strict`). This connection crosses the public internet,
which it never did in the compose stack.

**Fresh.** New database, new credential. **It goes on the new backend only.
The old backend must never be given it** (CD2c, 4b runbook §1.6).

### 1.5 `PRISMA_CONNECTION_LIMIT` — the default is wrong for serverless

| | |
|---|---|
| Required | **Set it explicitly on Vercel** |
| Default | `10`, derived for ONE long-running container (SPEC-1A §3.4) |
| **If left at 10** | **FAILS LOUD, later.** Each concurrent function instance opens its own pool. Twenty concurrent instances × 10 = 200 connections, and many managed MySQL plans allow fewer. Under a donation spike, new requests are refused |

**Derivation (BJ2), not a number:**

```
PRISMA_CONNECTION_LIMIT = floor( (provider max_connections − headroom) / peak concurrent instances )
```

`headroom` covers the ETL, migrations and a human at a prompt. Use 5.
`peak concurrent instances` is the unknown. **Start at `1`.** That is the safe
end, because one connection per instance cannot exhaust the server before the
instance count does. Raise it only once you have measured the instance count.

### 1.6 `JWT_SECRET`

| | |
|---|---|
| Required | **Yes** |
| Format | 32+ characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| Source | **GENERATED FRESH (AI1).** Do not carry the old value over |
| If missing or short | REFUSES. `config/jwt.js` throws on load, so every request fails |

A fresh value invalidates every existing session. **That is intended, and is
rotation (CG2), not a side effect:** the repository is public, and a
30-character fallback that once lived in `config/jwt.js` is permanently public
in its history. Production does not use it (Phase 6 checklist §1.1, confirmed
by behaviour). Generating fresh means it cannot matter whether any copy of any
old value is out there.

### 1.7 `PAYU_MERCHANT_SALT` and `PAYU_MERCHANT_KEY`

| | Salt | Key |
|---|---|---|
| Required | **Yes** | **Yes** |
| Source | PayU dashboard | PayU dashboard |
| Format | 16+ chars (PayU issues 32) | PayU's merchant key. It is an identifier, not a secret |
| If missing | FAILS CLOSED: no hash is built or verified, so no donation can start (ENV-01 fix) | FAILS CLOSED, same |

**The salt is the only thing that makes a forged "payment succeeded" callback
distinguishable from a real one.** Copy it from the old backend project, unless
PayU or AI1 says otherwise. I checked history: every salt-shaped value ever committed is the
`TEST…` fixture in a test file. **The key, salt and `PAYU_BASE_URL` must all
come from the same PayU environment.**

---

## 2. The complete list

### 2.1 Backend project

The **Action** column is defined in §6.

| Variable | Action | Req | If missing | Source | Format / example |
|---|---|---|---|---|---|
| `DATABASE_URL` | **GENERATE FRESH** | **Yes** | REFUSES | Provider (fresh) | §1.4 |
| `REDIS_URL` | **GENERATE FRESH** | **Yes** | **FAILS SILENT** | Provider (fresh) | §1.3 |
| `PRISMA_CONNECTION_LIMIT` | NEW | **Set it** | Fails loud under load | Derived | §1.5. Start at `1` |
| `JWT_SECRET` | **GENERATE FRESH** | **Yes** | REFUSES | **Generated fresh** | §1.6 |
| `ALLOWED_ORIGINS` | **REWRITE** | **Yes** | FAILS CLOSED: every browser request rejected by CORS | The new frontend domain(s) | `https://donate.example.org`. Comma-separated, exact scheme and host, **no trailing slash, no path**. Compared character for character |
| `PAYU_BASE_URL` | COPY, **then check** | **Yes** | Fails loud. **Wrong = FAILS SILENT** | Old backend | Must read `https://secure.payu.in`. If it reads `test.payu.in`, stop: the key and salt beside it are sandbox ones too (§1.7) |
| `PAYU_MERCHANT_KEY` | COPY | **Yes** | FAILS CLOSED | Old backend | §1.7 |
| `PAYU_MERCHANT_SALT` | COPY | **Yes** | FAILS CLOSED | Old backend | §1.7 |
| `SUCCESS_URL` | **REWRITE** | **Yes** | FAILS LOUD: PayU rejects the request | New backend domain | `https://<backend>/api/payment/success` |
| `FAILURE_URL` | **REWRITE** | **Yes** | FAILS LOUD | New backend domain | `https://<backend>/api/payment/failure` |
| `CANCEL_URL` | **REWRITE** | **Yes** | FAILS LOUD | New backend domain | `https://<backend>/api/payment/cancel` |
| `NOTIFY_URL` | **REWRITE** | **Yes** | **FAILS SILENT**: the server-to-server confirmation never arrives, so a donor who closes the tab before the redirect leaves a donation stuck Pending | New backend domain | `https://<backend>/api/payment/webhook`. **Check whether a webhook URL is also set in the PayU dashboard, and update it there as well** |
| `FRONTEND_SUCCESS_URL` | **REWRITE** | **Yes** | FAILS LOUD: the donor is redirected to `undefined?txnid=…` after paying. The donation IS recorded | New frontend domain | `https://<frontend>/payment-success` |
| `FRONTEND_FAILURE_URL` | **REWRITE** | **Yes** | FAILS LOUD, same | New frontend domain | `https://<frontend>/payment-failure` |
| `EMAIL_USER` | COPY | **Yes** | Login fails loud; every other flow **FAILS SILENT** (§2.3) | Old backend | The sending address |
| `EMAIL_PASSWORD` | COPY | **Yes** | Login fails loud; every other flow **FAILS SILENT** (§2.3) | Old backend | For Gmail, an **App Password** (16 chars), not the account password |
| `EMAIL_SERVICE` | COPY | Optional | Uses the SMTP settings below | Old backend | `gmail`, or unset for generic SMTP |
| `SMTP_HOST` | COPY | If not `gmail` | Defaults to `smtp.gmail.com` | Old backend | `smtp-relay.brevo.com` |
| `SMTP_PORT` | COPY | Optional | `587` | Old backend | `587` (STARTTLS) or `465` |
| `SMTP_SECURE` | COPY | Optional | `false` | Old backend | `true` **only** with port 465 |
| `HEALTH_DIAGNOSTIC_SECRET` | **GENERATE FRESH** | Optional | FAILS CLOSED: diagnostics unavailable, plain health still works | **Generated fresh** | 16+ chars, same generator as `JWT_SECRET` |
| `ADMIN_CREATION_KEY` | **GENERATE FRESH** (rotation) if ever set. **Leave unset** | **Leave unset** | FAILS CLOSED: public signup cannot mint admins | — | See §2.4 |
| `RATE_LIMIT_PREFIX` | NEW: leave unset | Optional | `kl:rl:` | Choice | Set it only if the Redis instance is shared with anything else |

### 2.2 Frontend project

| Variable | Action | Req | If missing | Source | Format |
|---|---|---|---|---|---|
| `VITE_API_URL` | **REWRITE** | **Yes** | **FAILS SILENT** while the old backend serves (§1.2) | New backend domain | `https://<backend>`. Read at BUILD time |

That is the only variable the frontend reads. **Nothing else belongs on the
frontend project** (§4).

### 2.3 Email: loud in one place, silent in the rest

Checked per call site in `routes/auth.js`:

| Flow | Send | A failed send |
|---|---|---|
| **Login** | awaited, result checked | **FAILS LOUD**: 500 "Failed to send OTP email" |
| Signup, signup resend, login resend, password reset | fire-and-forget (`.catch` → log) | **FAILS SILENT**: the response says "sent" |

The silent ones are silent **on purpose**. An answer that differed when sending
failed would be an account-enumeration oracle (SEC-08, 3.5a).

**There is a worse case that is silent everywhere: credentials the SMTP server
accepts, and mail that is never delivered.** That covers spam folders, an
unverified sender domain and provider sandboxes. Login reports success and no
code arrives. Every login, signup and reset needs an emailed code, so nobody
can sign in, admins included. **The 4b runbook's step 7b ("one real OTP") is
the only check for this.**

### 2.4 `ADMIN_CREATION_KEY` — recommend leaving it unset

When it is set, anyone holding it can create an admin account through the
**public** signup endpoint. After the cutover, existing admins arrive with the
migrated data, so no key is needed. If one is ever needed, generate it fresh,
use it once, and delete it.

---

## 3. Three things the variables cannot fix: code changes needed before step 5

| # | What | Why it blocks | Change |
|---|---|---|---|
| **3.1** | **The frontend CSP hardcodes the old backend hostname.** `Frontend/vercel.json`: `connect-src 'self' https://for-ocean-foudation-donation-system-one.vercel.app …` | The browser refuses every API call to any other host. **The new frontend loads and nothing works.** `vercel.json` is static, so no variable can change it | Put the new backend host there. That needs the host known in advance: **either a custom domain chosen now, or a project name whose `*.vercel.app` name is confirmed free.** Gary's choice |
| **3.2** | **`Frontend/.env` is tracked and names the old backend** | §1.2. Wrong rather than dangerous since CD1: the fallback reaches the old backend, which is still ours. It is also already in Phase 6's scrub scope "for the shape" | Remove the value, so a missing `VITE_API_URL` fails loud (`localhost:5000`) instead of silently reaching the old backend |
| **3.3** | **No `prisma generate` in the backend build.** No `postinstall`, no `vercel-build` | Vercel caches `node_modules`. Prisma documents that a cached client goes stale and throws at runtime on Vercel. The first deploy will work and a later schema change will not. **I have not reproduced this, because Vercel's cache cannot be simulated locally** | **Done in post-F, as `"vercel-build": "prisma generate"`, not `postinstall`.** `docker/api.Dockerfile` runs `npm ci` before it copies `prisma/`, so a postinstall generate would fail the image build. Vercel's Node runtime runs `vercel-build` under `@vercel/node`; Docker and CI never call it. **Unverified until the first deploy: check the build log shows `prisma generate`** |

**Post-F (PR 10) carries 3.2 and 3.3. 3.1 waits for the new backend's
hostname**, so that PR is open as a draft until the name is chosen. No new
projects exist in the team yet (checked when it was opened).

---

## 4. DO NOT SET: do not copy these, and do not add them

**No MongoDB credential goes on either new project (CD2c).** The Atlas
credential lives only on the machine that runs 4b's ETL. And the reverse holds:
**the old backend is never given `DATABASE_URL` or `REDIS_URL`.** The 4b runbook
§1.6 checks both directions by name.

| Name | Where it is now | Why not |
|---|---|---|
| `MONGODB_URI` | Old backend | Nothing on the request path reads it after Phase 3.6. Only the ETL does, and that runs locally in 4b |
| `foroceanfoundation_MONGODB_URI` | Old backend | Atlas Marketplace integration (`store_1KY6ODUNmfpdgqg0`). Same reason. **Do not connect that integration to either new project.** Connecting it injects the credential without anyone typing it |
| **`MONGODB_URI`** | **Old FRONTEND, production** | **A database credential on the frontend project**, also injected by the integration. Vite only puts `VITE_*` variables into the bundle, so it was not shipped to browsers. It was available to the build and had no reason to be |
| `MONGO_URI` | Not set anywhere | Read only as an ETL fallback name. Same as `MONGODB_URI` |
| `ADMIN_EMAIL` | Old backend | Nothing reads it |
| `PORT` | Old backend | Unused on Vercel; the app does not listen there |
| `NODE_ENV` | Not set | `Backend/vercel.json` sets `production` |
| `VERCEL` | Not set | Vercel sets it itself. The code reads it to detect the platform |
| `UPLOADS_DIR`, `SCHEDULER_ENABLED`, `SCHEDULER_TIMEZONE`, `JOB_RETENTION_PURGE`, `JOB_INACTIVE_ACCOUNT_PURGE`, `JOB_PENDING_SIGNUP_SWEEP`, `RETENTION_YEARS`, `ALLOW_SEED` | Not set | See §5. Leave all unset on Vercel |

**Create every secret as type "Sensitive"** (write-only after creation). On the
old backend, Vercel flagged `MONGODB_URI`, `JWT_SECRET`, `EMAIL_PASSWORD` and
`PAYU_MERCHANT_KEY` as `readable-secret`: stored so that any team member could
read them back.

---

## 5. Two features that do not work on Vercel, and must not be made to look as if they do

**Logo upload.** Logos are written to local disk (`UPLOADS_DIR`, default
`/var/lib/kindledger/uploads`). Vercel functions have a read-only filesystem, so
an upload **fails loud** with an error, and the site keeps its default branding.
**Do not set `UPLOADS_DIR=/tmp`.** `/tmp` is writable but belongs to one
instance and disappears when it is recycled. The upload would succeed and the
logo would vanish at random, which is the silent version of the same failure.
Object storage is DEF-05.

**Scheduled jobs.** `node-cron` needs a long-running process. Set
`SCHEDULER_ENABLED=true` on Vercel and the jobs register in an instance that
then freezes or disappears, so they appear configured and do not run: **FAILS
SILENT.** Leave it unset. The jobs are destructive and off by default anyway
(AT1). The cost is that expired pending signups are not swept (they are already
refused at use) and retention purges do not run. Both are recorded, not hidden.

---

## 6. Setting them up by hand: what to do with each of the 36 names (CD3)

The code reads **36 names** on the backend (33 directly, plus the three `JOB_*`
names read through `config/destructiveJobs.js`) and **1** on the frontend.
**You type in 21 of them on the backend and 1 on the frontend.** The other 15
stay unset.

| Action | Means |
|---|---|
| **COPY** | Exists on the old backend. Copy the value across unchanged |
| **GENERATE FRESH** | **Rotation, not convenience (CG2).** The repository is public and its history is permanent (Phase 6 checklist §1), so any value that sat in this project's history, logs or old projects must be assumed known. Make a new one, from the generator in §1.6. **Never copy, even where the old project has one** |
| **REWRITE** | The name exists on the old project and **the value must change**, because it names an old host. See the warning below |
| **NEW** | Not on the old project. Added since it was created |
| **DO NOT SET** | Leave it off the project. §4 and §5 say why |

> **REWRITE exists because of ENV-03** (remediation map): a correct value in the
> wrong place, failing silently. Eight names
> are on the old projects but cannot be copied. A copied `SUCCESS_URL` or
> `NOTIFY_URL` sends PayU's confirmations to the **old** backend. While that
> backend is up, it accepts them and records a paid donation **in MongoDB**, so
> MySQL never sees it. This is FAILS SILENT, and it is CD2a's two-backend
> problem arriving through configuration. A copied `VITE_API_URL` does the same
> for every request (§1.2).

### Backend: 36 names

| # | Name | Action | On the old backend? |
|---|---|---|---|
| 1 | `JWT_SECRET` | **GENERATE FRESH** (rotation) | Yes. Do not copy (AI1). A 30-character fallback and a 43-character test value are permanently public in history. **Every existing session ends when this changes, and that is expected** |
| 2 | `HEALTH_DIAGNOSTIC_SECRET` | **GENERATE FRESH** (rotation) | No |
| 3 | `DATABASE_URL` | **GENERATE FRESH** (rotation): new database, new credential | No. **Never put it on the old backend** |
| 4 | `REDIS_URL` | **GENERATE FRESH** (rotation): new instance, new password | No |
| 5 | `PAYU_MERCHANT_KEY` | COPY | Yes |
| 6 | `PAYU_MERCHANT_SALT` | COPY | Yes |
| 7 | `PAYU_BASE_URL` | COPY, **then check it reads `https://secure.payu.in`** | Yes |
| 8 | `EMAIL_USER` | COPY | Yes |
| 9 | `EMAIL_PASSWORD` | COPY | Yes |
| 10 | `EMAIL_SERVICE` | COPY | Yes |
| 11 | `SMTP_HOST` | COPY | Yes |
| 12 | `SMTP_PORT` | COPY | Yes |
| 13 | `SMTP_SECURE` | COPY | Yes |
| 14 | `ALLOWED_ORIGINS` | **REWRITE**: new frontend domain | Yes |
| 15 | `SUCCESS_URL` | **REWRITE**: new backend domain | Yes |
| 16 | `FAILURE_URL` | **REWRITE**: new backend domain | Yes |
| 17 | `CANCEL_URL` | **REWRITE**: new backend domain | Yes |
| 18 | `NOTIFY_URL` | **REWRITE**: new backend domain. **And the PayU dashboard, if a webhook URL is set there** | Yes |
| 19 | `FRONTEND_SUCCESS_URL` | **REWRITE**: new frontend domain | Yes |
| 20 | `FRONTEND_FAILURE_URL` | **REWRITE**: new frontend domain | Yes |
| 21 | `PRISMA_CONNECTION_LIMIT` | NEW: set to `1` (§1.5) | No |
| 22 | `ADMIN_CREATION_KEY` | **GENERATE FRESH** (rotation), **if it is ever set**. Recommended: leave unset (§2.4) | No |
| 23 | `RATE_LIMIT_PREFIX` | NEW: leave unset unless Redis is shared | No |
| 24 | `MONGODB_URI` | **DO NOT SET** (CD2c) | Yes |
| 25 | `MONGO_URI` | **DO NOT SET** (CD2c) | No |
| 26 | `PORT` | DO NOT SET | Yes |
| 27 | `NODE_ENV` | DO NOT SET: `vercel.json` sets it | No |
| 28 | `VERCEL` | DO NOT SET: the platform sets it | No |
| 29 | `UPLOADS_DIR` | DO NOT SET (§5) | No |
| 30 | `SCHEDULER_ENABLED` | DO NOT SET (§5) | No |
| 31 | `SCHEDULER_TIMEZONE` | DO NOT SET (§5) | No |
| 32 | `RETENTION_YEARS` | DO NOT SET (§5) | No |
| 33 | `ALLOW_SEED` | DO NOT SET | No |
| 34 | `JOB_RETENTION_PURGE` | DO NOT SET (§5) | No |
| 35 | `JOB_INACTIVE_ACCOUNT_PURGE` | DO NOT SET (§5) | No |
| 36 | `JOB_PENDING_SIGNUP_SWEEP` | DO NOT SET (§5) | No |

Two names on the old backend are not read by the code at all, so they are not
among the 36: `foroceanfoundation_MONGODB_URI` and `ADMIN_EMAIL`. **Do not copy
either** (§4).

**Count check:** 4 generate fresh that are set + 9 copy + 7 rewrite + 1 new =
**21 typed in.** `ADMIN_CREATION_KEY` (generate fresh, left unset) +
`RATE_LIMIT_PREFIX` (new, left unset) + 13 do-not-set = **15 left off.**

**Rotation list (CG2):** `JWT_SECRET`, `HEALTH_DIAGNOSTIC_SECRET`,
`ADMIN_CREATION_KEY`, `DATABASE_URL`, `REDIS_URL`. **Rotating `JWT_SECRET`
signs every existing user out**, donors and admins alike. That is the rotation
taking effect. It is not a fault, and nobody should "fix" it by restoring the
old value.

### Frontend: 1 name

| Name | Action | On the old frontend? |
|---|---|---|
| `VITE_API_URL` | **REWRITE**: new backend domain | Yes. **Copying it points the new frontend at the old backend** (§1.2) |

The old frontend also has `MONGODB_URI` (production, from the Atlas
integration). **Do not copy it** (§4).

**Create every secret as Sensitive** (§4). The old values are readable, and the
new ones need not be.

---

## 7. The old projects stay (CD1)

The old frontend and backend projects are **kept, not deleted.** What that
changes:

- **The Atlas integration is not at risk.** Nothing is deleted, so nothing can
  take the cluster with it. The "secure the source before deleting" step that
  stood here is withdrawn. **If deleting the old projects is ever back on the
  table, that step comes back with it.** AE1-a's minted-id oracle exists only
  in that cluster.
- **Values are copied from the old backend**, not recovered from source
  systems (§6).
- **The old `.vercel.app` hostname is not released**, so it cannot be claimed
  (§1.2).

What it adds. The 4b runbook carries each of these as a step, not a note:

| | Risk | Runbook step |
|---|---|---|
| **CD2a** | **Two live backends.** If the old one is still serving when the new one goes live, donations split between MongoDB and MySQL. Anything the old one takes after the ETL is missing from MySQL | §3.4 pauses the old backend inside the freeze. §6a confirms it is still paused before donations reopen |
| **CD2b** | **The old projects keep serving vulnerable code** (`58bdadf`, SEC-03) until somebody turns them off. Keeping them makes "off" a deliberate act | §3.4 (backend) and §6a.4 (frontend): pause, then **confirm by request**, not by the dashboard alone |
| **CD2c** | **Credentials crossing over.** The old backend must never hold the MySQL credential, and the new one must never hold MongoDB's | §1.6, checked by name on both projects, and checked again at §6a.2 |
| **CD2d** | **The old projects are still Git-connected.** A merge to `main` starts a production deploy on them. Today that fails with `Resource provisioning failed`, **and that failure is the only thing stopping it** | §1.7: disconnect both after PR 1 merges, before PR 2. See also ADR-062's CD1 amendment |

---

## 8. The sequence, and what it means for SEC-03

**The sequence (CE5, settled):**

1. The new projects are created and configured (§6) **before 4b starts.** They
   have no production traffic and are not given the public domains yet.
2. **The new backend goes live at the end of 4b, inside the freeze**, before
   donations reopen. The runbook deploys it after the ETL load (§4a), verifies
   through it (§5.5), and opens it to donors at §6a.
3. **4c is cleanup afterwards**: `etl/`, `models/`, `mongoose`, the legacy
   compose override. It changes nothing a donor touches.

The hotfix merges first, but **merging changes nothing in production.** On the
old project, production serves `58bdadf`, **which has the unauthenticated
authentication bypass**, and keeps serving it **until the 4b freeze** pauses
it (runbook §3.4). CA's rule applies: a merged PR is not a deployed fix.

So the window is open from now until §3.4. Standing up the new backend does not
close it by itself, because the old one keeps serving until it is paused.
**The repository is public** (an unauthenticated API read returned it on
3 Nov 2026). ADR-028 records it as private in September, so it has changed
visibility at least twice, and when is not recorded here. While it is public,
the hotfix branch and this map describe the bypass to anyone who reads them.
Phase 6's history scrub assumed it would run **before** publication (ADR-030). That does not
change the options below. It does change what accepting the window means.

The options that close it sooner are Gary's to weigh. **I am not recommending
one, because each costs something:**

| Option | Closes the window | Cost |
|---|---|---|
| Pause the old **backend** project now | Yes, immediately | The site's API is down until the end of 4b |
| Deploy the hotfix to the old project once, manually | Only if provisioning works. The last two attempts failed with "Resource provisioning failed" | May not work. ADR-028's authorship block may apply |
| Accept the window | No | The bypass stays live until the 4b freeze |

The first deploy of the new project gets the same rule: **confirm `READY` and
check the behaviour, not just the merge.**
