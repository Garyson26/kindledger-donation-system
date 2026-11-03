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
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const { isPrivateHost } = require('../db/require-mysql-version');

// -----------------------------------------------------------------------------
// Pooling
// -----------------------------------------------------------------------------
// SPEC-1A section 3.4 sets the default at 10 per container.
//
// The correct value is a function of the server's max_connections divided by
// the number of API replicas, leaving headroom for the ETL, migrations and a
// human at a mysql prompt. The compose default assumes ONE replica: scaling the
// api service without lowering this is how a connection-limit outage happens.
const DEFAULT_CONNECTION_LIMIT = 10;

// -----------------------------------------------------------------------------
// Every connection is made strict BY THE APPLICATION (DB1)
// -----------------------------------------------------------------------------
// sql_mode and time_zone are session variables. The compose stack sets both on
// the server; shared hosting lets the customer set neither, and Hostinger's
// GLOBAL sql_mode is not strict. Prisma's own engine has no way to run SQL when
// it opens a connection - no URL parameter does it (four tried, CX1) - so the
// pool is the MariaDB driver's, through Prisma's adapter, and its `initSql`
// runs on EVERY connection it opens: the first, one replacing a connection the
// server closed at wait_timeout, and one replacing a KILLed one. All three
// measured against a mariadb:11.8 whose GLOBAL sql_mode was '': each session
// was strict, and an out-of-set ENUM written by hand was refused (1265) instead
// of being stored as '' - BUG-02 by configuration, closed for every write that
// goes through this file.
//
// The mode is MySQL 8.4's own default, so both servers now behave the same,
// including the zero-date difference CY1-2 had accepted. time_zone is UTC
// because docker-compose.yml sets it server-wide and a shared host cannot.
//
// NOT COVERED: anything that does not connect through this file - phpMyAdmin, a
// hand-run mysql session, any future script with its own client. The server
// guard warns about that at start (DB3).
const SESSION_SQL_MODE =
  'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const SESSION_INIT_SQL = `SET SESSION sql_mode = '${SESSION_SQL_MODE}', time_zone = '+00:00'`;

/**
 * The driver pool's configuration, read from DATABASE_URL.
 *
 * The URL keeps Prisma's spelling, because `prisma migrate deploy` still reads
 * it directly: `connection_limit`, `pool_timeout`, `connect_timeout` and
 * `sslaccept` are translated here into the driver's names.
 *
 * NO IDLE-LIFETIME SETTING, AND THAT IS THE CONNECTION BUDGET (CY1-4). The pool
 * keeps its connections until the SERVER closes them, then replaces them before
 * handing them out (measured: no failed query across a wait_timeout). That is
 * the longest a connection can live, which is what an hourly connection cap
 * wants. A shorter client-side lifetime would only add billed reconnects.
 *
 * TLS: `sslaccept=strict` verifies the certificate, `accept_invalid_certs`
 * encrypts without verifying, and NO PARAMETER MEANS PLAINTEXT (measured). The
 * server guard refuses plaintext to any non-private host (DB4).
 */
function buildPoolConfig(raw = process.env.DATABASE_URL) {
  if (!raw) return undefined;
  const url = new URL(raw);
  const q = url.searchParams;
  const seconds = (name) => (q.get(name) ? Number(q.get(name)) * 1000 : undefined);
  const sslaccept = q.get('sslaccept');
  const ssl =
    sslaccept === 'strict' ? { rejectUnauthorized: true }
      : sslaccept === 'accept_invalid_certs' ? { rejectUnauthorized: false }
        : undefined;

  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    // An explicit connection_limit in the URL wins, as it always has.
    connectionLimit: Number(q.get('connection_limit') || process.env.PRISMA_CONNECTION_LIMIT || DEFAULT_CONNECTION_LIMIT),
    acquireTimeout: seconds('pool_timeout'),
    connectTimeout: seconds('connect_timeout'),
    ssl,
    // MySQL 8's caching_sha2_password needs the server's RSA key when the
    // connection is not encrypted. Fetching it is only safe where nobody can
    // sit in the middle - a private network - and anywhere else TLS is
    // required anyway, so it is never needed there.
    allowPublicKeyRetrieval: !ssl && isPrivateHost(url.hostname),
    initSql: SESSION_INIT_SQL,
  };
  for (const k of Object.keys(config)) if (config[k] === undefined) delete config[k];
  return config;
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
  const pool = buildPoolConfig();
  return new PrismaClient({
    // Without DATABASE_URL there is no adapter, and the first query fails as it
    // always has: the health endpoint answers 503, the process stays up.
    ...(pool ? { adapter: new PrismaMariaDb(pool) } : {}),
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
  buildPoolConfig,
  SESSION_SQL_MODE,
  DEFAULT_CONNECTION_LIMIT,
};
