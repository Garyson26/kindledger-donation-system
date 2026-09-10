/**
 * =============================================================================
 * Prisma client singleton, pooling and lifecycle (SPEC-2 section 3)
 * =============================================================================
 * The MySQL connection layer. Built ALONGSIDE config/db.js, which is untouched
 * and still serves every existing consumer (SPEC-2 section 0.1). Nothing here
 * replaces anything yet.
 *
 * IT DOES NOT CALL process.exit(1) ON CONNECTION FAILURE, AND THAT IS
 * DELIBERATE. config/db.js does, and that single line is why production
 * currently answers FUNCTION_INVOCATION_FAILED on every database-backed route
 * instead of a diagnosable error, and why the deployed SEC-01 fix still cannot
 * be verified behaviourally - the process dies before any handler runs.
 *
 * A running container reporting `503 database unreachable` is strictly more
 * useful than a container that exits: the platform can tell you it is
 * unhealthy, the logs survive, and every route that does not need the database
 * keeps working. See docs/decisions.md ADR-039.
 *
 * DO NOT ADD AN EXIT HERE. If a future change makes the process "fail fast" on
 * a database error, it reintroduces exactly the outage shape this replaces.
 * =============================================================================
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

// -----------------------------------------------------------------------------
// Pooling
// -----------------------------------------------------------------------------
// SPEC-1A section 3.4 sets the default at 10 per container.
//
// The correct value is a function of the server's max_connections divided by
// the number of API replicas, leaving headroom for the ETL, migrations and a
// human at a mysql prompt. The compose default assumes ONE replica: scaling the
// api service without lowering this is how a connection-limit outage happens.
//
// Prisma takes the pool size from the connection string, so it is appended
// rather than passed as an option.
const DEFAULT_CONNECTION_LIMIT = 10;

function buildDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;

  const limit = process.env.PRISMA_CONNECTION_LIMIT || String(DEFAULT_CONNECTION_LIMIT);

  // Do not override an explicit connection_limit already in the URL.
  if (/[?&]connection_limit=/.test(raw)) return raw;

  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}connection_limit=${limit}`;
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------
// One client per process. Not per request, not per module.
//
// The global cache is not a style preference: nodemon reloads modules without
// restarting the process, so a module-scoped client would be re-instantiated on
// every file save and each instance would hold its own pool. A few saves and
// MySQL refuses new connections. The same applies to Node's test runner
// requiring the module from several files.
const GLOBAL_KEY = '__kindledger_prisma_client__';

function createClient() {
  const url = buildDatabaseUrl();
  return new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    // `warn` and `error` only. Prisma's `query` log at info level would put
    // every statement - including bound parameters - into the application log,
    // which is how SEC-09 happened the first time.
    log: [
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  });
}

/** @returns {import('@prisma/client').PrismaClient} */
function getPrisma() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = createClient();
  }
  return globalThis[GLOBAL_KEY];
}

// -----------------------------------------------------------------------------
// Connectivity probe
// -----------------------------------------------------------------------------
/**
 * Is the database reachable right now?
 *
 * Prisma connects lazily on first query, so this is the first thing that
 * actually opens a connection. It never throws and it never exits: callers get
 * a verdict and decide what to do. The health endpoint turns this into 200 or
 * 503 (SPEC-2 section 5).
 *
 * @returns {Promise<{ok: boolean, error?: string, latencyMs: number}>}
 */
async function checkDatabase() {
  const started = Date.now();
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    // The message is returned for the AUTHENTICATED health form only. Callers
    // must not put it in an unauthenticated response: a connection error names
    // the host, the port and the database user.
    return { ok: false, error: err && err.message ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------
/**
 * Run `fn` inside a transaction, passing it a transactional client.
 *
 * Provided because SPEC-2 section 4.4 requires it and Phase 3 needs it for
 * ADR-012's read-then-write race in the payment callbacks: the idempotency
 * guard reads paymentStatus and then writes, with nothing between the two. That
 * was unfixable on MongoDB as this codebase uses it - no session appears
 * anywhere - and is fixable here.
 *
 * Every repository function accepts an optional client as its last argument, so
 * calls inside `fn` must be given `tx` to take part in the transaction.
 * Forgetting to pass it is silent: the call succeeds on its own connection,
 * outside the transaction. That is the trap; hence the explicit parameter
 * rather than an ambient context.
 *
 * @template T
 * @param {(tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTransaction(fn) {
  return getPrisma().$transaction((tx) => fn(tx));
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------
let shutdownRegistered = false;

/**
 * Close the pool on SIGTERM and SIGINT.
 *
 * Registered once, idempotently, and NOT registered on import: a test file
 * importing this module should not acquire signal handlers. app.js calls this.
 *
 * The handler disconnects and then re-raises the signal with the default
 * behaviour, rather than calling process.exit itself, so an exit code is not
 * invented and other handlers still run.
 */
function registerShutdownHandlers() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      try {
        await disconnect();
      } catch {
        // Nothing useful to do while shutting down.
      }
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

async function disconnect() {
  const client = globalThis[GLOBAL_KEY];
  if (!client) return;
  globalThis[GLOBAL_KEY] = undefined;
  await client.$disconnect();
}

module.exports = {
  getPrisma,
  checkDatabase,
  withTransaction,
  registerShutdownHandlers,
  disconnect,
  buildDatabaseUrl,
  DEFAULT_CONNECTION_LIMIT,
};
