# KindLedger Donation System

An online donation platform for **For Ocean Foundation**. Donors browse donation
categories, give as a guest or a registered user, and pay through **PayU Money**.
Administrators manage categories, donors, and donation records from an admin
console with reporting and PDF receipts.

**Stack:** React 18 + Vite SPA · Express 5 API on Node 20 · MongoDB Atlas ·
PayU Money · deployed as two Vercel projects.

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

**Prerequisites:** Node >= 20, npm >= 10, a MongoDB instance, PayU test
credentials, and an SMTP account (Gmail App Password works).

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
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | **Must be >= 32 characters.** `openssl rand -hex 32` |
| `ADMIN_CREATION_KEY` | Required before any admin account can be self-registered |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins, no trailing slash |
| `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_BASE_URL` | PayU credentials and environment |
| `SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL` | Backend `/api/payment/*` callback URLs |
| `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL` | Where donors are redirected after payment |
| `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_SERVICE` | SMTP / Gmail credentials for OTP email |

`Frontend/.env` needs only `VITE_API_URL` — the backend origin, without `/api`.
Vite inlines `VITE_*` values into the public bundle, so never put a secret there.

> `Backend/DEPLOYMENT.md` is out of date and lists variables the code does not
> read. Use `.env.example` and the docs.

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

A full review exists (see Documentation above; not tracked in this repository).
**One critical and four high-severity findings are open**, concentrated in the
payment callbacks and the password-reset flow. Read it before deploying.

Fix these first:

1. **SEC-01 (critical)** — `/api/payment/success` never checks the signed `status`
   field, so a donor can replay their own PayU-signed *failure* payload and have
   the donation marked `Paid`.
2. **SEC-02 (high)** — the 6-digit password-reset code has no rate limit and no
   attempt counter, allowing unauthenticated account takeover by brute force.
3. **SEC-04 (high)** — rate limiting does not work in production: an in-memory
   store on serverless, and `trust proxy` is never set behind Vercel's proxy.
4. **SEC-03 (high)** — `email` flows unvalidated from JSON bodies into Mongoose
   queries, permitting NoSQL operator injection.
5. **SEC-05 (high)** — `isActive` is never checked at login, so "disable user"
   has no effect.

An earlier review (`for_ocean_security_review.md`) is **superseded** — most of its
findings have since been fixed, and appendix A of the current review tracks the
status of each one.

To report a vulnerability, contact the maintainers privately rather than opening a
public issue.

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

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE)
for the full text.

GPL-3.0 is a strong copyleft licence: you may use, modify, and redistribute this
code, but any derivative you distribute must also be released under GPL-3.0 with
its source available. Both `package.json` files declare `GPL-3.0-only` to match.
