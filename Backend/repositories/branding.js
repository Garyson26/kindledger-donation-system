/**
 * =============================================================================
 * branding_settings - the singleton the schema has had since Phase 1a
 * =============================================================================
 * SPEC-5 package 5.2. The table was built in Phase 1a with a singleton CHECK,
 * colour constraints and an updated-by foreign key, and had **zero callers
 * anywhere** (AS4). This file is the first one.
 *
 * -----------------------------------------------------------------------------
 * TWO PROJECTIONS, AND THE DIFFERENCE IS THE POINT (AE2)
 * -----------------------------------------------------------------------------
 * `publicView()` is what an UNAUTHENTICATED caller gets. The donor app needs
 * branding before anyone logs in, so `GET /api/branding` has no auth at all -
 * which makes the projection the only thing standing between that endpoint and
 * whatever the table grows later.
 *
 * It is an ALLOWLIST built field by field, never a copy of the row with
 * deletions. A denylist is wrong the first time a column is added, and the
 * column that gets added is never the harmless one - `updated_by` is already
 * there, and it is a user id.
 *
 * `adminView()` adds `updatedBy` and `updatedAt`, because an admin editing
 * settings should see who changed them last.
 * =============================================================================
 */

'use strict';

const { client, fromBigInt, iso } = require('./_shared');

/** The singleton's only legal id. `CHECK (id = 1)` makes a second row impossible. */
const SINGLETON_ID = 1;

/**
 * What the public site renders, and nothing else.
 *
 * NO `id`, NO `updated_by`, NO `updated_at` - SPEC-5 section 3.1. The row id is
 * always 1 and says nothing; the other two describe WHO administers this
 * installation and WHEN they last touched it, which is not a donor's business
 * and is exactly the kind of field that leaks by being copied along.
 */
function publicView(row) {
  if (!row) return null;
  return {
    organisationName: row.organisationName,
    logoPath: row.logoPath || null,
    logoMime: row.logoMime || null,
    faviconPath: row.faviconPath || null,
    primaryColour: row.primaryColour || null,
    secondaryColour: row.secondaryColour || null,
    supportEmail: row.supportEmail || null,
    websiteUrl: row.websiteUrl || null,
    footerText: row.footerText || null,
    defaultCurrency: row.defaultCurrency,
  };
}

/** The admin view: the public fields plus provenance. */
function adminView(row) {
  if (!row) return null;
  return {
    ...publicView(row),
    updatedBy: row.updatedBy === null || row.updatedBy === undefined ? null : fromBigInt(row.updatedBy),
    updatedAt: iso(row.updatedAt),
  };
}

async function findRow(tx) {
  return client(tx).brandingSettings.findUnique({ where: { id: SINGLETON_ID } });
}

async function getPublic(tx) {
  return publicView(await findRow(tx));
}

async function getForAdmin(tx) {
  return adminView(await findRow(tx));
}

/**
 * The fields an admin may set. Anything not named here cannot be written
 * through this function, whatever the request body contains.
 */
const WRITABLE = [
  'organisationName',
  'logoPath',
  'logoMime',
  'faviconPath',
  'primaryColour',
  'secondaryColour',
  'supportEmail',
  'websiteUrl',
  'footerText',
  'defaultCurrency',
];

/**
 * Update the singleton.
 *
 * -----------------------------------------------------------------------------
 * IT NEVER INSERTS WHEN THE ROW EXISTS, AND THE ROW ALWAYS EXISTS (SPEC-5 3.3)
 * -----------------------------------------------------------------------------
 * A fresh installation seeds it (Phase 1a section 5.7), so the missing-row case
 * should be unreachable. The spec says to ASSERT that rather than assume it, so
 * this returns `{ created: true }` when it had to create the row - and the test
 * asserts that flag is FALSE on a normal installation.
 *
 * `upsert` would hide the difference: it would silently create the row and
 * report success either way, and the one fact worth knowing - that a
 * supposedly-seeded installation was not seeded - would be the fact it erased.
 *
 * @returns {{row: object, created: boolean, changed: string[]}}
 */
async function update(input, adminUuid, tx) {
  const db = client(tx);

  const data = {};
  for (const field of WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(input, field)) data[field] = input[field];
  }

  // `updated_by` is the INTERNAL BIGINT id, not the external uuid the request
  // carries. Resolved here rather than in the route, because a route that has
  // to know the difference between the two identifiers is a route that will
  // eventually pass the wrong one - ADR-051 exists because that distinction is
  // easy to lose.
  //
  // An unresolvable admin writes NULL rather than failing the update: the FK is
  // ON DELETE SET NULL, so the column already means "possibly nobody we can
  // name", and refusing a branding change because the admin's row moved would
  // be a worse outcome than an unattributed one.
  let updatedBy = null;
  if (adminUuid) {
    const admin = await db.user.findUnique({ where: { uuid: String(adminUuid) }, select: { id: true } });
    updatedBy = admin ? admin.id : null;
  }
  data.updatedBy = updatedBy;

  const existing = await db.brandingSettings.findUnique({ where: { id: SINGLETON_ID } });

  if (!existing) {
    const row = await db.brandingSettings.create({
      data: { id: SINGLETON_ID, organisationName: 'Organisation', ...data },
    });
    return { row: adminView(row), created: true, changed: Object.keys(data) };
  }

  // WHAT ACTUALLY CHANGED, not what was submitted (SPEC-5 3.4: "the save
  // reports what actually changed"). A form posts every field every time, so
  // "changed" computed from the request body would always be the whole form.
  const changed = Object.keys(data).filter(
    (k) => k !== 'updatedBy' && String(existing[k] ?? '') !== String(data[k] ?? '')
  );

  const row = await db.brandingSettings.update({ where: { id: SINGLETON_ID }, data });
  return { row: adminView(row), created: false, changed };
}

module.exports = {
  SINGLETON_ID,
  WRITABLE,
  publicView,
  adminView,
  getPublic,
  getForAdmin,
  update,
};
