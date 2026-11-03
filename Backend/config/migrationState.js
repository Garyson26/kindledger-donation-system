/**
 * =============================================================================
 * WHICH STORE IS AUTHORITATIVE FOR EACH ENTITY (AS2)
 * =============================================================================
 * ONE statement of migration state. Everything that needs to know - the
 * scheduler's destructive jobs, the ETL's pre-flight, the bridges' exit
 * condition - reads it from here rather than restating it.
 *
 * WHY THIS EXISTS. `services/scheduler.js` holds DELETE on donations and on
 * users against MySQL, while the live writer for both is still MongoDB. The
 * retention purge would delete ETL-migrated history from MySQL while live rows
 * accumulated in MongoDB where the purge cannot see them - destroying data AND
 * failing the retention obligation the job exists to satisfy, at the same time.
 *
 * The only thing preventing that was `SCHEDULER_ENABLED` defaulting to false.
 * **A GUARD THAT IS CORRECT AND IS A DEFAULT IS NOT A CONTROL.** An operator
 * turning the scheduler on - which they are eventually told to do - had nothing
 * to stop them turning it on too early, and the failure is silent: the job
 * reports a successful purge because from MySQL's point of view it performed
 * one.
 *
 * -----------------------------------------------------------------------------
 * THREE STATES, NOT TWO, AND `split` IS THE POINT
 * -----------------------------------------------------------------------------
 * A binary migrated/not-migrated cannot express the condition that actually
 * causes harm. `split` means DIFFERENT FILES WRITE DIFFERENT STORES for the
 * same entity - which is ADR-057's crossing, and it is the state both `user`
 * and `donation` are in right now.
 *
 * `split` is treated as NOT MIGRATED for every purpose here. That is
 * deliberate: an entity with a live MongoDB writer has rows the MySQL side has
 * never seen, whatever proportion of its code has moved.
 *
 * -----------------------------------------------------------------------------
 * THE DECLARATION IS CHECKED AGAINST THE CODE, NOT TRUSTED
 * -----------------------------------------------------------------------------
 * A declaration is a sentence, and a sentence near code is exactly how the
 * seven inherited claims happened - including one that described a narrowing
 * nobody had implemented. So this one is VERIFIED BY A TEST rather than
 * believed: `test/migration-state.test.js` walks the source tree and asserts
 * that for every entity declared `mysql`, no file outside `mongooseAllowed`
 * imports its Mongoose model.
 *
 * If someone migrates a file and forgets to update this, the test passes and
 * nothing is claimed falsely. If someone updates this and forgets to migrate a
 * file, THE TEST FAILS AND NAMES THE FILE. That asymmetry is the right way
 * round: the dangerous direction is the one that is caught.
 * =============================================================================
 */

'use strict';

const MONGODB = 'mongodb';
const MYSQL = 'mysql';
const SPLIT = 'split';

/**
 * @typedef {Object} EntityState
 * @property {'mongodb'|'mysql'|'split'} store  Where the authoritative rows are.
 * @property {string|null} model      The Mongoose model name, if one exists.
 * @property {string} reason          Why it is in this state. Cite the writer.
 * @property {boolean} etlMigrates
 *   Whether the Phase 4a ETL carries this entity's rows across. NOT the same
 *   claim as `store === 'mysql'` - `pendingSignup` is MySQL-authoritative and
 *   is deliberately never migrated, because those rows expire in 24 hours.
 * @property {string[]} mongooseAllowed
 *   Source paths permitted to import the Mongoose model even when the entity is
 *   `mysql`. The ETL reads the old store by definition; the bridges read it as a
 *   fallback for rows not yet migrated. Anything else is a crossing.
 */

/** @type {Record<string, EntityState>} */
const ENTITIES = {
  category: {
    store: MYSQL,
    model: 'Category',
    etlMigrates: true,
    reason:
      'Migrated in package 3.1r. routes/categories.js is the only live writer ' +
      'and writes MySQL. scripts/seedDatabase.js still creates MongoDB ' +
      'categories, but it is a development seeder behind NODE_ENV!=production ' +
      'AND ALLOW_SEED=true, so it cannot write a deployed store.',
    mongooseAllowed: ['etl/', 'services/categoryBridge.js', 'scripts/seedDatabase.js', 'test/'],
  },

  user: {
    // WAS `split` until AS7 closed ADMIN-01. routes/admin.js was the last
    // MongoDB writer: it created, updated, disabled and deleted accounts in a
    // store authentication had stopped reading at package 3.2, and reported
    // success for every one of them.
    store: MYSQL,
    model: 'User',
    etlMigrates: true,
    reason:
      'Migrated across packages 3.2 and AS7. routes/auth.js, routes/users.js, ' +
      'both middlewares and routes/admin.js all write MySQL. ' +
      'scripts/seedDatabase.js still creates MongoDB users, but it is a ' +
      'development seeder behind NODE_ENV!=production AND ALLOW_SEED=true, so ' +
      'it cannot write a deployed store.',
    mongooseAllowed: ['etl/', 'services/userBridge.js', 'scripts/seedDatabase.js', 'test/'],
  },

  donation: {
    // WAS `split` until package 3.4. routes/payment.js was the last MongoDB
    // writer AND the only live creator of donations, so until it migrated every
    // donation taken through the money path was invisible to the admin console,
    // the receipt and the charts (ADR-057). This transition is what completes
    // the 3.2 + 3.3 + 3.4 merge unit.
    store: MYSQL,
    model: 'Donation',
    etlMigrates: true,
    reason:
      'Migrated across packages 3.3 and 3.4. routes/donations.js, ' +
      'routes/payment.js and routes/admin.js all read and write MySQL. ' +
      'scripts/seedDatabase.js still writes MongoDB donations, but it is a ' +
      'development seeder behind NODE_ENV!=production AND ALLOW_SEED=true, so ' +
      'it cannot write a deployed store.',
    mongooseAllowed: ['etl/', 'scripts/seedDatabase.js', 'test/'],
  },

  pendingSignup: {
    store: MYSQL,
    model: 'PendingSignup',
    // FALSE, and this is the entity where `mysql` and "the ETL carries it"
    // come apart. SPEC-1A section 5.2: these rows live 24 hours, so at any
    // cutover almost none is valid and carrying them would move a plaintext
    // secret through a migration script to preserve a value that expires first.
    etlMigrates: false,
    reason:
      'Migrated in package 3.2. routes/auth.js is the only writer and the ' +
      'only reader besides the scheduler, both MySQL. The ETL deliberately ' +
      'does NOT migrate these rows (SPEC-1A section 5.2) - they live 24 hours.',
    mongooseAllowed: ['etl/', 'test/'],
  },

  brandingSettings: {
    store: MYSQL,
    model: null,
    etlMigrates: false,
    reason:
      'MySQL-only by construction - a Phase 2 entity with no MongoDB ' +
      'predecessor and, as of the AR1 audit, no application caller at all. ' +
      'Phase 5 builds the whitelabel consumer (AS4).',
    mongooseAllowed: [],
  },
};

/** Every entity name, for iteration and for the self-check test. */
const entityNames = () => Object.keys(ENTITIES);

function stateFor(entity) {
  const s = ENTITIES[entity];
  if (!s) {
    throw new Error(
      `Unknown entity '${entity}'. Add it to config/migrationState.js rather ` +
        'than assuming its store - an entity nobody declared is an entity ' +
        'nobody checked.'
    );
  }
  return s;
}

/** The authoritative store: 'mongodb', 'mysql' or 'split'. */
const storeFor = (entity) => stateFor(entity).store;

/**
 * Is MySQL the ONLY place this entity is written?
 *
 * `split` answers false. An entity with a live MongoDB writer has rows MySQL
 * has never seen, whatever proportion of its code has moved.
 */
const isMysqlAuthoritative = (entity) => stateFor(entity).store === MYSQL;

/**
 * Refuse a destructive operation on an entity MySQL is not authoritative for.
 *
 * THIS IS THE CONTROL THAT REPLACES `SCHEDULER_ENABLED` AS A SAFETY PROPERTY.
 * The environment variable still decides whether the jobs are REGISTERED, which
 * is an operational choice; this decides whether they may DELETE, which is a
 * correctness one. An operator can flip the first. Only a code change flips the
 * second, and a code change that flips it wrongly fails the self-check test.
 *
 * @param {string} entity
 * @param {string} operation  Named in the error, so a log line says what refused.
 */
function assertDeletable(entity, operation) {
  const state = stateFor(entity);
  if (state.store === MYSQL) return;

  const err = new Error(
    `REFUSED: ${operation} would delete '${entity}' rows from MySQL, but MySQL ` +
      `is not authoritative for them (state: ${state.store}). ${state.reason} ` +
      'Deleting here would destroy migrated history while live rows accumulate ' +
      'in MongoDB, failing the retention obligation this job exists to satisfy ' +
      'AND losing data, at the same time. Update config/migrationState.js when ' +
      'the entity has actually migrated - the self-check test will tell you if ' +
      'it has not.'
  );
  err.code = 'ERR_NOT_AUTHORITATIVE';
  err.entity = entity;
  err.state = state.store;
  throw err;
}

/** Entities still not fully on MySQL. Used by the ETL report and the bridges. */
const pendingMigration = () => entityNames().filter((e) => !isMysqlAuthoritative(e));

/**
 * Entities the ETL carries across AND for which MySQL is already authoritative.
 *
 * This is the set where the declaration can be AHEAD OF THE DATA: MySQL is
 * declared authoritative, so routes read it, but MongoDB may still hold rows it
 * has never seen. That is ADR-056's failure exactly - package 3.1 would have
 * returned `[]` for every production category - and the ETL's pre-flight is the
 * cheapest place to notice it, because it is the only component that can see
 * both stores at once.
 */
const declaredAheadCandidates = () =>
  entityNames().filter(
    (e) => isMysqlAuthoritative(e) && ENTITIES[e].etlMigrates && ENTITIES[e].model
  );

/**
 * A one-line summary for a boot log or a report header.
 *
 * Printed rather than inferred, because "which entities have moved" is the
 * question every one of ADR-056, ADR-057 and ADMIN-01 turned on, and it has
 * never been answerable from a single place before.
 */
function summary() {
  return entityNames()
    .map((e) => `${e}=${ENTITIES[e].store}`)
    .join(' ');
}

module.exports = {
  MONGODB,
  MYSQL,
  SPLIT,
  ENTITIES,
  entityNames,
  stateFor,
  storeFor,
  isMysqlAuthoritative,
  assertDeletable,
  pendingMigration,
  declaredAheadCandidates,
  summary,
};
