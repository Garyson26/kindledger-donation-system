/**
 * =============================================================================
 * BB4 - a BLOCKING-but-loadable finding cannot be added silently
 * =============================================================================
 *   npm run test:preflight-findings
 *
 * No database. This asserts a property of the pre-flight's own definitions.
 *
 * `etl/preflight.js` used to describe `refusedAtLoad` as "the thing to check if
 * a BLOCKING-but-loadable finding is ever added". BA3's audit put that in the
 * column it belonged in: a day that has to be noticed by somebody re-reading a
 * comment is a day that does not announce itself, and nothing in the code would
 * have fired when it came.
 *
 * WRITING THE CHECK FOUND THAT THE DAY HAD ALREADY COME, TWICE. See
 * BLOCKING_BUT_LOADABLE in preflight.js for both.
 *
 * Why the invariant matters, rather than being tidiness: ETL-01. An override
 * flag on a finding the loader ALSO refuses can only turn a clean refusal into
 * a partial load - it can never load the rows it is overriding. That argument
 * holds only while every blocking finding is one the loader refuses. The day
 * one is not, the argument for having no override stops applying to it, and
 * somebody has to think rather than inherit the conclusion.
 * =============================================================================
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { finding, BLOCKING_BUT_LOADABLE } = require('../etl/preflight');

test('BB4: a new BLOCKING finding the loader does NOT refuse is REJECTED', () => {
  // PROVED BY INJECTION (AV2). This is what a future author adding a
  // blocking-but-loadable finding actually does.
  assert.throws(
    () => finding('some-new-check', 'BLOCKING', 'detail', true, false),
    (err) => {
      assert.match(err.message, /PREFLIGHT INVARIANT/);
      assert.match(err.message, /some-new-check/, 'and it names the offending check');
      assert.match(err.message, /BLOCKING_BUT_LOADABLE/, 'and where to declare it');
      assert.match(err.message, /ETL-01/, 'and why the invariant exists at all');
      return true;
    }
  );
});

test('BB4: the DEFAULT arguments are the dangerous ones, and they are rejected too', () => {
  // `finding()` defaults to blocking=true, refusedAtLoad=false - which is
  // precisely the combination the invariant forbids. That is deliberate: the
  // careless call is the one that fails, not the careful one.
  assert.throws(() => finding('careless', 'BLOCKING', 'detail'), /PREFLIGHT INVARIANT/);
});

test('BB4: a blocking finding the loader DOES refuse is accepted', () => {
  const f = finding('refused-by-loader', 'BLOCKING', 'detail', true, true);
  assert.equal(f.blocking, true);
  assert.equal(f.refusedAtLoad, true);
});

test('BB4: a NON-blocking finding is unconstrained', () => {
  // A RECORD finding does not stop the load, so the override argument does not
  // apply to it and the invariant must not pretend otherwise. `float-rounding`,
  // `amount-consistency` and `declaration-ahead-of-data` are all of this kind.
  const f = finding('advisory', 'RECORD', 'detail', false, false);
  assert.equal(f.blocking, false);
});

test('BB4: every ACKNOWLEDGED exception carries a reason, not just a name', () => {
  // An allowlist of bare names is how an invariant becomes a formality. The
  // reason is the thing a future reader needs, and it is the thing that is
  // annoying enough to write that nobody adds an entry casually.
  assert.ok(BLOCKING_BUT_LOADABLE.size >= 1, 'the list is non-empty - the day has come');

  for (const [check, reason] of BLOCKING_BUT_LOADABLE) {
    assert.equal(typeof reason, 'string');
    assert.ok(
      reason.length > 60,
      `${check} is acknowledged with a reason too short to be one: "${reason}"`
    );
  }

  // Named explicitly. If this entry disappears, either the loader started
  // refusing a permissive sql_mode - which would be news - or somebody removed
  // the acknowledgement without removing the finding.
  assert.ok(
    BLOCKING_BUT_LOADABLE.has('strict-sql-mode'),
    'strict-sql-mode is blocking, and the loader does NOT refuse it - it truncates'
  );
});

test('BB4: the acknowledged exception is still allowed to be constructed', () => {
  const f = finding('strict-sql-mode', 'FATAL', 'detail', true, false);
  assert.equal(f.blocking, true);
  assert.equal(f.refusedAtLoad, false, 'acknowledged, not silently reclassified');
});
