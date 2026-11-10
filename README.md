# KindLedger Donation System

An online donation platform for **For Ocean Foundation**. Donors browse donation
categories, give as a guest or a registered user, and pay through **PayU Money**.
Administrators manage categories, donors, and donation records from an admin
console with reporting and PDF receipts.

**Stack:** React 18 + Vite SPA · Express 5 API on Node 20 · **MySQL 8.4 via
Prisma** · Redis for rate limiting · PayU Money · Docker Compose for local and
self-hosted deployment.

---

## Features

**For donors**
- Browse donation categories with server-authoritative pricing
- Donate as a guest or a registered user, with an optional top-up amount
- PayU Money checkout with SHA-512 request and response hashing
- Donation history and downloadable PDF receipts
- Email-OTP two-step signup and login; self-service password reset

**For administrators**
- Dashboard counters and charts (monthly, yearly, and custom date ranges)
- Donation browser with filtering by donor type, payment status, search, and date
- User management: create, edit, enable/disable, force password reset, delete
- Category management with drag-to-reorder display ordering
- 10-year data retention purge with a dry-run preview

---

## Quick start

**Prerequisites:** Docker and Compose v2 — the stack brings up MySQL, Redis,
the API and nginx. For running the API outside Docker you also need Node >= 20
and npm >= 10, plus a MySQL 8.4 instance and Redis.

PayU credentials and an SMTP account (a Gmail App Password works) are needed for
payments and email respectively; the rest of the system runs without them.

```bash
git clone https://github.com/Garyson26/kindledger-donation-system.git
cd kindledger-donation-system

# Backend - http://localhost:5000
cd Backend
npm install
cp .env.example .env        # fill in real values, see below
npm run dev

# Frontend - http://localhost:5173  (second terminal)
cd Frontend
npm install
npm run dev
```

The backend allows any `http://localhost:<port>` origin outside production, so no
extra CORS setup is needed locally.

### Required environment variables

`Backend/.env` — the variables below are the required ones; the app refuses to
boot without the first two.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | MySQL connection string, e.g. `mysql://user:pass@db:3306/kindledger`. Reserved characters must be percent-encoded |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | Used by the `db` service in the compose stack |
| `JWT_SECRET` | **Must be >= 32 characters.** `openssl rand -hex 32` |
| `ADMIN_CREATION_KEY` | Required before any admin account can be self-registered |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins, no trailing slash |
| `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_BASE_URL` | PayU credentials and environment. **`PAYU_MERCHANT_SALT` is the secret the callback signature is built from — without it the API refuses to build or verify a PayU hash rather than computing one anybody could forge (ENV-01)** |
| `SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL` | Backend `/api/payment/*` callback URLs |
| `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL` | Where donors are redirected after payment |
| `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_SERVICE` | SMTP / Gmail credentials for OTP email |

`Frontend/.env` needs only `VITE_API_URL` — the backend origin, without `/api`.
Vite inlines `VITE_*` values into the public bundle, so never put a secret there.

> `Backend/DEPLOYMENT.md` is out of date and lists variables the code does not
> read. Use `.env.example` and the docs.

## Database requirements

**MySQL 8.0.16 or later, or MariaDB 11.4.5 or later**, with a strict `sql_mode`.

The floor is 8.0.16 because that is where MySQL began *enforcing* `CHECK`
constraints. Below it the constraints in `db/schema.sql` parse and are then
silently ignored, so the schema applies with none of its integrity guarantees.
MariaDB before 11.4.5 has no `utf8mb4_0900_*` collations, and the email
uniqueness guarantee depends on `utf8mb4_0900_as_ci`. MariaDB 11.4.5+ has them,
and CI runs the schema suite against MariaDB 11.8 as well as MySQL 8.4.

All of it is enforced: `npm run db:migrate` and `npm run db:seed` refuse to
proceed on an unsupported server, and the application answers 503 on one. The bundled `docker-compose.yml` provides
a correctly configured `mysql:8.4`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the schema change process, and note
in particular that `prisma migrate dev` must never be run in this repository.

Every connection the application opens runs in **strict SQL mode**
(`STRICT_TRANS_TABLES`): `config/prisma.js` sets it on connect, because shared
hosts often ship a server default that is not strict (DB1). Without it an out-of-set `ENUM` value is stored as the empty string
with only a warning, and the affected donation then matches no status filter —
it vanishes from every report while still sitting in the table.

### Seeding demo data

```bash
cd Backend && npm run seed
```

Populates categories, ~1000 users, and donations. **Every seeded user gets the
password `Password@123`** — never run this against anything sharing a database
with production. See `Backend/scripts/README_SEED.md`.

---

## Repository layout

```
Backend/     Express 5 API - routes, models, middleware, PayU + email config
Frontend/    React SPA - pages, components, api client, styles
```

| Script | Where | Does |
|---|---|---|
| `npm run dev` | both | Dev server (nodemon / Vite) |
| `npm start` | Backend | Production server |
| `npm run seed` | Backend | Seed demo data |
| `npm run build` | Frontend | Production bundle |
| `npm run lint` | Frontend | ESLint |

There is **no test suite** — `npm test` in `Backend/` exits 1 by design. `npm run
lint` is the only automated check in the repo.

---

## Documentation

Detailed documentation is maintained **outside this repository** (the `docs/`
directory is deliberately untracked — see `.gitignore`). Ask a maintainer for:

| Document | Contents |
|---|---|
| `PROJECT.md` | Architecture, data model, authentication design, full API reference, configuration, deployment, known bugs |
| `SECURITY-REVIEW.md` | Security review of commit `938e164`: 21 findings with severities, exploit paths, fixes, and a prioritised remediation plan |

The security review is held outside version control on purpose: it contains
exploit-level detail that should not be published alongside the code.

---

## Security status

A full security review exists and is **deliberately not tracked in this
repository**: it carries exploit-level detail that should not be published
alongside the code. Ask a maintainer for it before deploying.

**Do not deploy this from `main` without reading that review.** Findings remain
open, including in the authentication and payment paths. They are being worked
through in a phased remediation programme tracked in
[`docs/remediation-map.md`](docs/remediation-map.md) and
[`docs/decisions.md`](docs/decisions.md).

Closed so far, with regression tests that run in CI on every push:

- **SEC-01 (critical)** - a donor could replay their own PayU-signed *failure*
  payload and have the donation marked `Paid`. Fixed and covered by 17 tests.
- **SEC-02 (high)** - the password-reset code had no attempt counter. Fixed and
  covered by 6 tests.

This section deliberately no longer enumerates the OPEN findings or how to
reach them. It previously did, which was inconsistent with holding the review
outside version control for exactly that reason - the mechanics were excluded
from the repository and then restated in the file most likely to be read first.
The remediation map names open findings with file and line; before this
repository is published, that map must contain no open items or be redacted of
file and line for those that remain (a Phase 6 gate).

To report a vulnerability, contact the maintainers privately rather than opening
a public issue.

---

## Deployment

Both halves deploy to Vercel as separate projects.

- **Backend** — `Backend/vercel.json` runs the whole Express app as one
  serverless function and pins `NODE_ENV=production`. Set every required variable
  in the Vercel project first; a missing or short `JWT_SECRET` throws on cold
  start.
- **Frontend** — `Frontend/vercel.json` handles SPA rewrites and ships the
  security headers, including a CSP whose `connect-src` and `form-action` must be
  updated whenever the backend origin or PayU environment changes.
- **PayU** — the callback URLs registered in the PayU dashboard must point at the
  deployed backend, and `PAYU_BASE_URL` must match the credential set in use.

Note that the daily retention cron declared in `Backend/vercel.json` currently
fails with a 401 (BUG-04 in the docs), so the purge is not running.

---

## Contributing

- Neither project commits a lockfile today (SEC-12) — this is being fixed; expect
  `package-lock.json` to become required.
- No CI runs on pull requests yet. Run `npm run lint` in `Frontend/` before
  pushing.
- Check the known-bugs list in the project documentation before filing an issue
  — eight functional defects are already documented there.

## License

**[Apache License 2.0](LICENSE).** See [NOTICE](NOTICE).

The four artefacts that previously disagreed - `LICENSE` carrying GPL v3,
`Backend/package.json` declaring ISC, `Frontend/package.json` declaring nothing,
and this section saying "undecided" - now all say Apache-2.0.

### Why Apache-2.0 rather than a copyleft licence

- **GPL-3.0** was never the right fit for this project, and not for the reason
  it is usually rejected. Its copyleft triggers on *conveying* - distributing
  the code - and hosting a modified web application for network users is
  generally not conveying. Someone could fork KindLedger, modify it, run it as a
  donation platform, and publish nothing. **GPL here would impose obligations on
  the people least likely to be the problem** - NGOs distributing a modified
  copy to a peer - while leaving commercial hosting untouched.
- **AGPL-3.0** closes that gap through section 13. It was the serious
  alternative and was rejected because the goal is adoption by small NGOs, and
  AGPL is the licence most likely to make a volunteer developer or a donated
  hosting provider back away.
- **Apache-2.0** grants patent rights explicitly (section 3), which neither MIT
  nor ISC does, and carries attribution into derivative works through the NOTICE
  file (section 4(d)).

### What the licence does NOT do

**It does not protect the "Powered by KindLedger Donation System" footer.** A
fork may remove it, lawfully. That footer is an honour-system request, kept as a
hardcoded component with no configuration surface, and the reason it is not a
licence clause is that a licence forbidding its removal would not be open source
under the OSI definition.

This is stated plainly so that nobody later believes the licence is doing work
it is not. The NOTICE file is the part with legal force; the footer is not.

### On the previous GPL text

Commit `4f3b7ec` added the GPL v3 text while this repository was private. No
public distribution occurred under it, so **no public GPL grant exists** and
nothing is being revoked. This is a first choice, not a change of licence.
