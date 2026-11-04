# Roadmap

Work that is decided but deliberately not done yet. Each item says what it
removes, so that when it is done the things it closes are closed with it rather
than left open by habit.

---

## Move the database off shared hosting (DB5)

**When:** next year. **Decided by:** Gary, 3 Nov 2026.

**What:** a MySQL 8.4 (or MariaDB 11.4.5+) server where `sql_mode`, the
connection limits and network access are the installation's to set - a VPS, or
a managed database that allows a private connection from Vercel.

**Why: two reasons, both from the same fact** - the server's configuration
belongs to the host, so nothing in this repository can change them:

| What it removes | Where it is recorded | The workaround it retires |
|---|---|---|
| **The connection ceiling.** `max_user_connections = 75` caps function instances busy within any 20 seconds at about 70; past it, requests on the extra instances fail slowly until the burst passes | deployment-environment **§1.5**, remediation map **DC1** | `PRISMA_CONNECTION_LIMIT=1` can be re-derived for the new server |
| **A database open to the whole internet.** Remote MySQL must allow any host because Vercel has no fixed outbound address, so a password is the only control | deployment-environment **§1.4** | A private network path, or an allow list, puts a network control in front of the password |

**Strict mode is no longer a reason (DF1, 4 Nov 2026).** It was one when this
item was written. Since DB1 the application makes every connection of its own
strict, whatever the server's default, so the application path no longer
depends on the host. What remains is out-of-band SQL - phpMyAdmin, a hand-run
session - and that residual (remediation map **DB3**) closes as a side effect
of the move, not as a reason for it. The per-session `initSql` in
`config/prisma.js` stays after the move regardless.

**When it is done:** close DB3 in the remediation map, delete the
`refuse-unsupported` CI step that pins the residual (it will start failing,
which is the signal), and rewrite deployment-environment §1.4 and §1.5.

---

*The identity-provider item (Clerk) is on Gary's roadmap but was not in this
repository when this file was created, so it is not reproduced here.*
