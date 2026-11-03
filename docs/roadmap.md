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

**Why it is one move and not three.** Hostinger's shared MariaDB imposes three
constraints that this repository works around separately. All three come from
the same fact - the server's configuration belongs to the host - so leaving
the host removes all three:

| What it removes | Where it is recorded | The workaround it retires |
|---|---|---|
| **A GLOBAL `sql_mode` that is not strict.** Anything that writes outside the application - phpMyAdmin, a hand-run session - can store an out-of-set ENUM as `''` | Remediation map **DB1**, accepted risk, open | The per-session `initSql` in `config/prisma.js` stays as belt-and-braces; the guard's GLOBAL warning goes away, and DB1 closes |
| **The connection ceilings.** `max_user_connections = 75` caps concurrent function instances at about 70; the hourly cap and a 20-second `wait_timeout` make quiet traffic expensive | deployment-environment **§1.5** | `PRISMA_CONNECTION_LIMIT=1` can be re-derived for the new server |
| **A database open to the whole internet.** Remote MySQL must allow any host because Vercel has no fixed outbound address, so a password is the only control | deployment-environment **§1.4** | A private network path, or an allow list, puts a network control in front of the password |

**When it is done:** close DB1 in the remediation map, delete the
`refuse-unsupported` CI step that pins the residual (it will start failing,
which is the signal), and rewrite deployment-environment §1.4 and §1.5.

---

*The identity-provider item (Clerk) is on Gary's roadmap but was not in this
repository when this file was created, so it is not reproduced here.*
