# SPEC-5 package 5.1 — UI audit

**No code changed.** This is the list SPEC-5 §7 asks for. Gary picks from it; 5.6
implements whatever is picked.

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

### B2. `AdminUsers` has no error handling at all

`src/pages/AdminUsers.jsx` contains **zero `catch` blocks** while every other
admin page has one or two. A failed or slow request leaves the page blank or
spinning with nothing said.

*Should:* the same toast-on-failure the other admin pages use.

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

### M1. No empty state on `DonationDetails` or `AdminCharts`

Both handle loading and both `catch`, but neither handles "the request
succeeded and there is nothing to show". Every other listing page does.

*Should:* the same empty-state treatment used by `MyDonations` and
`AdminDonations`.

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
