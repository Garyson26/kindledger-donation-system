/**
 * =============================================================================
 * The server guard, at application start (CX1(b))
 * =============================================================================
 * db/require-mysql-version.js refused an unsupported server at INSTALL time -
 * inside `npm run db:migrate` and `npm run db:seed`. Nothing ran it when the
 * application started, so a deploy pointed at an unsupported server booted,
 * answered 200 and wrote data. That is the fail-open shape: the stack looks
 * healthy and cannot be trusted to do its job.
 *
 * Now every request except /api/health waits for one verdict per process:
 *
 *   supported      -> next()
 *   unsupported    -> 503, and the reason logged once. CACHED: a server does
 *                     not stop being MariaDB 10.11 between requests.
 *   supported, with WARNINGS -> next(), and the warnings logged (DB1: a
 *                     non-strict GLOBAL sql_mode, accepted by Gary).
 *   unreachable    -> next(). NOT cached and NOT a refusal: the route fails on
 *                     its own as it always has (ADR-039 - a dead database must
 *                     not kill the process), and the next request asks again.
 *
 * In a long-running process (compose, `npm start`) an unsupported verdict at
 * boot exits instead, so `docker compose ps` shows a restarting api with the
 * reason in its log rather than a container that looks up.
 *
 * WHAT IT COSTS. Two SELECTs, once per process, on the pooled connection the
 * first request opens anyway. With PRISMA_CONNECTION_LIMIT=1 that is zero
 * extra connections - which matters on a host that caps connections per hour.
 * It runs no DDL; the CHECK-enforcement probe stays in the install-time gate.
 * =============================================================================
 */

'use strict';

const { getPrisma, buildPoolConfig } = require('./prisma');
const { inspectServer, REQUIREMENT } = require('../db/require-mysql-version');

const defaultQuery = (sql) => getPrisma().$queryRawUnsafe(sql);

let query = defaultQuery;
let settled = null; // a definitive verdict, once one exists
let inFlight = null;

/**
 * @returns {Promise<{supported: boolean, server?: string, problems?: string[], unreachable?: boolean}>}
 */
function getServerVerdict() {
  if (settled) return Promise.resolve(settled);
  if (!inFlight) {
    inFlight = inspectServer(query, { host: (buildPoolConfig() || {}).host })
      .then((verdict) => {
        settled = verdict;
        if (!verdict.supported) {
          console.error(
            `[serverGuard] REFUSING: ${verdict.server} is not supported. ${REQUIREMENT}\n` +
              verdict.problems.map((p) => `[serverGuard]   - ${p}`).join('\n')
          );
        } else {
          console.log(`[serverGuard] ${verdict.server} supported`);
        }
        // The accepted risk (DB1), said on every cold start so it is in the
        // logs rather than in somebody's memory.
        for (const w of verdict.warnings || []) console.warn(`[serverGuard] WARNING: ${w}`);
        return verdict;
      })
      .catch(() => ({ supported: false, unreachable: true }))
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Express middleware. Mounted after /api/health and before every data route. */
async function requireSupportedServer(req, res, next) {
  const verdict = await getServerVerdict();
  if (verdict.supported || verdict.unreachable) return next();
  // Deliberately generic: which server and why is for the log, not for an
  // unauthenticated caller (the health endpoint's rule, SPEC-2 section 5).
  return res.status(503).json({ error: 'Service unavailable' });
}

/** Long-running processes only. Exits on a definitive refusal, never on unreachable. */
async function refuseUnsupportedServerAtBoot() {
  const verdict = await getServerVerdict();
  if (!verdict.supported && !verdict.unreachable) process.exit(1);
}

/**
 * Tests only. Forgets the verdict and, optionally, swaps the query the next
 * one is asked through - so a test never reaches the real database by accident.
 */
function resetServerVerdict(queryForTests = defaultQuery) {
  query = queryForTests;
  settled = null;
  inFlight = null;
}

module.exports = {
  getServerVerdict,
  requireSupportedServer,
  refuseUnsupportedServerAtBoot,
  resetServerVerdict,
};
