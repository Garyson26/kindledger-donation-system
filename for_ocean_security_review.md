# For Ocean Foundation — Donation Platform Security & Code Review

**Repository:** `for_ocean_foudation_donation_system-main`
**Reviewer:** Gary (Lead Security Engineer)
**Date:** 24 May 2026
**Target environment:** Vercel serverless (backend + frontend), MongoDB Atlas, PayU Money payment gateway, India

---

## How to use this report

Findings are grouped by severity and tagged with an ID (e.g. `BE-CRIT-01`) so the developer can track them. Each entry has:

- **Where** — file and line numbers
- **What** — the issue and why it matters
- **Exploit / impact** — a concrete attack scenario where applicable
- **Fix** — the specific change to make, often with a code snippet
- **Effort** — rough sizing (XS = minutes, S = under an hour, M = a few hours, L = day+)

A suggested remediation order is at the end (section 8).

> **Important caveat:** I have not run this code or tested the live deployment. Every finding below is from static review of the zip. Anything called "exploitable" is exploitable based on the code as written; confirm by reproducing on a staging environment before any public statements. A couple of findings depend on environment variable values (especially `JWT_SECRET` and `ADMIN_CREATION_KEY`) that I can't see from the repo alone — those are flagged.

---

## 1. Executive summary

The platform has three classes of problems, in roughly this order of urgency:

1. **Payment integrity is broken.** The server trusts the donation amount sent by the client, and two of the three PayU callback handlers do not verify the PayU hash. An attacker can either (a) pay ₹1 for a donation that would otherwise cost ₹50,000, or (b) flip donation statuses in the database without paying or authenticating. The PayU `MERCHANT_SALT` is also logged in plaintext to stdout on every payment initiation, which on Vercel means it lands in the Vercel logs. If an attacker reads those logs they can fully spoof success callbacks.
2. **Authorization is missing on most of the API.** Listing all donations, viewing any donation, updating any donation's status, and creating/updating/deleting categories all work with no token. Category mutation is the most damaging: an attacker can rewrite the donation amount on any category.
3. **The remaining issues are the usual hygiene set** — no security headers (you already have the report from the headers scanner), no rate limiting, OTPs generated with `Math.random` and not bound by attempt counters, JWT secret with a predictable fallback, JWT in `localStorage`, raw error messages returned to clients, dependency vulnerabilities in `nodemailer` and `uuid`, dead code, debug logs in production, and a serverless deployment running `node-cron` which silently does nothing.

There are also straightforward bugs: the `seedDatabase.js`/`checkOrder.js` scripts use inconsistent env var names (`MONGO_URI` vs `MONGODB_URI`), the cleanup scheduler runs in code paths it should not on serverless, and `routes/donations.js` loads the entire collection into memory before paginating.

**Headline numbers:** 6 critical, 9 high, 11 medium, 8 low/hygiene findings across backend and frontend.

---

## 2. Critical findings (must fix before next deploy)

---

### BE-CRIT-01 — Server-side amount tampering: client controls how much PayU charges

**Where:** `Backend/routes/payment.js`, `/initiate` handler, lines 32–126.
**Effort:** S.

**What.** The `/api/payment/initiate` endpoint accepts an `amount` field from the request body and uses it directly both to (a) create the `Donation` record in the database and (b) generate the PayU hash that is then sent to PayU. The server never looks up the category and computes the expected amount on its own.

```js
// Backend/routes/payment.js, line 34
const { donationId, amount, baseAmount, extraAmount, firstname, email, phone,
        productinfo, category, item, quantity, userId } = req.body;
// ...
amount: parseFloat(amount).toFixed(2),   // line 89 — straight from req.body
```

**Exploit.** An attacker selects "Save a Turtle" (₹5,000) on the frontend, then intercepts the POST to `/api/payment/initiate` with Burp/mitmproxy/devtools and changes `amount: 5000` to `amount: 1`. The server creates the donation, generates a valid PayU hash for ₹1, and PayU charges ₹1. The attacker gets the same receipt and admin dashboard entry as a legitimate ₹5,000 donor. Multiply by every category and every donor.

**Fix.** Look up the category server-side, compute the amount, ignore the client's value entirely.

```js
// inside POST /initiate, after validating req.body
const Category = require('../models/Category');

const dbCategory = await Category.findById(category);
if (!dbCategory) {
  return res.status(400).json({ error: 'Invalid category' });
}

const qty = Math.max(1, parseInt(quantity, 10) || 1);

// Bound extraAmount so an attacker can't send negative numbers or insane values
const extra = Math.max(0, Math.min(1_000_000, parseFloat(extraAmount) || 0));

const baseAmt = dbCategory.donationAmount * qty;
const totalAmt = +(baseAmt + extra).toFixed(2);

// Use totalAmt below — NEVER req.body.amount
```

Then send `totalAmt` to PayU and save it to the donation record. The frontend can still display its calculated amount for UX, but the server must not trust it.

**Effort:** S — about 30 minutes including a test.

---

### BE-CRIT-02 — PayU `MERCHANT_SALT` logged in plaintext on every payment

**Where:** `Backend/routes/payment.js`, line 11 inside `generateHash`.
**Effort:** XS.

**What.** The hash-generation helper logs both the full hash input string and the generated hash to stdout. The hash input string includes `MERCHANT_SALT` — the entire authentication secret for the PayU integration.

```js
// line 9–17
const hashString = `${payuConfig.MERCHANT_KEY}|${data.txnid}|...|${payuConfig.MERCHANT_SALT}`;
console.log('Hash String:', hashString);   // ← logs the salt
console.log('Generated Hash:', hash);
```

On Vercel, `console.log` lands in the Vercel function logs. Anyone with access to Vercel logs (the foundation's developer accounts, any future hire added to the project, anyone who compromises a developer's Vercel session) can read the salt.

**Exploit.** With the salt, an attacker can compute valid PayU response hashes for arbitrary parameters and POST a forged success callback directly to `/api/payment/success` for any pending donation:

```
POST /api/payment/success
status=success&txnid=<known>&amount=999999&firstname=...&email=...&udf4=<donationId>&hash=<computed>
```

The server's `verifyHash` returns `true`, the donation is marked Paid, the donor gets a receipt — no money was sent to PayU. This is total compromise of the payment gateway integration.

**Fix.** Remove both `console.log` calls. Treat the salt as a secret on par with the JWT signing key.

```js
function generateHash(data) {
  const hashString = `${payuConfig.MERCHANT_KEY}|${data.txnid}|${data.amount}|${data.productinfo}|${data.firstname}|${data.email}|${data.udf1 || ''}|${data.udf2 || ''}|${data.udf3 || ''}|${data.udf4 || ''}|${data.udf5 || ''}||||||${payuConfig.MERCHANT_SALT}`;
  return crypto.createHash("sha512").update(hashString).digest("hex");
}
```

**After deploying the fix, rotate the PayU merchant salt in the PayU dashboard.** Anything logged so far must be treated as compromised. Also audit who has Vercel log access and reduce it to the minimum.

**Effort:** XS for the code change, S including salt rotation and Vercel log purge.

---

### BE-CRIT-03 — `/payment/failure` and `/payment/cancel` do not verify PayU hash

**Where:** `Backend/routes/payment.js`, lines 189–283 (failure) and 286–359 (cancel).
**Effort:** S.

**What.** Both handlers read `paymentData = req.body` and immediately update the donation record. Only `/success` and `/webhook` call `verifyHash`.

```js
// failure handler, after extracting donationId — no hash check
const updatedDonation = await Donation.findByIdAndUpdate(donationId, updateData, { new: true, runValidators: false });
```

**Exploit.** An attacker POSTs to `/api/payment/failure` (or `/failure`, which `app.js` also mounts unauthenticated):

```
POST /api/payment/failure
udf4=<any-donation-id>&txnid=anything&status=failure&error_Message=fraud
```

The donation is marked Rejected / Failed even if it was already paid. The donor's receipt page now shows "failed". This is a denial-of-service against the foundation's donation record-keeping, and could be used as a refund-fraud preparation step ("I paid but you marked it failed, refund me").

The donation IDs aren't even hard to obtain — `GET /api/donations` returns them all unauthenticated (see BE-CRIT-04).

**Fix.** Verify the hash in every callback handler before mutating state. Same `verifyHash(paymentData)` call that `/success` uses.

```js
router.post('/failure', async (req, res) => {
  try {
    const paymentData = req.body;
    if (!verifyHash(paymentData)) {
      console.warn('Failure callback: hash mismatch from', req.ip);
      return res.redirect(`${payuConfig.FRONTEND_FAILURE_URL}?error=invalid_hash`);
    }
    // ...rest of handler
  }
});
```

Do the same in `/cancel`. Also use `crypto.timingSafeEqual` instead of `===` for the comparison (defense in depth; the salt-in-logs issue is bigger).

```js
function verifyHash(data) {
  const expected = /* compute hash */ ;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(data.hash || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

**Effort:** S — under an hour including the timing-safe comparison.

---

### BE-CRIT-04 — `GET /api/donations` returns all donations with donor PII, unauthenticated

**Where:** `Backend/routes/donations.js`, lines 59–143 (and `/filter-options` lines 146–199, and `GET /:id` lines 283–298).
**Effort:** S.

**What.** Three donation-reading endpoints have no auth middleware:

- `GET /api/donations` — paginated list of every donation, with `.populate("userId", "name email")` exposing logged-in donor name and email.
- `GET /api/donations/filter-options` — runs `Donation.find()` over the whole collection.
- `GET /api/donations/:id` — populates `userId` with `name email phone role`. Full donor record by ID.

**Exploit.** An attacker hits `https://donation.foroceanfoundation.com/api/donations?page=1&limit=10000` and downloads the entire donor database: names, emails, donation amounts, transaction IDs, payment modes, addresses (via the `/:id` route which populates phone too). This is a textbook PII leak. Under the DPDP Act (India) this is a reportable personal data breach with potential penalties up to ₹250 crore depending on the volume.

**Fix.** Two parts:

1. **Auth-gate the list and detail endpoints.** Listing should be admin-only, detail should be admin OR the donation's owner.

```js
// Replace
router.get("/", async (req, res) => { ... });
router.get("/filter-options", async (req, res) => { ... });
router.get("/:id", async (req, res) => { ... });

// With
router.get("/", adminAuth, async (req, res) => { ... });
router.get("/filter-options", adminAuth, async (req, res) => { ... });

router.get("/:id", authMiddleware, async (req, res) => {
  const donation = await Donation.findById(req.params.id)
    .populate("category", "name description price")
    .populate("userId", "name email");      // ← drop phone and role
  if (!donation) return res.status(404).json({ error: "Donation not found" });

  const ownerId = donation.userId?._id?.toString() || null;
  const isOwner = ownerId && ownerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json(donation);
});
```

2. **Stop populating `phone` and `role` in donation responses.** No frontend needs them, and they're sensitive PII / authz info respectively.

**Effort:** S, plus a quick check that admin dashboards still work.

---

### BE-CRIT-05 — `PUT /api/donations/:id` has zero authentication

**Where:** `Backend/routes/donations.js`, lines 267–279.
**Effort:** XS.

**What.** This endpoint is not gated by any middleware. Anyone on the internet can change the status of any donation:

```js
router.put("/:id", async (req, res) => {
  const { status } = req.body;
  const donation = await Donation.findByIdAndUpdate(req.params.id, { status }, { new: true });
  res.json({ message: "Donation updated", donation });
});
```

**Exploit.** `PUT /api/donations/<any-id>` with `{"status": "Approved"}` flips an unpaid donation to Approved, or vice versa.

**Fix.** This endpoint duplicates `PATCH /api/donations/:id/status` (which is correctly admin-gated). Either delete it entirely or gate it:

```js
router.put("/:id", adminAuth, async (req, res) => { ... });
```

Recommend deletion to avoid having two endpoints doing the same thing — confusion is its own vulnerability.

**Effort:** XS.

---

### BE-CRIT-06 — All category routes are unauthenticated, including create / update / delete

**Where:** `Backend/routes/categories.js`, every route in the file.
**Effort:** XS.

**What.** `POST /api/categories`, `PUT /api/categories/:id`, `DELETE /api/categories/:id`, and `PUT /api/categories/reorder` are all reachable without a token.

**Exploit.** This is the most damaging single bug in the repo because it compounds with BE-CRIT-01.

1. Attacker creates a malicious category: `POST /api/categories` with `{name: "Emergency Whale Rescue", donationAmount: 10, sortDescription: "...", descriptions: [...]}` — appears on the public donation page.
2. Or rewrites an existing category's `donationAmount` to 1 — every legitimate donor who picks it pays ₹1.
3. Or deletes every category, breaking the donation form for all users.
4. Or reorders so a low-value or fraudulent category is first.

The frontend's `categoriesAPI.create/update/delete` already sends `auth: true`, so legitimate admin clients pass a token — but the server doesn't check it. The frontend is enforcing security the backend isn't.

**Fix.** Gate every mutating route with `adminAuth`. Reads stay public so guests can see categories.

```js
const adminAuth = require('../middleware/adminAuth');

router.post('/',          adminAuth, async (req, res) => { ... });
router.put('/reorder',    adminAuth, async (req, res) => { ... });
router.put('/:id',        adminAuth, async (req, res) => { ... });
router.delete('/:id',     adminAuth, async (req, res) => { ... });
// GET stays public
```

**Effort:** XS — five lines.

---

## 3. High-severity findings

---

### BE-HIGH-01 — Hardcoded JWT secret fallback enables auth bypass if env var is missing

**Where:** `Backend/config/jwt.js`, line 2.
**Effort:** XS.

```js
const JWT_SECRET = process.env.JWT_SECRET || "smart_donation_secret_key_2025";
```

If `JWT_SECRET` is not set in Vercel's environment (a typo, a missed env on a preview deployment, a new staging environment), the app uses the hardcoded string. Anyone with the repo can sign their own JWTs as any user, including admin:

```js
require('jsonwebtoken').sign({ userId: '<any objectId>', role: 'admin' }, 'smart_donation_secret_key_2025');
```

**Fix.** Fail closed.

```js
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET environment variable must be set and at least 32 characters');
}
module.exports = { JWT_SECRET };
```

Verify the Vercel env var is set to a high-entropy value (use `openssl rand -hex 32`). After fixing, rotate the secret — anyone who has the repo could have forged tokens, so all existing tokens should be invalidated. (Rotating the secret automatically invalidates them.)

---

### BE-HIGH-02 — OTPs generated with `Math.random`, no rate limit, no attempt counter

**Where:** `Backend/routes/auth.js`, the `Math.floor(100000 + Math.random() * 900000)` lines (12, 41, 168, 201, 237, 321, 358).
**Effort:** M.

`Math.random()` is not cryptographically secure. More importantly, the OTPs have only ~1 million possible values, the `/login/verify-otp` endpoint has no rate limit and no attempt counter, so an attacker can brute-force the OTP in seconds.

**Exploit.** Attacker knows a target's email. They trigger `/login` (which sends the real OTP to the victim's inbox). The attacker then loops `/login/verify-otp` with all 900,000 possible codes — at even 50 req/s from one IP that's under 5 hours; from a small botnet it's minutes. The OTP is valid for 10 minutes, but with no cap on attempts and no rate limit, the brute-force succeeds within the window.

**Fix.** Three changes:

1. Use `crypto.randomInt`:
   ```js
   const crypto = require('crypto');
   const otp = crypto.randomInt(100000, 1000000).toString();
   ```
2. Add an attempt counter to the User and PendingSignup models, increment on every failed verify, and lock the OTP after 5 failures:
   ```js
   // in User.js schema
   loginOTPAttempts: { type: Number, default: 0 }
   // in /login/verify-otp
   if (user.loginOTPAttempts >= 5) {
     user.loginOTP = undefined;
     user.loginOTPExpires = undefined;
     user.loginOTPAttempts = 0;
     await user.save();
     return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });
   }
   if (user.loginOTP !== otp) {
     user.loginOTPAttempts++;
     await user.save();
     return res.status(400).json({ error: 'Invalid OTP' });
   }
   ```
3. Add `express-rate-limit` to the OTP verify endpoints (see BE-HIGH-03).

**Effort:** M — couple of hours including model migration and tests.

---

### BE-HIGH-03 — No rate limiting on any endpoint

**Where:** `Backend/app.js` — `express-rate-limit` is not installed.
**Effort:** S.

Login, signup, OTP resend, OTP verify, forgot-password, and (critically) the payment-initiate endpoint are all unthrottled. Beyond brute-force, this also means an attacker can use `/auth/signup/resend-otp` and `/auth/forgot-password/request` as an outbound-email DoS to mailbomb arbitrary users — and burn through your SMTP quota.

**Fix.** Vercel serverless makes some rate-limit libraries awkward (no shared in-memory state across function invocations). Options:

- **`express-rate-limit` with a MongoDB store (`rate-limit-mongo`).** Works on serverless because state is in your existing DB.
- **`@upstash/ratelimit` with Upstash Redis.** Vercel has tight Upstash integration; clean serverless story.
- **Vercel WAF / Edge Config rate limits.** Platform-level, no code change, but coarser.

Minimum: limit login/signup/OTP endpoints to ~5 requests per IP per minute and ~10 per email per hour.

```js
const rateLimit = require('express-rate-limit');
const MongoStore = require('rate-limit-mongo');

const authLimiter = rateLimit({
  store: new MongoStore({ uri: process.env.MONGODB_URI, collectionName: 'rateLimits', expireTimeMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}:${req.body.email || ''}`,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

// In auth routes
router.post('/login', authLimiter, async (req, res) => { ... });
router.post('/login/verify-otp', authLimiter, async (req, res) => { ... });
router.post('/signup', authLimiter, ...);
router.post('/forgot-password/request', authLimiter, ...);
```

**Effort:** S — about an hour.

---

### BE-HIGH-04 — Wide-open CORS (`app.use(cors())`)

**Where:** `Backend/app.js`, line 26.
**Effort:** XS.

`cors()` with no options sends `Access-Control-Allow-Origin: *` (which the headers scan you provided also reported). Any website can call your API from a victim's browser. Because auth uses `Authorization: Bearer` headers and `localStorage` rather than cookies, this isn't quite as bad as it would be with cookie auth (CSRF doesn't apply the same way) — but it still:

- Lets any third-party site call your unauthenticated endpoints (donations list, status check, category mutation) with the victim's IP.
- Lets a malicious site hosting JavaScript read responses from your API, useful for opportunistic data-harvesting if you ever add cookie auth or new auth surface.

**Fix.**

```js
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                  // allow same-origin / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

Set `ALLOWED_ORIGINS=https://donation.foroceanfoundation.com,https://www.foroceanfoundation.com` in Vercel.

---

### BE-HIGH-05 — No security headers from the backend; frontend `vercel.json` also missing them

**Where:** `Backend/app.js`, `Frontend/vercel.json`. Confirmed by your headers scan.
**Effort:** S.

The headers scan you ran shows: missing CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. The site is also wide-open with `Access-Control-Allow-Origin: *`.

**Fix — backend (API responses):** add Helmet.

```bash
npm install helmet
```

```js
// app.js, near the top of middleware
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false,    // CSP is more useful on the frontend HTML responses
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
```

**Fix — frontend (HTML/asset responses on Vercel):** Vercel serves the SPA's HTML, so the headers need to come from Vercel. Update `Frontend/vercel.json`:

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), payment=(self)" },
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://for-ocean-foudation-donation-system-one.vercel.app https://secure.payu.in https://test.payu.in; form-action 'self' https://secure.payu.in https://test.payu.in; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

A few notes on the CSP above:

- `style-src 'unsafe-inline'` is included because Tailwind-with-Vite ships some inline styles and many React libs add inline `style=` attributes; tightening this further usually breaks things. Acceptable trade-off given XSS risk is otherwise low (no `dangerouslySetInnerHTML` in the code).
- `connect-src` must include the backend Vercel domain. Update to the production backend domain when you move off the Vercel preview URL.
- `form-action` lists PayU because `DonationForm.jsx` constructs an HTML form and POSTs to PayU. Without this, CSP will block the redirect to PayU.
- `frame-ancestors 'none'` replaces `X-Frame-Options: DENY` and is the modern equivalent. Both are included for older-browser support.

After deploying, re-run securityheaders.com — you should land at A or A+.

**Effort:** S.

---

### BE-HIGH-06 — User enumeration via differentiated error responses

**Where:** `Backend/routes/auth.js` — multiple endpoints return different responses for "user exists" vs "user does not exist."

Specific instances:

- Line 354: `/forgot-password/request` returns `"No account found with this email address"` (404) only if email isn't registered.
- Lines 274, 317, 397: various endpoints return `"User not found"` (404) vs other errors.
- Line 24: `/signup` reveals if an email is already registered.

**Exploit.** Attacker bulk-checks emails against `/forgot-password/request` to find which addresses are registered donors. Combined with no rate limit (BE-HIGH-03), they can enumerate hundreds of thousands.

**Fix.** Return identical responses regardless of email existence on password-reset request and login. The user only needs to know "if this email is registered, an OTP has been sent."

```js
// /forgot-password/request
router.post('/forgot-password/request', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = await User.findOne({ email });
  if (user) {
    const verificationCode = generateVerificationCode();
    user.resetPasswordCode = verificationCode;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();
    await sendVerificationEmail(email, verificationCode, user.name);   // fire-and-forget
  }

  // Same response either way
  res.json({ message: 'If an account exists for this email, a verification code has been sent.', email });
});
```

For signup, leaking that an email is already registered is harder to avoid because the UX requires the user to know to log in instead. Acceptable trade-off, but at minimum throttle aggressively.

---

### BE-HIGH-07 — JWT stored in `localStorage`; CSP partially mitigates but XSS = full token theft

**Where:** `Frontend/src/utils/api.js`, `Frontend/src/App.jsx`, multiple pages.
**Effort:** L.

Any XSS — including a third-party CDN compromise of any script you load, or a future regression where someone uses `dangerouslySetInnerHTML` — exfiltrates the JWT instantly.

**Fix.** Two paths:

- **Best (L effort):** Move auth to `httpOnly` `Secure` `SameSite=Strict` cookies. This requires backend changes (set-cookie on login/verify-otp, read cookie in middleware), CSRF protection (since cookies auto-send), and frontend changes (drop the `Authorization` header, send `credentials: 'include'` on fetch). Significant rework.
- **Pragmatic (S effort):** Keep localStorage for now, mitigate via CSP (BE-HIGH-05 above), and shorten JWT lifetime to 15–30 minutes with a refresh token rotation. The current 1-hour login token is OK; the 1-day token from `signup/verify-otp` (line 139) is too long.

Pick the pragmatic path now and the cookie migration later if you outgrow it.

---

### BE-HIGH-08 — Regex injection in admin user search → ReDoS

**Where:** `Backend/routes/admin.js`, lines 41–45.
**Effort:** XS.

```js
filter.$or = [
  { name:  { $regex: search, $options: 'i' } },
  { email: { $regex: search, $options: 'i' } },
  { phone: { $regex: search, $options: 'i' } },
];
```

An admin (or anyone who compromises an admin account) supplying a catastrophic regex like `(a+)+$` against a large user collection makes MongoDB hang the entire serverless function until Vercel times it out. Not exploitable by anonymous users (admin-gated), so it's High not Critical — but trivially fixable.

**Fix.** Escape the input and use it as a substring match.

```js
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// ...
if (search) {
  const safe = escapeRegex(search);
  filter.$or = [
    { name:  { $regex: safe, $options: 'i' } },
    { email: { $regex: safe, $options: 'i' } },
    { phone: { $regex: safe, $options: 'i' } },
  ];
}
```

---

### BE-HIGH-09 — Unbounded request bodies

**Where:** `Backend/app.js`, lines 22–23.
**Effort:** XS.

```js
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
```

No `limit` option means Express defaults apply (100kb), which is OK for JSON but with extended form encoding and no body cap on routes accepting `descriptions` arrays in categories, an attacker can post a 100kb JSON blob with a 10-million-element array. Combined with no auth on category mutation (BE-CRIT-06), trivial DoS.

**Fix.**

```js
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
```

PayU callbacks fit comfortably under 32kb.

---

## 4. Medium-severity findings

---

### BE-MED-01 — Pagination loads entire collection into memory before slicing

**Where:** `Backend/routes/donations.js`, `GET /` (lines 59–143) and `/filter-options` (146–199).

```js
let donations = await query;                          // ALL results
// then filter in JS
const total = donations.length;
const paginatedDonations = donations.slice(skip, skip + limitNum);
```

At a few thousand donations this is fine. At 100k+ it starts to OOM the serverless function. Use MongoDB-side pagination:

```js
const total = await Donation.countDocuments(filter);
const donations = await Donation.find(filter)
  .populate("category")
  .populate("userId", "name email")
  .sort({ createdAt: -1 })
  .skip(skip)
  .limit(limitNum);
```

For the `searchQuery` filter, add it to the Mongo query with `$or` over `donorName` and `donorEmail` (using `$regex` with escaped input — see BE-HIGH-08).

---

### BE-MED-02 — `node-cron` scheduler runs on every serverless invocation

**Where:** `Backend/services/dataCleanupService.js` and `Backend/app.js` line 49.

`app.js` calls `initializeCleanupScheduler()` on every cold start. On Vercel each function instance is short-lived; the cron schedule registers and then dies before 2:00 AM ever arrives. The cleanup never runs in production.

This is two bugs: (a) wasted CPU on every cold start registering the cron, (b) the data retention policy in `DEPLOYMENT.md` ("Donations: 10 years") is not actually being enforced — which is a compliance issue if you ever claim it externally (DPDP Act, your privacy policy page exists at `PrivacyPolicy.jsx`).

**Fix.** Move cleanup to a real cron. Two clean options on Vercel:

1. **Vercel Cron Jobs.** Create `Backend/api/cleanup.js` that exports a handler calling `runCleanup()`, then add to `vercel.json`:
   ```json
   "crons": [{ "path": "/api/cleanup", "schedule": "0 2 * * *" }]
   ```
   Secure the handler by checking the `Authorization` header against a cron secret.
2. **External scheduler (e.g. cron-job.org, GitHub Actions, EasyCron)** hitting a protected `/api/admin/cleanup/trigger` endpoint.

Either way, remove the `initializeCleanupScheduler()` call from `app.js` (or gate it on `!process.env.VERCEL`, since the cron only works in self-hosted environments).

---

### BE-MED-03 — `app.js` mounts payment routes under multiple prefixes without explanation

**Where:** `Backend/app.js`, lines 38–41.

```js
app.use("/webhook", paymentRoutes);
app.use("/success", paymentRoutes);
app.use("/failure", paymentRoutes);
app.use("/cancel", paymentRoutes);
```

The comment says "PayU sometimes strips the /api/payment prefix." This is unusual; usually it's because the `surl/furl/curl` config in PayU was set to URLs that don't include `/api/payment`. The effect is that every route in `paymentRoutes` is exposed under five different paths: `/api/payment/initiate`, `/webhook/initiate`, `/success/initiate`, etc. Each one a fresh attack surface duplicating BE-CRIT-01/03.

**Fix.** Set the PayU callback URLs (`SUCCESS_URL`, `FAILURE_URL`, `CANCEL_URL`, `NOTIFY_URL` env vars) to the full `/api/payment/...` paths, and remove the fallback mounts. If for some reason the prefix-stripping is real, mount only the relevant single endpoints:

```js
const paymentRouter = require('./routes/payment');
app.post('/webhook', (req, res, next) => paymentRouter.handle({ ...req, url: '/webhook' }, res, next));
// ... or just configure PayU correctly and use one mount
app.use('/api/payment', paymentRouter);
```

The cleanest answer is "one route, one mount." Audit which fallbacks are actually being hit from PayU; my bet is none.

---

### BE-MED-04 — Forgot-password code only 6 digits, expires after 15 minutes, no attempt counter

**Where:** `Backend/routes/auth.js`, lines 343–422.

Same brute-force concern as BE-HIGH-02 but lower because (a) password reset is less commonly hit and (b) the response page doesn't auto-login. Still, ~5 minutes of brute-forcing gets you in. Add an attempt counter (same pattern as BE-HIGH-02) and consider switching to a longer reset token (e.g. 32 hex chars) sent in the email link rather than a 6-digit code — UX is the same (user clicks link or types code), security is much better.

---

### BE-MED-05 — Email HTML injection via `userName` and `email` interpolation

**Where:** `Backend/config/email.js`, lines 58, 137, 203 (`${userName}` and `${email}` interpolated raw into HTML).

A user signing up with name `<img src=x onerror=alert(1)>` (or, more usefully, a link masquerading as a foundation message) gets that HTML rendered in their own welcome email. Mostly self-targeted (the email goes back to the same address), but:

- HTML in the `name` field could be used to craft phishing-style messages embedded in legitimate-looking emails (e.g. "Click here to confirm your donation") sent from your domain. Spam filters trust transactional emails from established senders.
- Even modern email clients render `<a>` tags. Some still render inline CSS, allowing visual spoofing.

**Fix.** Sanitize.

```js
function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
// then
<p>Hi ${escapeHtml(userName)},</p>
```

Apply to every `${userName}` and `${email}` use in the email templates.

---

### BE-MED-06 — Admin can delete or demote themselves; no last-admin protection

**Where:** `Backend/routes/admin.js`, lines 150–242.

The sole admin can `DELETE /api/admin/users/<own-id>` (line 230) or `PUT /api/admin/users/<own-id>` setting `role: 'user'` (line 150) and lock the entire foundation out. The recovery path is a manual MongoDB update.

**Fix.**

```js
router.delete('/users/:id', async (req, res) => {
  if (req.user.id === req.params.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const adminCount = await User.countDocuments({ role: 'admin' });
  const target = await User.findById(req.params.id);
  if (target?.role === 'admin' && adminCount <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  // ...
});

router.put('/users/:id', async (req, res) => {
  if (req.body.role && req.body.role !== 'admin' && req.user.id === req.params.id) {
    return res.status(400).json({ error: 'Cannot demote yourself' });
  }
  // ...
});
```

---

### BE-MED-07 — `seedDatabase.js` creates 1000 users with the same password `Password@123`

**Where:** `Backend/scripts/seedDatabase.js`, line 145.

If this script is ever pointed at the production DB (it uses `MONGODB_URI`), you get 1000 real-looking accounts with a known shared password. Even on staging, those accounts are credential-stuffing fodder if staging is reachable.

**Fix.**

1. Refuse to run against production:
   ```js
   if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SEED !== 'true') {
     console.error('Seed script refuses to run without explicit ALLOW_SEED=true and non-production NODE_ENV');
     process.exit(1);
   }
   ```
2. Generate a unique random password per seed user (and log to a file you can `.gitignore`).

---

### BE-MED-08 — Backend exposes raw error messages to clients

**Where:** All routes return `{ error: err.message }` in `catch` blocks (auth, donations, admin, etc.).

`err.message` from Mongoose can include schema details, field names, and sometimes parts of the failing query. Useful in dev, terrible in prod — gives attackers a free schema dump.

**Fix.** Add an error-handling middleware and route through it.

```js
// app.js, last middleware
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});
```

Inside route handlers, prefer `next(err)` or just throw and let the middleware handle it.

---

### BE-MED-09 — `runValidators: false` on payment updates skips schema validation

**Where:** `Backend/routes/payment.js`, lines 166, 244, 333.

If the `Donation` schema later adds, e.g., `required: true` on a new field or a validator on `amount`, payment callbacks will silently write invalid documents. Today not exploitable, but a latent footgun.

**Fix.** Drop `runValidators: false` unless you have a specific reason. If the reason is "PayU sometimes sends weird types," coerce/normalize the data first, then validate.

---

### BE-MED-10 — Open-redirect-like behaviour via `FRONTEND_FAILURE_URL` interpolation

**Where:** `Backend/routes/payment.js`, lines 179, 272, 281, 352, 357.

The redirect URLs interpolate `paymentData.txnid` and `error` query params directly. `txnid` is user-controllable (attacker POSTs to `/api/payment/failure`). If `FRONTEND_FAILURE_URL` ever changes to include a redirect-after-failure pattern, this becomes an open redirect. Today it's only a minor info-leak / XSS-via-frontend-rendering risk if the frontend renders these params without escaping.

**Fix.** URL-encode and sanitize before interpolation. Most are already wrapped in `encodeURIComponent` — but the `/success` handler at line 179 is not:

```js
res.redirect(`${payuConfig.FRONTEND_SUCCESS_URL}?txnid=${encodeURIComponent(paymentData.txnid || '')}&amount=${encodeURIComponent(paymentData.amount || '')}&status=${encodeURIComponent(paymentData.status || '')}`);
```

---

### BE-MED-11 — Dependency vulnerabilities

`npm audit` results against the backend `package.json`:

| Package | Current | Issue | Fix version |
| --- | --- | --- | --- |
| `nodemailer` | `^7.0.12` | GHSA-vvjj-xcjg-gr5g — SMTP command injection via CRLF in transport name (CVSS 4.9) and GHSA-c7w3-x93f-qmm8 — envelope.size injection. Only exploitable if user input flows into `transporter` configuration, which it doesn't in your code today — but the patch is free. | `8.0.8` (major bump, but API-compatible for your use) |
| `uuid` | `^8.3.2` | GHSA-w5hq-g745-h8pq — buffer bounds in v3/v5/v6. You don't use those versions in code, low practical impact, but still. | `11.x` |

Frontend has two moderate vulns in `esbuild`/`vite` (dev-server-only, no prod impact).

```bash
cd Backend && npm install nodemailer@^8 uuid@^11
cd Frontend && npm install vite@latest
```

Set up Dependabot or Renovate on the GitHub repo so this isn't a manual chore. As a TIP author (Wiestell), you'd appreciate the supply-chain hygiene.

---

## 5. Low-severity / hygiene findings

---

### LOW-01 — Inconsistent env var name: `MONGO_URI` vs `MONGODB_URI`

`Backend/checkOrder.js` uses `process.env.MONGO_URI`, everywhere else uses `MONGODB_URI`. The script silently fails on a real env. Pick one (`MONGODB_URI`) and grep for the other.

### LOW-02 — Committed `Frontend/.env`

The file only contains the API URL (not a credential), but `.gitignore` says `.env` should be excluded. Either:

- Remove from the repo (`git rm --cached Frontend/.env`) and add `VITE_API_URL` to Vercel env, or
- Rename to `Frontend/.env.example` if it's meant as a template.

### LOW-03 — Duplicate `AddCategoryForm.jsx` in `components/` and `pages/`

Two different versions of the same file. Decide which is canonical, delete the other, update imports.

### LOW-04 — `pdfGenerator_backup.js` and `pdfGenerator_old.js` are identical dead files

Both files are byte-for-byte identical, neither is imported. Delete both.

### LOW-05 — `console.log`/`console.error` everywhere (163 occurrences in backend)

Use a real logger (`pino`, `winston`) with log levels. Set the level to `warn` in production. Today every request logs the full PayU `paymentData` (with hash), donation IDs, and stack traces — Vercel logs are an attractive secondary attack surface (see BE-CRIT-02).

### LOW-06 — `module.exports` declared before `sendLoginOTP`/`sendSignupOTP` definitions in `email.js`

Hoisting saves it today, but fragile. Move `module.exports` to the bottom of the file.

### LOW-07 — No `.env.example` in Backend

Add one listing every required env var so new developers don't guess.

```
MONGODB_URI=mongodb+srv://...
JWT_SECRET=<32-byte-hex>
ADMIN_CREATION_KEY=<random-32-byte-hex>
ALLOWED_ORIGINS=https://donation.foroceanfoundation.com
PAYU_MERCHANT_KEY=
PAYU_MERCHANT_SALT=
PAYU_BASE_URL=https://test.payu.in
SUCCESS_URL=
FAILURE_URL=
CANCEL_URL=
NOTIFY_URL=
FRONTEND_SUCCESS_URL=
FRONTEND_FAILURE_URL=
EMAIL_SERVICE=gmail
EMAIL_USER=
EMAIL_PASSWORD=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
```

### LOW-08 — Password minimum length is 6 characters

`Backend/routes/auth.js` line 433, `Backend/routes/admin.js` line 207. NIST SP 800-63B recommends 8 minimum, ideally checked against a breached-password list (`zxcvbn` or HIBP API). At minimum, raise to 10.

---

## 6. Bugs (non-security)

- **`checkOrder.js` doesn't work** (wrong env var name — LOW-01).
- **`searchQuery` filter applied after `await query`** means it operates on the populated array, slow at scale (BE-MED-01).
- **`paymentData.txnid` is set to PayU's response value during `/success`** but the donation row already has a `transactionId` from initiation. If PayU returns a different `txnid`, the row's transactionId changes and the donor's success page can't look it up afterwards. Probably not happening in practice, but worth a defensive log.
- **Auth middleware looks up the user on every request** — N+1 against Mongo, fine for now, will become a bottleneck. Cache the user lookup with a TTL or carry role in the JWT and verify only at sensitive checkpoints.
- **`PUT /api/donations/:id` and `PATCH /api/donations/:id/status`** are duplicate endpoints (BE-CRIT-05). Pick one.

---

## 7. Architecture & code hygiene notes

These are not bugs, just things worth knowing:

- **`Backend/controllers/authController.js` is dead code.** `routes/auth.js` reimplements signup/login directly with the OTP flow. The controller still has the old vulnerable signup that lets clients set `role` from `req.body.role`. Delete the controller file entirely — it's a footgun if a future developer reattaches the route. The controllers/ folder is otherwise unused.
- **No tests.** `npm test` is a placeholder. At least add a smoke test for `/payment/initiate` server-side amount calculation (BE-CRIT-01) so the fix doesn't regress.
- **No linting on the backend.** Frontend has ESLint; backend doesn't. Adding `eslint:recommended` + `eslint-plugin-security` would catch a lot of this automatically.
- **No request validation library.** Consider `zod` or `joi` for body validation on every route, especially the payment routes. Right now validation is ad-hoc per route.
- **Frontend has unused dev routes** in `App.jsx` (`/buttons`, `/tailwind-test`). Remove from prod build via a NODE_ENV check.
- **The data-retention policy in DEPLOYMENT.md is not implemented** (BE-MED-02). Either update the policy or fix the implementation. Right now your privacy policy may not match what the system actually does, which is a DPDP Act compliance issue.

---

## 8. Suggested remediation order

If the developer can do this over a single week:

**Day 1 — stop the bleeding:**
1. BE-CRIT-02: Remove `console.log` of hash string; rotate PayU salt.
2. BE-CRIT-06: Add `adminAuth` to all category mutating routes.
3. BE-CRIT-05: Delete or gate `PUT /api/donations/:id`.
4. BE-CRIT-04: Add auth to `GET /api/donations`, `/filter-options`, `/:id`; drop `phone`/`role` from populate.
5. BE-HIGH-01: Remove JWT_SECRET fallback; verify env var is set with high entropy; rotate.

**Day 2 — payment integrity:**
6. BE-CRIT-01: Server-side amount calculation from category.
7. BE-CRIT-03: Hash verification in `/failure` and `/cancel`.
8. BE-MED-03: Decide on single payment route mount; remove fallback mounts.

**Day 3 — hardening:**
9. BE-HIGH-04: Lock down CORS.
10. BE-HIGH-05: Add Helmet on backend, security headers in frontend `vercel.json`. Re-run securityheaders.com.
11. BE-HIGH-09: Body size limits.
12. BE-MED-08: Generic error response middleware.

**Day 4 — auth strengthening:**
13. BE-HIGH-02: `crypto.randomInt` + OTP attempt counter.
14. BE-HIGH-03: Rate limiting on auth endpoints (MongoDB store).
15. BE-HIGH-06: Generic responses on forgot-password and login.
16. BE-MED-04, BE-MED-05, BE-MED-06, BE-MED-07.

**Day 5 — clean-up:**
17. BE-MED-01: Mongo-side pagination.
18. BE-MED-02: Real cron via Vercel Crons.
19. BE-MED-11: Dependency upgrades + Dependabot.
20. All Low-severity items.

**Out-of-band (don't block on these but do them):**
- BE-HIGH-07: Plan the httpOnly cookie migration when there's a quiet sprint.
- Add tests (smoke + integration for the payment flow).
- Add CI with `npm audit` and `eslint-plugin-security`.

---

## 9. Notes specific to your deployment

A few things to verify in Vercel after you deploy fixes:

1. **Confirm `JWT_SECRET` is set in all three Vercel environments** (Production, Preview, Development) to the same high-entropy value. Preview deployments use the same secret as production by default but it's worth checking.
2. **Rotate `PAYU_MERCHANT_SALT`** after fixing BE-CRIT-02 and BE-CRIT-03. The salt may have been logged historically; treat it as burned.
3. **Audit Vercel team membership** — every member of the project can read function logs. Reduce to the people who need it.
4. **Vercel function logs retention** — if you're on the Hobby plan, logs are short-lived which limits historical exposure of BE-CRIT-02. On Pro they persist longer. Either way, do a one-time log purge after rotating secrets.
5. **MongoDB Atlas IP allowlist** — `DEPLOYMENT.md` suggests `0.0.0.0/0`. Vercel publishes [its egress IP ranges](https://vercel.com/docs/edge-network/regions); if you don't need other access, allowlist only those.
6. **PayU dashboard** — verify the `surl`/`furl`/`curl` are set to `/api/payment/success`, `/api/payment/failure`, `/api/payment/cancel` exactly. This will let you remove the fallback mounts in `app.js` (BE-MED-03).
7. **DPDP Act** — given you handle Indian donor PII, document the retention schedule, the legal basis for processing, and have a breach notification plan ready. The Donation model currently keeps PII forever (10-year cleanup is dead code per BE-MED-02). Decide whether donors should be able to request deletion via a self-serve flow.

---

## 10. What I didn't review

For transparency:

- **The actual deployed site** at `https://donation.foroceanfoundation.com/` — I reviewed only the zip contents. There may be additional Vercel-side configuration not visible in the repo (env vars, redirects, etc.).
- **PayU integration end-to-end** — I assume the PayU hash formula in the code matches PayU's documentation. Worth verifying against PayU's current [PayU Money integration docs](https://devguide.payu.in/) since they have updated the hash formula over time.
- **MongoDB Atlas configuration** — IP allowlist, network peering, encryption at rest, backups.
- **Email deliverability and SPF/DKIM** — important for the OTP flow but out of scope for code review.
- **Penetration testing** — this is a code review, not a pentest. Several findings here (BE-CRIT-01, BE-CRIT-04, BE-CRIT-06) should be re-verified by actually exploiting them on staging to confirm impact before sharing externally.

---

*End of report.*
