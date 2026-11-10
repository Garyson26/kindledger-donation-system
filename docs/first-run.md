# First run: the first admin, then the categories

**For: whoever installs KindLedger on an empty database** - on Vercel with a
hosted MySQL/MariaDB, or with `docker compose`. Nothing here needs SQL. The
admin is created through the API, and the categories through the admin screens.

`npm run db:seed` is **not** this. It is a demo seeder that empties every table
and refuses to run when `NODE_ENV=production`.

---

## 0. Before you start

| Check | How |
|---|---|
| **The schema is installed** | Vercel / hosted database: `npm run db:migrate` (deployment-environment §1.4). Compose: a fresh `db` volume applies `db/schema.sql` on first start |
| **The backend answers** | `GET /api/health` returns 200 |
| **Email sends** | Signup and every login send a code by email. With mail not working you cannot finish step 2 or log in. Check the `EMAIL_*`/`SMTP_*` variables first |
| **The frontend is deployed** | Needed for step 4 (categories). Steps 1-3 need only the backend |

---

## 1. Turn on admin creation, briefly

Admin accounts can only be created through `POST /api/auth/signup` with
`role: "admin"` and an `adminKey` equal to the `ADMIN_CREATION_KEY` variable.
Without the variable, admin creation is refused (403). **That is the normal
state.**

1. Generate a fresh key:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
2. Set it as `ADMIN_CREATION_KEY` on the backend.
   - **Vercel:** Production only, type Sensitive, then **redeploy**. A new
     variable reaches only new deployments.
   - **Compose:** put it in `.env`, then `docker compose up -d api`.

**While it is set, anyone who has the key can make themselves an admin** through
the public signup endpoint. So keep it out of chat, tickets and notes, and do
step 3 as soon as step 2 is done.

## 2. Create the admin account

From any terminal. Use an address you can read mail at, and a password of **at
least 10 characters**. Replace `<backend>` with the backend's address, e.g.
`https://kindledger-api.vercel.app`.

**PowerShell (Windows):**
```powershell
$api = '<backend>/api/auth'
$body = @{ name = 'Your Name'; email = 'you@example.org'; password = '<password>'; role = 'admin'; adminKey = '<the key>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/signup" -ContentType 'application/json' -Body $body
```

**curl (macOS / Linux):**
```bash
curl -sS -X POST '<backend>/api/auth/signup' -H 'Content-Type: application/json' \
  -d '{"name":"Your Name","email":"you@example.org","password":"<password>","role":"admin","adminKey":"<the key>"}'
```

A 200 says to check your email, **and says the same whether or not the address
already has an account** (SEC-08). A 403 means the key does not match the one
the running deployment has: did you redeploy?

Then send the six-digit code from the email, **with the same password**. The
password is required here too: it is what stops someone who sees the code from
finishing a signup they did not start.

```powershell
$body = @{ email = 'you@example.org'; otp = '<code>'; password = '<password>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/signup/verify-otp" -ContentType 'application/json' -Body $body
```
```bash
curl -sS -X POST '<backend>/api/auth/signup/verify-otp' -H 'Content-Type: application/json' \
  -d '{"email":"you@example.org","otp":"<code>","password":"<password>"}'
```

The account exists once this succeeds. Codes expire; `/api/auth/signup/resend-otp`
with `{"email": ...}` sends a new one.

**If an address already had an account,** signup sends that address a notice
instead of a code and creates nothing. Use an address with no account.

## 3. Turn admin creation off again

- **Vercel:** delete `ADMIN_CREATION_KEY`, then **redeploy**. Deleting it does
  nothing to the deployment that is already running.
- **Compose:** the file **requires** the variable (`:?`), so it cannot be
  removed without editing `docker-compose.yml`. Replace it in `.env` with a
  **new** random value that you do not write down, then
  `docker compose up -d api`. The old key stops working, and nobody holds the
  new one.

**Check it is off.** Repeat the step 2 signup with the old key. It must
answer **403**.

## 4. Log in and add the categories

1. Open the frontend's `/login`. Log in with the admin address. A code is
   emailed; enter it.
2. Go to **Admin → Categories** (`/admin/categories`) and **Add category**
   (`/admin/add-category`). Each category needs a name, a short description, a
   donation amount (greater than zero, at most two decimal places) and its
   description text. Names must be unique.
3. **Branding** (`/admin/branding`): the install creates one default branding
   row, so this is an edit, not a create. Set the organisation name, colours
   and logo.

## 5. Check from the donor side

Log out, open the frontend's home page and confirm the categories and branding
show. A donation is the go-live checklist's job, not this one (Phase 6
checklist §5.3).

---

**Why not a script that inserts the admin directly?** Through the API the
account gets exactly what a real signup gets: the password hashed at the
application's cost, the email verified by a code, and every field validated.
A row written by hand gets none of that unless someone reimplements it.
