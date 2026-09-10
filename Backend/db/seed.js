#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * KindLedger Donation System - demo data seeder
 * =============================================================================
 * DESTRUCTIVE. This truncates every application table before inserting.
 *
 *   node db/seed.js --i-understand-this-drops-the-database
 *   node db/seed.js --i-understand-this-drops-the-database --users=100
 *
 * Two guards, both required (SPEC-1A deliverable 8):
 *
 *   1. Refuses to run when NODE_ENV === 'production'.
 *   2. Refuses to run without --i-understand-this-drops-the-database.
 *
 * WHY THE PASSWORD IS RANDOM PER RUN
 * The previous seeder gave all 1000 demo users the password `Password@123`,
 * hardcoded in the script and printed in its README. Anyone who ran it against
 * a database that later became production - or against a shared staging
 * database - left a thousand accounts with a publicly known password. This
 * generates one random password per run and prints it exactly once. If you lose
 * it, re-run the seeder; there is no recovery path by design.
 * =============================================================================
 */

'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// SEC-18 asks for cost 12 rather than the 10 used throughout the current code.
const BCRYPT_COST = 12;

const FLAG = '--i-understand-this-drops-the-database';

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------
function assertSafeToRun() {
  const failures = [];

  if (process.env.NODE_ENV === 'production') {
    failures.push('NODE_ENV is "production". This script will not run against a production environment.');
  }

  if (!process.argv.includes(FLAG)) {
    failures.push(`Missing required flag ${FLAG}. Every application table will be emptied.`);
  }

  if (failures.length > 0) {
    console.error('\nRefusing to seed:\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }
}

function parseUserCount() {
  const arg = process.argv.find((a) => a.startsWith('--users='));
  if (!arg) return 25;

  const n = Number.parseInt(arg.slice('--users='.length), 10);
  if (!Number.isInteger(n) || n < 1 || n > 5000) {
    console.error(`\nRefusing to seed: --users must be an integer between 1 and 5000, got "${arg}".\n`);
    process.exit(1);
  }
  return n;
}

/**
 * A readable but genuinely random password. 18 base64url characters is ~107
 * bits of entropy, which is far beyond anything a demo needs, but there is no
 * reason to be stingy.
 */
function generatePassword() {
  return crypto.randomBytes(14).toString('base64url');
}

/** Rupees (as a Number, for readability in this file) to integer paise. */
function rupees(n) {
  return BigInt(Math.round(n * 100));
}

// -----------------------------------------------------------------------------
// Demo content
// -----------------------------------------------------------------------------
const CATEGORIES = [
  {
    name: 'Ocean Cleanup Drive',
    shortDescription: 'Fund a volunteer beach and seabed cleanup',
    amount: 1500,
    descriptions: [
      'Covers equipment, safe waste disposal and transport for one volunteer team.',
      'Each drive removes roughly 200kg of debris from a one-kilometre stretch.',
    ],
  },
  {
    name: 'Coral Reef Restoration',
    shortDescription: 'Sponsor coral fragment nurseries',
    amount: 5000,
    descriptions: [
      'Funds nursery structures, fragment collection and eighteen months of monitoring.',
      'Restored fragments reach transplant size in about two years.',
    ],
  },
  {
    name: 'Marine Education Programme',
    shortDescription: 'Bring marine science into coastal classrooms',
    amount: 2500,
    descriptions: [
      'Supports teaching materials and a field trip for one class of forty students.',
    ],
  },
  {
    name: 'Turtle Nesting Protection',
    shortDescription: 'Protect a nesting site through one season',
    amount: 3500,
    descriptions: [
      'Pays for hatchery fencing, night patrols and hatchling release monitoring.',
      'A single protected nest yields around a hundred hatchlings.',
    ],
  },
  {
    name: 'Plastic-Free Coastline',
    shortDescription: 'Support the plastic reduction campaign',
    amount: 1000,
    descriptions: [],
  },
];

const FIRST_NAMES = ['Aditi', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Vikram', 'Priya', 'Arjun', 'Nisha', 'Dev', 'Ishaan', 'Lakshmi', 'Farhan', 'Divya', 'Sanjay'];
const LAST_NAMES = ['Sharma', 'Iyer', 'Nair', 'Patel', 'Reddy', 'Bose', 'Khan', 'Menon', 'Gupta', 'Fernandes'];

const PAYMENT_MIX = [
  { payment: 'Paid', status: 'Approved', weight: 60 },
  { payment: 'Pending', status: 'Pending', weight: 15 },
  { payment: 'Failed', status: 'Rejected', weight: 15 },
  { payment: 'Cancelled', status: 'Pending', weight: 10 },
];

function pickWeighted(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let roll = crypto.randomInt(total);
  for (const row of rows) {
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return rows[rows.length - 1];
}

function pick(arr) {
  return arr[crypto.randomInt(arr.length)];
}

/** A random instant within the last `days` days. */
function recentDate(days) {
  const ms = crypto.randomInt(days * 24 * 60 * 60 * 1000);
  return new Date(Date.now() - ms);
}

// -----------------------------------------------------------------------------
// Wipe
// -----------------------------------------------------------------------------
// Order matters even with ON DELETE CASCADE: donations RESTRICTs against
// categories, so donations must go first. branding_settings is not deleted -
// its singleton row is updated in place, because db/schema.sql guarantees the
// row exists and the application is entitled to assume that.
// -----------------------------------------------------------------------------
async function wipe() {
  await prisma.donationPaymentDetail.deleteMany();
  await prisma.donation.deleteMany();
  await prisma.categoryDescription.deleteMany();
  await prisma.category.deleteMany();
  await prisma.pendingSignup.deleteMany();
  await prisma.user.deleteMany();
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------
async function main() {
  assertSafeToRun();

  const userCount = parseUserCount();
  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  console.log('\nSeeding KindLedger demo data...\n');

  await wipe();

  // --- branding -------------------------------------------------------------
  // Updated, never inserted: db/schema.sql seeds id=1 and CHECK (id = 1)
  // makes a second row impossible.
  await prisma.brandingSettings.update({
    where: { id: 1 },
    data: {
      organisationName: 'For Ocean Foundation',
      primaryColour: '#05699E',
      secondaryColour: '#044D73',
      supportEmail: 'support@example.org',
      websiteUrl: 'https://example.org',
      footerText: 'For Ocean Foundation is a registered non-profit.',
      defaultCurrency: 'INR',
    },
  });

  // --- categories -----------------------------------------------------------
  const categoryIds = [];
  for (const [index, c] of CATEGORIES.entries()) {
    const created = await prisma.category.create({
      data: {
        uuid: crypto.randomUUID(),
        name: c.name,
        shortDescription: c.shortDescription,
        donationAmountMinor: rupees(c.amount),
        displayOrder: index,
        descriptions: {
          create: c.descriptions.map((text, position) => ({ position, text })),
        },
      },
    });
    categoryIds.push({ id: created.id, amountMinor: created.donationAmountMinor });
  }

  // --- admin ----------------------------------------------------------------
  const admin = await prisma.user.create({
    data: {
      uuid: crypto.randomUUID(),
      name: 'Demo Admin',
      email: 'admin@example.org',
      passwordHash,
      role: 'admin',
      isActive: true,
      isVerified: true,
    },
  });

  // --- users ----------------------------------------------------------------
  const users = [];
  const usedEmails = new Set(['admin@example.org']);

  for (let i = 0; i < userCount; i += 1) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);

    // The unique index on email is case-insensitive, so uniqueness must be
    // checked case-insensitively here too or the insert will fail.
    let email = `${first}.${last}${i}@example.org`.toLowerCase();
    while (usedEmails.has(email)) email = `${first}.${last}${i}.${crypto.randomInt(9999)}@example.org`.toLowerCase();
    usedEmails.add(email);

    users.push(
      await prisma.user.create({
        data: {
          uuid: crypto.randomUUID(),
          name: `${first} ${last}`,
          email,
          passwordHash,
          role: 'user',
          phone: `9${String(crypto.randomInt(100000000, 1000000000))}`,
          isActive: i % 20 !== 0, // a few disabled accounts, to exercise SEC-05
          isVerified: true,
        },
      })
    );
  }

  // --- donations ------------------------------------------------------------
  const donationCount = Math.max(userCount * 2, 40);
  let paidCount = 0;

  for (let i = 0; i < donationCount; i += 1) {
    const category = pick(categoryIds);
    const mix = pickWeighted(PAYMENT_MIX);

    // Roughly a third are guest donations, which is what user_id being
    // nullable exists for.
    const isGuest = crypto.randomInt(3) === 0;
    const donor = isGuest ? null : pick(users);

    const quantity = crypto.randomInt(1, 4);
    const baseAmountMinor = category.amountMinor * BigInt(quantity);

    // A top-up on some donations. Kept in whole rupees so the demo data
    // reads cleanly; the schema stores paise regardless.
    const extraAmountMinor = crypto.randomInt(4) === 0 ? rupees(crypto.randomInt(1, 21) * 50) : 0n;

    const donatedAt = recentDate(365);
    const isPaid = mix.payment === 'Paid';
    if (isPaid) paidCount += 1;

    await prisma.donation.create({
      data: {
        uuid: crypto.randomUUID(),
        transactionRef: crypto.randomUUID(),
        donorName: donor ? donor.name : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
        donorEmail: donor ? donor.email : `guest${i}@example.org`,
        donorPhone: `9${String(crypto.randomInt(100000000, 1000000000))}`,
        userId: donor ? donor.id : null,
        categoryId: category.id,
        quantity,
        baseAmountMinor,
        extraAmountMinor,
        amountMinor: baseAmountMinor + extraAmountMinor,
        currency: 'INR',
        status: mix.status,
        paymentStatus: mix.payment,
        failureReason: mix.payment === 'Failed' ? 'Bank declined the transaction' : null,
        errorMessage: mix.payment === 'Failed' ? 'E402: insufficient funds' : null,
        donatedAt,
        // Only paid donations carry a mihpayid. The unique index on it is the
        // SEC-01 replay guard, so the values must genuinely be distinct.
        paymentDetails: isPaid
          ? {
              create: {
                mihpayid: `DEMO${crypto.randomBytes(8).toString('hex')}`,
                amountMinor: baseAmountMinor + extraAmountMinor,
                mode: pick(['CC', 'DC', 'NB', 'UPI', 'WALLET']),
                bankRefNum: String(crypto.randomInt(100000000, 999999999)),
                gatewayStatus: 'success',
                paidAt: donatedAt,
              },
            }
          : undefined,
      },
    });
  }

  // --- report ---------------------------------------------------------------
  console.log(`  branding      1 row (For Ocean Foundation)`);
  console.log(`  categories    ${CATEGORIES.length}`);
  console.log(`  users         ${users.length + 1} (1 admin, ${users.length} donors)`);
  console.log(`  donations     ${donationCount} (${paidCount} paid)`);

  console.log('\n' + '='.repeat(68));
  console.log('  Demo credentials - shown once, not stored anywhere.');
  console.log('='.repeat(68));
  console.log(`  Admin     admin@example.org`);
  console.log(`  Password  ${password}`);
  console.log('='.repeat(68));
  console.log('  Every seeded account shares this password. Re-run the seeder');
  console.log('  if you lose it; there is no recovery path.\n');
}

main()
  .catch((err) => {
    console.error('\nSeeding failed:\n');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
