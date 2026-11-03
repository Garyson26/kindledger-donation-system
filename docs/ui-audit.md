# SPEC-5 package 5.1 — UI audit

**No code changed when this was written.** This is the list SPEC-5 §7 asks for.

> ### CORRECTED AFTER IMPLEMENTATION — TWO OF SEVEN ITEMS WERE WRONG
>
> **B2 is withdrawn entirely** and **M1 is halved.** Both errors came from the
> same method: I counted greps (`catch` occurrences, `length === 0` occurrences)
> and treated the count as the property. Implementing them is what read the code.
>
> That is the metric-for-property mistake this project has recorded repeatedly —
> BB4's flag that was the only check on itself, BH2's presence-versus-execution —
> committed in an audit whose whole job was to look. **A proxy applied
> systematically is worse than judgement, because it looks rigorous.**
>
> BN4 said a negative result from a rule applied systematically is worth more
> than the same conclusion by inspection. That holds only when the rule measures
> the property. Here it measured a correlate, and two of seven cells were wrong.

Every item is one line on what is wrong and one on what it should be. No
redesigns, no new features — the existing visual language is the constraint.

---

## Broken

### B1. `ChangePassword` never shows the server's message

`src/pages/ChangePassword.jsx:26` reads `data.msg`. **BUG-11 unified the error
shape and dropped `msg`**, so this is always `undefined` and the hardcoded
fallback is shown every time — including when the server explained something
useful.

*Should:* read `data.message`, matching every other caller.

**This is SPEC-5 §7's third known item, found live.** It is the only surviving
reader of the old shape; the rest of the frontend already uses `error`/`message`.

### ~~B2. `AdminUsers` has no error handling at all~~ — WITHDRAWN, NOT A DEFECT

**This was wrong.** `AdminUsers.jsx` handles every failure. It has no `catch`
blocks because **`utils/api.js` never throws**: it catches network errors itself
and returns `{ ok: false, error }`. Every call site there destructures
`{ ok, error }` and calls `showToast(error || "…")` — eight of them.

I counted `catch` occurrences, found zero, and wrote "no error handling at all".
The count was accurate and the conclusion was false.

*Action: none. Recorded rather than deleted, because a withdrawn finding that
vanishes teaches nothing about how it got written.*

### B3. Two development routes are shipped to production

```jsx
{/* Tailwind Test Route - Remove this after verification */}
<Route path="/tailwind-test" element={<TailwindTest />} />
<Route path="/button-showcase" element={<ButtonShowcase />} />
```

The comment says to remove them. They are reachable by anyone on the deployed
site and are not behind any guard.

*Should:* deleted, along with `TailwindTest.jsx` and `ButtonShowcase.jsx`.

---

## Inconsistent

### I1. Three `pdfGenerator` files, two of them byte-identical and unimported

| File | Bytes | SHA-1 (12) | Imported by |
|---|---|---|---|
| `pdfGenerator.js` | 12,825 | `a42e12711b57` | 5 pages |
| `pdfGenerator_backup.js` | 20,507 | `233d3e8bf815` | **nothing** |
| `pdfGenerator_old.js` | 20,507 | `233d3e8bf815` | **nothing** |

The two dead ones are the same file under two names — and both are **larger**
than the live one, so anyone opening them assumes they are the current version.

*Should:* delete both. Recorded as AS6.

### I2. A second `AddCategoryForm` that nothing imports

`src/pages/AddCategoryForm.jsx` (1,415 bytes) is unreferenced. All three
consumers — `AddCategory`, `AdminCategories`, `EditCategory` — import
`src/components/AddCategoryForm.jsx` (8,542 bytes).

*Should:* delete the `pages/` copy.

**Not previously recorded.** AS6 covered the `pdfGenerator` duplicates; this is
the same shape one directory away, and was found by enumerating the tree rather
than by looking where the known duplicate was (AY2).

---

## Missing

### M1. No empty state on `AdminCharts` — HALVED

**`AdminCharts` is real.** `stats` starts `null` and is set only on a successful
fetch, so an empty database or a failed request rendered charts against nothing.

**`DonationDetails` was wrong.** It has a not-found state already
(`src/pages/DonationDetails.jsx:116`, `{error || 'Donation not found'}`). Same
grep-counting mistake as B2.

*Done in 5.6:* an explicit "no donation statistics to show yet" branch on
`AdminCharts` only.

---

## A decision, not a fix — for Gary

### D1. Can a guest retrieve their own donation?

`MyDonations` takes a `userId` and returns early without one
(`src/pages/MyDonations.jsx:40`). A guest donation has `user_id` NULL, so
**ownership can never match and a guest can never see their donation again** —
they have only the receipt shown once at payment.

Recorded in AG4 as an accident of the data model rather than a decision. It
stays an accident until somebody decides.

The options are not equal in risk:

- **Leave it.** A guest keeps the emailed receipt or nothing.
- **Look up by transaction reference.** Needs the txnid, which is in the
  receipt — but a `txnid` that can be guessed or enumerated is then a lookup key
  for a stranger's donation record. `mintTransactionRef` is 20 random hex
  characters, so guessing is not the risk; **forwarding the receipt is**.
- **Look up by email + a mailed link.** Safe, and it is a new flow with its own
  rate-limiting and enumeration questions — the SIGNUP-01 shape.

*This is U-3's sibling and needs a decision before it needs code.*

---

## For package 5.3, not 5.1: the hardcoded organisation name

Enumerated per SPEC-5 §5.3 — **9 occurrences across 8 files**, not grepped once
and assumed:

| File | Occurrences |
|---|---|
| `index.html` | 1 (the page `<title>`) |
| `src/pages/LoginPage.jsx` | 2 |
| `src/pages/SignupPage.jsx` | 2 |
| `src/pages/Navbar.jsx` | 1 |
| `src/pages/Footer.jsx` | 1 |
| `src/pages/PrivacyPolicy.jsx` | 1 |
| `src/pages/TermsOfService.jsx` | 1 |
| `src/utils/pdfGenerator.js` | 1 (the receipt) |

`index.html` and `pdfGenerator.js` are the two that a component-level
find-and-replace would miss: one is outside React entirely, the other renders a
PDF rather than a page. Both are named in SPEC-5 §5.3 and both are here to be
checked off rather than rediscovered.

---

## Not in this list, and why

- **Visual design.** SPEC-5 §1 makes the existing palette the target.
- **`Frontend/.env` being tracked.** Real, but it is a repository hygiene item
  (BJ4), not a UI one, and it holds only `VITE_API_URL`, which Vite embeds
  publicly anyway.
- **react-router v7.** Package 5.5 owns it.

---

## What was implemented (SPEC-5 package 5.6)

| Item | Status |
|---|---|
| **B1** `ChangePassword` reads `data.msg` | **FIXED** — reads `data.message`. Verified against the route, which sends `message: "Password changed successfully"` |
| ~~**B2**~~ | **WITHDRAWN** — not a defect. See above |
| **B3** dev routes in production | **FIXED** — routes and both page files deleted |
| **I1** duplicate `pdfGenerator` files | **FIXED** — both unimported copies deleted |
| **I2** duplicate `AddCategoryForm` | **FIXED** — the unimported `pages/` copy deleted |
| **M1** missing empty state | **FIXED for `AdminCharts`**; withdrawn for `DonationDetails` |
| **D1** guest donation retrieval | **DEFERRED** — see below |

**Verified by outcome, not by the diff (BH2):** `npm run build` succeeds, which
is what proves five deletions did not break an import. `vite build` resolves
every import in the graph; a stale reference would fail the build rather than
appear at runtime on one route nobody opened.

### B1's enumeration, since it is the evidence and not the fix

All **seventeen** reads of a server `message`/`error`/`msg` across the frontend
were listed. `ChangePassword.jsx:26` was the **only** surviving `.msg`.

The reason it survived is worth keeping: `utils/api.js` normalises FAILURES to
`data.error || data.message`, so every error path was already correct. Only the
**success** path, which reads the body directly, was left behind — which is why
a reader checking "do we handle BUG-11's shape" would have said yes.

---

## D1 — DEFERRED, with a trigger rather than a phase

**Can a guest retrieve their own donation?** Deferred: it is a product decision
and a new lookup path over donor data, not a UI fix.

**Trigger — revisit when any of these becomes true:**

1. A donor asks for a receipt they did not keep. That is the first real evidence
   the gap costs anything, and until then the cost is assumed.
2. Guest donations exceed a meaningful share of the total — the admin `/stats`
   tile already counts donations by user presence, so the number exists.
3. Any receipt-by-link or donation-lookup feature is proposed for another
   reason, because that flow would carry the same enumeration questions and
   should be designed once.

Recorded so it is not rediscovered as a bug. It remains an accident of the data
model (AG4), and deferring it is now a decision rather than the absence of one.
