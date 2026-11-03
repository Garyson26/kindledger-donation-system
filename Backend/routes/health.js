/**
 * =============================================================================
 * GET /api/health (SPEC-2 section 5)
 * =============================================================================
 * SPEC-2 section 1 forbids modifying files under Backend/routes/. This file is
 * the named exception in section 2: the prohibition exists to stop Phase 2
 * touching the six route files that consume Mongoose, and a new file consuming
 * ONLY the new data layer creates none of that coupling. Recorded in
 * docs/decisions.md ADR-038 so it does not read as a breach.
 *
 * IT IMPORTS NO MONGOOSE, DIRECTLY OR TRANSITIVELY - and that is why the
 * detailed form is behind a shared secret rather than behind adminAuth.
 * adminAuth does `User.findById(...)` on a Mongoose model, so importing it here
 * would pull the old data layer into the one file that is supposed to prove the
 * new one works. SPEC-2 section 5 permits either; the shared secret is the
 * option that keeps the property section 2 relies on.
 *
 * THE UNAUTHENTICATED RESPONSE CARRIES NO DETAIL. 200 or 503 and a status
 * string, nothing else. An open endpoint reporting connection state, latency,
 * migration version or a component breakdown is an information leak on a public
 * deployment and a reconnaissance aid - it tells an attacker when the database
 * is down, which is when other things fail open.
 * =============================================================================
 */

'use strict';

const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const { checkDatabase } = require('../config/prisma');

/**
 * Timing-safe comparison of the diagnostics secret.
 *
 * A plain === would leak the secret a byte at a time to anyone who can measure
 * response timing, which for a health endpoint is anyone at all.
 */
function secretMatches(provided) {
  const expected = process.env.HEALTH_DIAGNOSTIC_SECRET;
  if (!expected || expected.length < 16) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// -----------------------------------------------------------------------------
// GET /api/health - unauthenticated liveness
// -----------------------------------------------------------------------------
// Used by the compose healthcheck. 200 when the database is reachable, 503
// when it is not.
//
// Note the deliberate asymmetry with config/db.js: an unreachable database
// makes this endpoint answer 503, it does NOT make the process exit. A running
// container reporting unhealthy is diagnosable; a container that exited is the
// FUNCTION_INVOCATION_FAILED shape production is in now (ADR-039).
router.get('/', async (req, res) => {
  const diagnosticsRequested = Boolean(req.get('x-health-secret'));

  const db = await checkDatabase();

  if (diagnosticsRequested && secretMatches(req.get('x-health-secret'))) {
    return res.status(db.ok ? 200 : 503).json({
      status: db.ok ? 'ok' : 'unavailable',
      database: {
        reachable: db.ok,
        latencyMs: db.latencyMs,
        ...(db.ok ? {} : { error: db.error }),
      },
      redis: {
        configured: Boolean(process.env.REDIS_URL),
      },
      pool: {
        connectionLimit: Number(
          process.env.PRISMA_CONNECTION_LIMIT || require('../config/prisma').DEFAULT_CONNECTION_LIMIT
        ),
      },
      // The address the application resolved for THIS caller, after
      // `trust proxy` has been applied. Present so SPEC-2 section 7.3 can be
      // tested end to end through Nginx: send a spoofed X-Forwarded-For and
      // assert this is not it.
      //
      // It reports the caller their own IP, so it discloses nothing they do
      // not already know - but it is behind the secret anyway, because
      // combined with `forwardedFor` it also reveals how many proxy hops the
      // deployment has, which is a detail an unauthenticated caller has no
      // business learning.
      client: {
        ip: req.ip,
        forwardedFor: req.get('x-forwarded-for') || null,
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  // Unauthenticated: a status string and nothing more. Not the error, not the
  // latency, not whether Redis is configured.
  return res.status(db.ok ? 200 : 503).json({ status: db.ok ? 'ok' : 'unavailable' });
});

module.exports = router;
