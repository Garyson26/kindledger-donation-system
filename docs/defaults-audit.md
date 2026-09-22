# The defaults audit (BV2)

> **STATUS: acted on. §1.1, §1.2 and §1.4 are FIXED; §1.3 is recorded as a
> constraint of the gateway choice rather than a default. See §5.**

BU1 found the first defect that came from the *whitelabel* framing rather than
from security: `"For Ocean Foundation"` as a fallback organisation name is
correct for this deployment and wrong for a product, because it renders one
charity's name on another's site before the branding fetch resolves.

That generalises, and this audit is the general case.

> **The question asked of every default:** is this a **fact about this
> deployment**, or a **decision about an installation nobody has met**?
>
> A value that was a fact becomes an assumption the moment the software acquires
> a second possible installer.

**Verdicts:** `KEEP` — universal, or fails safe. `CHANGE` — the default should
be a different value. `REQUIRE` — there should be no working default; the
installer must supply it.

---

## 1. The findings — four defaults that are facts about For Ocean Foundation

### 1.1 `PAYU_BASE_URL` defaults to PayU's **TEST** gateway — REQUIRE

```yaml
PAYU_BASE_URL: ${PAYU_BASE_URL:-https://test.payu.in}
```

**This is the most serious item in the audit and it is not a security finding —
it is worse than one.**

A self-hoster who does not set it runs the whole donation flow against PayU's
**sandbox**. The site works. Donors complete a payment. The receipt renders,
the admin dashboard fills in, the donation is marked Paid.

**No money moves.**

Every symptom points away from the cause: the code is correct, the hashes
verify, the callbacks arrive, and the database is consistent. The only way to
notice is to reconcile against a bank account that never received anything.

**This is ENV-01's shape at product scale.** ENV-01 was a missing variable that
silently disabled a security check; this is a present variable that silently
disables *the point of the software*. Both fail in the direction that looks
like success.

**Recommendation: REQUIRE.** `${PAYU_BASE_URL:?set PAYU_BASE_URL...}` so compose
refuses to start, and the `.env.example` comment states both hosts explicitly.
Unlike `PAYU_MERCHANT_SALT` — which is guarded at the point of use, because a
missing salt must not stop the whole stack for people not working on payments —
there is no equivalent runtime check available here: **a test gateway and a
production gateway are indistinguishable to the code.** Only the operator knows
which one they meant.

### 1.2 `SCHEDULER_TIMEZONE` defaults to `Asia/Kolkata` — CHANGE

```js
const TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'Asia/Kolkata';
```

A fact about For Ocean Foundation. An NGO in Nairobi or Lima gets retention and
purge jobs firing at whatever local hour 02:00 IST happens to be for them.

Low harm today — both scheduled jobs are destructive and therefore **off by
default** (AT1) — but it is the wrong default for a product, and it is the kind
that stays wrong quietly because a cron firing at the wrong hour still fires.

**Recommendation: CHANGE to `UTC`**, which is neutral and predictable rather
than being somebody else's local time, and document that an operator who wants
jobs at their own local hour should set it.

### 1.3 `INR` is hardcoded in three places — REQUIRE (and it is coupled to 1.1)

| Where | Value |
|---|---|
| `repositories/donations.js` | `input.currency \|\| 'INR'` |
| `db/schema.sql` | `default_currency CHAR(3) NOT NULL DEFAULT 'INR'` |
| `branding_settings` seed | `'INR'` |

An NGO elsewhere records donations **labelled INR** while collecting something
else. That is a data-integrity problem in the money column, and unlike a wrong
colour it is not visible on the page.

**The honest complication:** PayU is an India-only gateway. So an installation
outside India cannot use the payment flow at all, and the currency default is
not really independent of §1.1 — it is downstream of a gateway choice this
project has already made.

**Recommendation: REQUIRE** `DEFAULT_CURRENCY`, and state the coupling plainly
in the self-hosting notes: **this software currently supports PayU, and PayU is
India-only.** An NGO outside India needs a different gateway, which is a real
piece of work and not a configuration value. Saying so is more useful than a
configurable currency field that cannot be paid into.

### 1.4 `RETENTION_YEARS = 10` is hardcoded — REQUIRE, or keep it unreachable

```js
const RETENTION_YEARS = 10;
```

Not even environment-configurable. Ten years is a **legal** retention decision
that varies by jurisdiction and by the NGO's own obligations, and this job
**deletes donation records**.

Mitigated today: `JOB_RETENTION_PURGE` is off by default and states what leaving
it off costs (AT1). So nothing is deleted on a number nobody chose — until
somebody turns the job on, at which point they inherit a figure they never saw.

**Recommendation: REQUIRE `RETENTION_YEARS` to be set whenever
`JOB_RETENTION_PURGE=true`.** The gate already exists; this adds one condition
to it. A destructive job should not carry a jurisdiction-specific constant as a
default, and the same applies to the inactive-account purge, which uses the same
ten-year cutoff.

---

## 2. Correct as they are — and why, so this is a decision rather than an omission

### 2.1 Fails safe, keep

| Default | Why it is right |
|---|---|
| `JOB_RETENTION_PURGE`, `JOB_INACTIVE_ACCOUNT_PURGE`, `JOB_PENDING_SIGNUP_SWEEP` = `false` | AT1. Destructive work is off until somebody authorises it per job |
| `SCHEDULER_ENABLED=false` | Nothing runs on a timer unless asked |
| `HEALTH_DIAGNOSTIC_SECRET` = empty | The diagnostic form is unavailable rather than open |
| `NODE_ENV=production` | The stricter mode is the default; a development setting must be asked for |
| `ALLOWED_ORIGINS` blank | Empty list → every cross-origin request rejected. **Verified, not assumed** (BJ1) |

### 2.2 Universal, not local — keep

| Default | Why |
|---|---|
| `BCRYPT_COST = 12` | A security parameter, not a fact about anywhere. SEC-18 chose it deliberately, and BG1's timing equaliser derives from the same constant so the two cannot drift |
| Rate limits — 5/min auth, 20/min payment initiate, 5/15min reset attempts | Fail in the strict direction. A busy NGO may need them raised; a quiet one is never harmed by them |
| Logo bounds — 2 MB, 4000 px, 40 MP | A logo is never larger. The pixel bound is a decompression-bomb control, not a preference |
| `OTP_TTL_MS` 10 min, `RESET_TTL_MS` 15 min, JWT `1h` | Conventional and not jurisdictional |
| `PRISMA_CONNECTION_LIMIT=10`, `SMTP_PORT=587`, `SMTP_SECURE=false` | 587 with STARTTLS is the standard submission port |
| `HTTP_PORT=80`, `HTTPS_PORT=443`, `REDIS_URL`, `RATE_LIMIT_PREFIX`, `MYSQL_DATABASE/USER=kindledger` | Infrastructure naming, internal to the compose stack |
| Schema defaults — `'Pending'`, `'user'`, `0`, `TRUE`, `CURRENT_TIMESTAMP(3)` | Structural. They describe the data model, not a deployment |

### 2.3 The branding seed — keep, with the tension named

```sql
VALUES (1, 'Your Organisation', 'INR', '#05699E', '#044D73')
```

`'Your Organisation'` is already neutral and visibly a placeholder.

**The colours are For Ocean Foundation's**, and by BU1's rule that is a fact
about this deployment shipped as a default. It is kept anyway, and the reason is
worth stating rather than glossing:

- SPEC-5 §5.1 and §10 require that **a fresh installation renders identically to
  the current site**. That is only true if the seeded colours are the current
  ones.
- A colour is **trivially changeable by the installer**, in an admin form built
  for exactly that, with a live preview. `PAYU_BASE_URL` is not.

**The distinction that matters is not "is this a local fact" but "what does
getting it wrong cost, and how visible is it".** A wrong colour is visible on
first load and fixable in thirty seconds. A wrong gateway is invisible and costs
an NGO every donation until somebody reconciles a bank statement.

---

## 3. The rule this produces

> **A default is acceptable when it is universal, or when it fails safe, or when
> getting it wrong is visible and cheap to correct.**
>
> **A default is not acceptable when an installer must get it right for their
> own context and the wrong value works.**

Every item in §1 is in the second category. `PAYU_BASE_URL` is the extreme case:
the wrong value does not merely work, **it looks exactly like the right one.**

---

## 4. Recommended order, if these are taken

1. **`PAYU_BASE_URL` → REQUIRE.** One line in `docker-compose.yml`, one comment
   in `.env.example`, and a paragraph in the self-hosting notes. The highest
   harm and the cheapest fix in the list.
2. **`SCHEDULER_TIMEZONE` → `UTC`.** One line.
3. **`RETENTION_YEARS` → required when the purge is authorised.** Extends an
   existing gate rather than adding one.
4. **Currency → require, and state the PayU/India coupling.** Mostly a
   documentation change, because the honest answer is that an NGO outside India
   needs gateway work rather than a configuration value.

None of these is urgent for **this** deployment — For Ocean Foundation is in
India, uses PayU, and the defaults are all correct for them. **They become
urgent at publication**, which is the point BU1 makes: the audience changed, and
these values changed status without changing content.

---

## 5. What was done (BW1, BW3)

| Item | Disposition |
|---|---|
| **§1.1 `PAYU_BASE_URL`** | **FIXED.** `:?` in compose, the second fallback in `config/payu.js` removed, `.env.example` blanked with both hosts named, and CI asserts the stack refuses to start. Recorded as **ENV-02 (High)** |
| **§1.2 `SCHEDULER_TIMEZONE`** | **FIXED.** `Asia/Kolkata` -> `UTC` |
| **§1.4 `RETENTION_YEARS`** | **FIXED.** Reads from the environment, refuses a non-positive value, default stays 10 for continuity |
| **§1.3 `INR`** | **LEFT, and recorded as a gateway constraint.** PayU is India-only, so currency is downstream of a choice already made. A configurable currency would be a field an NGO can set and still not be paid in. **Trigger: supporting a second gateway** |

And the detection that has no code-level form: **the first real donation after
any deployment is reconciled against the bank before the site is announced.**
It is in the Phase 6 self-hosting notes and in the 4b runbook.
