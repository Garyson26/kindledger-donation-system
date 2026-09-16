/**
 * =============================================================================
 * Category bridge (AD1c) - both resolution paths and the malformed-id case
 * =============================================================================
 *   docker compose up -d          (MySQL + MongoDB both required)
 *   npm run test:bridge
 *
 * The bridge is TEMPORARY (ADR-050) and is deleted in package 3.6. It is tested
 * anyway, and thoroughly, because for the duration of Phase 3 it sits on the
 * PAYMENT PRICING PATH: `payment.js` resolves the category through it and
 * multiplies `donationAmount` by the quantity to decide what to charge. A
 * temporary component on that path is not a component that deserves less
 * testing.
 *
 * Three things are asserted, and the third is the one that matters:
 *
 *   1. MySQL resolution - the normal path from package 3.1 onwards.
 *   2. MongoDB fallback - categories that have not been migrated yet, which is
 *      all of them until Phase 4 runs.
 *   3. A malformed id NEVER THROWS. `Category.findById(<uuid>)` raises a
 *      CastError, which a route turns into a 500 where a 400 belongs. That is
 *      the SEC-14 shape, and putting it on the pricing path would mean an
 *      attacker could 500 the donation endpoint with one junk field.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/kindledger_bridge_test';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long';

const mongoose = require('mongoose');
const Category = require('../models/Category');
const categories = require('../repositories/categories');
const prismaModule = require('../config/prisma');
const bridge = require('../services/categoryBridge');

const NAME_PREFIX = 'ZZZ BRIDGE TEST';

const uniqueName = (tag) => `${NAME_PREFIX} ${tag} ${crypto.randomBytes(3).toString('hex')}`;
const mintObjectId = () =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
  crypto.randomBytes(8).toString('hex');

async function cleanup() {
  await categories.deleteByNamePrefix(NAME_PREFIX);
  await Category.deleteMany({ name: new RegExp('^' + NAME_PREFIX) });
}

function mongoHostPort(uri) {
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(uri);
  return { host: m ? m[1] : '127.0.0.1', port: m && m[2] ? Number(m[2]) : 27017 };
}

before(async () => {
  const { host, port } = mongoHostPort(process.env.MONGODB_URI);
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (why) => {
      sock.destroy();
      reject(new Error(`This suite needs MongoDB at ${host}:${port} (${why}).`));
    };
    sock.setTimeout(4000, () => fail('timeout'));
    sock.once('error', (e) => fail(e.message));
    sock.once('connect', () => {
      sock.destroy();
      resolve();
    });
  });

  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point at a schema-applied MySQL 8.4');
  const probe = await require('../repositories').checkDatabase();
  assert.equal(probe.ok, true, `MySQL unreachable: ${probe.error}`);

  await mongoose.connect(process.env.MONGODB_URI);
  await cleanup();
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await mongoose.connection.close();
    await prismaModule.disconnect();
  }
});

// =============================================================================
// Identifier shapes
// =============================================================================

test('idShape classifies the three cases and never guesses', () => {
  assert.equal(bridge.idShape('507f1f77bcf86cd799439011'), 'objectid');
  assert.equal(bridge.idShape('507F1F77BCF86CD799439011'), 'objectid', 'case insensitive');
  assert.equal(bridge.idShape('6f8b2c1e-3a4d-4b5c-9d8e-1f2a3b4c5d6e'), 'uuid');

  for (const bad of [
    'not-an-objectid',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    '507f1f77bcf86cd79943901', // 23 chars - one short
    '507f1f77bcf86cd7994390111', // 25 chars - one long
    'zzzf1f77bcf86cd799439011', // right length, not hex
  ]) {
    assert.equal(bridge.idShape(bad), 'invalid', `${JSON.stringify(bad)} must be invalid`);
  }
});

// =============================================================================
// 1. MySQL resolution
// =============================================================================

test('resolves a MySQL category by its legacy ObjectId', async () => {
  const legacyId = mintObjectId();
  const name = uniqueName('mysql');
  await categories.create({
    name,
    legacyId,
    shortDescription: 'from mysql',
    donationAmountMinor: 250075,
    descriptions: ['one', 'two'],
  });

  const before = bridge.fallbackCount();
  const resolved = await bridge.resolveCategory(legacyId);

  assert.ok(resolved, 'resolved');
  assert.equal(resolved._source, 'mysql');
  assert.equal(resolved._id, legacyId, 'the external id is the ObjectId, per ADR-051');
  assert.equal(resolved.name, name);
  assert.equal(resolved.sortDescription, 'from mysql');
  // Minor units converted back at the boundary - the unmigrated readers expect
  // a major-unit number, because that is what Mongoose gave them.
  assert.equal(resolved.donationAmount, 2500.75);
  assert.deepEqual(resolved.descriptions, ['one', 'two']);

  assert.equal(bridge.fallbackCount(), before, 'the MongoDB path was NOT taken');
});

test('resolves a MySQL category by its uuid, without touching MongoDB', async () => {
  const name = uniqueName('byuuid');
  const row = await categories.create({
    name,
    legacyId: mintObjectId(),
    shortDescription: 'x',
    donationAmountMinor: 1000,
  });

  const before = bridge.fallbackCount();
  const resolved = await bridge.resolveCategory(row.id);
  assert.ok(resolved);
  assert.equal(resolved._source, 'mysql');
  assert.equal(bridge.fallbackCount(), before);
});

test('an ARCHIVED category still resolves, so historical donations keep their category', async () => {
  // ADR-004. The whole point of the soft delete: donations.category_id is
  // NOT NULL with ON DELETE RESTRICT, and a receipt issued last year must still
  // name the category that priced it.
  const legacyId = mintObjectId();
  const row = await categories.create({
    name: uniqueName('archived'),
    legacyId,
    shortDescription: 'x',
    donationAmountMinor: 5000,
  });
  await categories.archive(row.id);

  const resolved = await bridge.resolveCategory(legacyId);
  assert.ok(resolved, 'an archived category must still resolve');
  assert.equal(resolved._source, 'mysql');
  assert.equal(resolved.donationAmount, 50);
});

// =============================================================================
// 2. MongoDB fallback - and it must be LOUD (AD1a)
// =============================================================================

test('falls back to MongoDB for a category that has not been migrated', async () => {
  const doc = await Category.create({
    name: uniqueName('mongo'),
    sortDescription: 'from mongo',
    donationAmount: 99.5,
    descriptions: ['a'],
    displayOrder: 3,
  });
  const id = doc._id.toString();

  const before = bridge.fallbackCount();
  const resolved = await bridge.resolveCategory(id);

  assert.ok(resolved, 'resolved');
  assert.equal(resolved._source, 'mongo');
  assert.equal(resolved._id, id);
  assert.equal(resolved.donationAmount, 99.5);

  assert.equal(
    bridge.fallbackCount(),
    before + 1,
    'the fallback must COUNT itself - this is the package 3.6 exit check'
  );
});

test('MySQL wins when a category exists in both stores', async () => {
  // The state during the Phase 4 ETL: rows copied to MySQL while the Mongo
  // originals are still present. MySQL must be authoritative or the migration
  // silently has no effect.
  const legacyId = mintObjectId();
  const name = uniqueName('both');

  await Category.create({
    _id: legacyId,
    name,
    sortDescription: 'the stale mongo copy',
    donationAmount: 11,
  });
  await categories.create({
    name: name + ' mysql',
    legacyId,
    shortDescription: 'the authoritative mysql row',
    donationAmountMinor: 2200,
  });

  const before = bridge.fallbackCount();
  const resolved = await bridge.resolveCategory(legacyId);

  assert.equal(resolved._source, 'mysql');
  assert.equal(resolved.donationAmount, 22, 'the MySQL price, not the stale one');
  assert.equal(bridge.fallbackCount(), before, 'and MongoDB was not consulted at all');
});

// =============================================================================
// 3. Malformed input NEVER throws (AD1b)
// =============================================================================

test('a malformed id resolves to null rather than raising a CastError', async () => {
  // THE ASSERTION THIS SUITE EXISTS FOR. `Category.findById('not-an-objectid')`
  // throws; on the pricing path that is a 500 from one junk form field, which
  // is the SEC-14 shape. Here it is simply "no such category", and payment.js
  // turns that into the 400 it always meant to return.
  for (const bad of [
    'not-an-objectid',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    [],
    '507f1f77bcf86cd79943901',
    'zzzf1f77bcf86cd799439011',
    "'; DROP TABLE categories; --",
    { $ne: null },
  ]) {
    const resolved = await bridge.resolveCategory(bad);
    assert.equal(resolved, null, `${JSON.stringify(bad)} must resolve to null, not throw`);
  }
});

test('a well-formed but unknown id of either shape resolves to null', async () => {
  assert.equal(await bridge.resolveCategory(mintObjectId()), null);
  assert.equal(await bridge.resolveCategory(crypto.randomUUID()), null);
});

test('an unknown UUID never consults MongoDB', async () => {
  // A uuid can only have come from MySQL, so there is nothing to fall back to -
  // and asking Mongo would raise the CastError the helper exists to prevent.
  const before = bridge.fallbackCount();
  assert.equal(await bridge.resolveCategory(crypto.randomUUID()), null);
  assert.equal(bridge.fallbackCount(), before);
});

// =============================================================================
// Batch resolution, which is what replaced populate()
// =============================================================================

test('resolveMany de-duplicates and skips what it cannot resolve', async () => {
  const legacyId = mintObjectId();
  await categories.create({
    name: uniqueName('many'),
    legacyId,
    shortDescription: 'x',
    donationAmountMinor: 100,
  });

  const map = await bridge.resolveMany([legacyId, legacyId, legacyId, 'not-an-id', null, undefined]);

  assert.equal(map.size, 1, 'three references to one category is one lookup');
  assert.equal(map.get(legacyId).donationAmount, 1);
});

test('attachCategories replaces the id with the resolved category, and null when it cannot', async () => {
  const legacyId = mintObjectId();
  await categories.create({
    name: uniqueName('attach'),
    legacyId,
    shortDescription: 'x',
    donationAmountMinor: 4200,
  });

  const docs = [
    { _id: 'd1', category: legacyId },
    { _id: 'd2', category: mintObjectId() }, // resolves to nothing
    { _id: 'd3', category: null }, // never had one
  ];

  const out = await bridge.attachCategories(docs);

  assert.equal(out[0].category.donationAmount, 42);
  assert.equal(out[0].category._source, 'mysql');
  assert.equal(out[1].category, null, 'the dangling-reference case populate() also gave null for');
  assert.equal(out[2].category, null);

  // A single document, not an array, comes back as a single document.
  const one = await bridge.attachCategories({ _id: 'd4', category: legacyId });
  assert.equal(Array.isArray(one), false);
  assert.equal(one.category.name.startsWith(NAME_PREFIX), true);
});
