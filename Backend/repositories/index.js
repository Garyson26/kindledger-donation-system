/**
 * Repository entry point.
 *
 * Phase 3 imports from here rather than reaching for Prisma directly, so the
 * ORM stays behind one boundary and the SEC-03 injection class cannot come back
 * through raw string interpolation in a route file.
 */

'use strict';

const { withTransaction, getPrisma, checkDatabase } = require('../config/prisma');
const shared = require('./_shared');

module.exports = {
  donations: require('./donations'),
  users: require('./users'),
  categories: require('./categories'),
  pendingSignups: require('./pendingSignups'),
  brandingSettings: require('./brandingSettings'),

  // Transaction support (SPEC-2 section 4.4). Pass the tx it yields as the LAST
  // argument to every repository call that must take part - a call that omits
  // it succeeds on its own connection, outside the transaction, silently.
  withTransaction,

  // The single money conversion (SPEC-1A section 4.2).
  toMinorUnits: shared.toMinorUnits,

  // Escape hatches. Calling getPrisma() from a route defeats the point of this
  // layer; it exists for the health check and the scheduler.
  getPrisma,
  checkDatabase,
};
