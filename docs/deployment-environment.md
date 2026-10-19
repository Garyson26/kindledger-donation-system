# Deployment environment — the new Vercel projects (CB2)

**For: whoever creates the new frontend and backend projects (CB3 step 5).**

Every row below was taken from the code (`process.env.*` and `import.meta.env.*`
across `Backend/` and `Frontend/src`, test files excluded), and then checked
against the variable NAMES on the two projects being deleted. Their values were
not read.

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
| **If missing** | **FAILS SILENT, possibly dangerously.** Vite falls back to the TRACKED `Frontend/.env`, which still says `https://for-ocean-foudation-donation-system-one.vercel.app` |

Once the old backend project is deleted, nothing serves that hostname, and
**`*.vercel.app` names freed by a deleted project may be claimable by another
Vercel account.** I have not verified Vercel's reuse policy. If the name can be
claimed, a frontend built without `VITE_API_URL` would send donors' login
passwords and OTPs to whoever claimed it. **The frontend's CSP explicitly allows
that hostname too** (§3.1), so the browser would not block it.

`VITE_API_URL` is read **at build time**. Changing it requires a redeploy.

**This should not rely on the variable being remembered.** Remove the hostname
from `Frontend/.env` and from the CSP before step 5 (see §3).

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

**Fresh.** New database, new credential.

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

A fresh value invalidates every existing session. That is intended.

### 1.7 `PAYU_MERCHANT_SALT` and `PAYU_MERCHANT_KEY`

| | Salt | Key |
|---|---|---|
| Required | **Yes** | **Yes** |
| Source | PayU dashboard | PayU dashboard |
| Format | 16+ chars (PayU issues 32) | PayU's merchant key. It is an identifier, not a secret |
| If missing | FAILS CLOSED: no hash is built or verified, so no donation can start (ENV-01 fix) | FAILS CLOSED, same |

**The salt is the only thing that makes a forged "payment succeeded" callback
distinguishable from a real one.** Carry it over, unless PayU or AI1 says
otherwise. I checked history: every salt-shaped value ever committed is the
`TEST…` fixture in a test file. **The key, salt and `PAYU_BASE_URL` must all
come from the same PayU environment.**

---

## 2. The complete list

### 2.1 Backend project

| Variable | Req | If missing | Source | Format / example |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | REFUSES | Provider (fresh) | §1.4 |
| `REDIS_URL` | **Yes** | **FAILS SILENT** | Provider (fresh) | §1.3 |
| `PRISMA_CONNECTION_LIMIT` | **Set it** | Fails loud under load | Derived | §1.5. Start at `1` |
| `JWT_SECRET` | **Yes** | REFUSES | **Generated fresh** | §1.6 |
| `ALLOWED_ORIGINS` | **Yes** | FAILS CLOSED: every browser request rejected by CORS | The new frontend domain(s) | `https://donate.example.org`. Comma-separated, exact scheme and host, **no trailing slash, no path**. Compared character for character |
| `PAYU_BASE_URL` | **Yes** | Fails loud. **Wrong = FAILS SILENT** | Choice | `https://secure.payu.in` |
| `PAYU_MERCHANT_KEY` | **Yes** | FAILS CLOSED | PayU dashboard | §1.7 |
| `PAYU_MERCHANT_SALT` | **Yes** | FAILS CLOSED | PayU dashboard | §1.7 |
| `SUCCESS_URL` | **Yes** | FAILS LOUD: PayU rejects the request | New backend domain | `https://<backend>/api/payment/success` |
| `FAILURE_URL` | **Yes** | FAILS LOUD | New backend domain | `https://<backend>/api/payment/failure` |
| `CANCEL_URL` | **Yes** | FAILS LOUD | New backend domain | `https://<backend>/api/payment/cancel` |
| `NOTIFY_URL` | **Yes** | **FAILS SILENT**: the server-to-server confirmation never arrives, so a donor who closes the tab before the redirect leaves a donation stuck Pending | New backend domain | `https://<backend>/api/payment/webhook`. **Check whether a webhook URL is also set in the PayU dashboard, and update it there as well** |
| `FRONTEND_SUCCESS_URL` | **Yes** | FAILS LOUD: the donor is redirected to `undefined?txnid=…` after paying. The donation IS recorded | New frontend domain | `https://<frontend>/payment-success` |
| `FRONTEND_FAILURE_URL` | **Yes** | FAILS LOUD, same | New frontend domain | `https://<frontend>/payment-failure` |
| `EMAIL_USER` | **Yes** | Login fails loud; every other flow **FAILS SILENT** (§2.3) | Mail provider | The sending address |
| `EMAIL_PASSWORD` | **Yes** | Login fails loud; every other flow **FAILS SILENT** (§2.3) | Mail provider | For Gmail, an **App Password** (16 chars), not the account password |
| `EMAIL_SERVICE` | Optional | Uses the SMTP settings below | Choice | `gmail`, or unset for generic SMTP |
| `SMTP_HOST` | If not `gmail` | Defaults to `smtp.gmail.com` | Mail provider | `smtp-relay.brevo.com` |
| `SMTP_PORT` | Optional | `587` | Mail provider | `587` (STARTTLS) or `465` |
| `SMTP_SECURE` | Optional | `false` | Mail provider | `true` **only** with port 465 |
| `HEALTH_DIAGNOSTIC_SECRET` | Optional | FAILS CLOSED: diagnostics unavailable, plain health still works | **Generated fresh** | 16+ chars, same generator as `JWT_SECRET` |
| `ADMIN_CREATION_KEY` | **Leave unset** | FAILS CLOSED: public signup cannot mint admins | — | See §2.4 |
| `RATE_LIMIT_PREFIX` | Optional | `kl:rl:` | Choice | Set it only if the Redis instance is shared with anything else |

### 2.2 Frontend project

| Variable | Req | If missing | Source | Format |
|---|---|---|---|---|
| `VITE_API_URL` | **Yes** | **FAILS SILENT, possibly dangerously** (§1.2) | New backend domain | `https://<backend>`. Read at BUILD time |

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
| **3.2** | **`Frontend/.env` is tracked and names the old backend** | §1.2. It is also already in Phase 6's scrub scope "for the shape" | Remove the value, so a missing `VITE_API_URL` fails loud (`localhost:5000`) instead of falling back to a hostname somebody else may own |
| **3.3** | **No `prisma generate` in the backend build.** No `postinstall`, no `vercel-build` | Vercel caches `node_modules`. Prisma documents that a cached client goes stale and throws at runtime on Vercel. The first deploy will work and a later schema change will not. **I have not reproduced this, because Vercel's cache cannot be simulated locally** | `"postinstall": "prisma generate"` in `Backend/package.json` |

I propose one small PR after F carrying all three, once Gary has chosen the
hostnames. It cannot be written before that, because 3.1 needs the name.

---

## 4. Do NOT carry these over

| On the old project | Why not |
|---|---|
| `MONGODB_URI` (backend) | Nothing on the request path reads it after Phase 3.6. Only the ETL does, and that runs locally in 4b |
| `foroceanfoundation_MONGODB_URI` (backend) | Atlas Marketplace integration. Same reason |
| **`MONGODB_URI` (FRONTEND project, production)** | **A database credential on the frontend project.** Vite only puts `VITE_*` variables into the bundle, so it was not shipped to browsers. It was available to the build and had no reason to be. **Do not connect the Atlas integration to the new frontend** |
| `ADMIN_EMAIL` | Nothing reads it |
| `PORT` | Unused on Vercel; the app does not listen there |
| `NODE_ENV` | `Backend/vercel.json` sets `production` |
| `UPLOADS_DIR`, `SCHEDULER_ENABLED`, `SCHEDULER_TIMEZONE`, `JOB_*`, `RETENTION_YEARS`, `ALLOW_SEED` | See §5. Leave all unset on Vercel |

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

## 6. Fresh vs carried over

| Generate fresh | Carry over | Re-derive (hosts change) |
|---|---|---|
| `JWT_SECRET` (AI1) | `PAYU_MERCHANT_KEY` | `ALLOWED_ORIGINS` |
| `DATABASE_URL` (new database) | `PAYU_MERCHANT_SALT` | `SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL` |
| `REDIS_URL` (new instance) | `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_SERVICE`, `SMTP_*` | `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL` |
| `HEALTH_DIAGNOSTIC_SECRET` | | `VITE_API_URL` |
| The Atlas credential, for 4b's ETL only. **Not set on Vercel at all** | | PayU dashboard webhook URL, if one is set there |

---

## 7. Before deleting the old projects

These are Gary's hands. None can be done from here.

1. **Secure 4b's source before anything is deleted.** Both old projects carry
   Atlas through a **Vercel Marketplace integration** (store
   `store_1KY6ODUNmfpdgqg0`), and the backend also has a manually entered
   `MONGODB_URI`. Establish **which cluster production actually reads**: the app
   reads `MONGODB_URI`. Then confirm that **deleting the projects, or
   uninstalling the integration, does not delete that cluster.** Phase 4b reads
   it, and AE1-a's minted-id oracle exists only there: **once it is gone, it is
   gone permanently.**
2. **Hold every carried-over value somewhere other than Vercel** (§6), from its
   real source where possible. Deleting a project deletes its variables.
3. **The SEC-03 exposure window (§8).**

---

## 8. What CB3's order means for SEC-03

The hotfix merges first, but **nothing deploys until step 5.** On the old
project, production serves `58bdadf`, **which has the unauthenticated
authentication bypass**, and it keeps serving it through 4b and 4c. **Merging the
hotfix does not change production.** CA's rule applies: a merged PR is not a
deployed fix.

So the window is open from now until either the old backend stops serving or
the new project serves `main`. The options that close it sooner are Gary's to
weigh. **I am not recommending one, because each costs something:**

| Option | Closes the window | Cost |
|---|---|---|
| Pause or delete the old **backend** project now | Yes, immediately | The site's API is down until step 5 |
| Deploy the hotfix to the old project once, manually | Only if provisioning works. The last two attempts failed with "Resource provisioning failed" | May not work. ADR-028's authorship block may apply |
| Accept the window | No | The bypass stays live through 4b and 4c |

The first deploy of the new project gets the same rule: **confirm `READY` and
check the behaviour, not just the merge.**
