/**
 * =============================================================================
 * Branding settings repository (SPEC-2 section 4)
 * =============================================================================
 * A singleton row at id = 1, enforced by CHECK (id = 1) and seeded by
 * db/schema.sql so the application never has to handle a missing settings row.
 * There is therefore no create() - only get and update.
 *
 * THE KINDLEDGER ATTRIBUTION IS NOT HERE AND MUST NEVER BE (SPEC-1A section
 * 5.7). Adding it to this table would make removing it a supported admin
 * action, which defeats the purpose.
 * =============================================================================
 */

'use strict';

const { client, iso } = require('./_shared');

const SINGLETON_ID = 1;

const SELECT = {
  id: true,
  organisationName: true,
  logoPath: true,
  logoMime: true,
  faviconPath: true,
  primaryColour: true,
  secondaryColour: true,
  supportEmail: true,
  websiteUrl: true,
  footerText: true,
  defaultCurrency: true,
  updatedAt: true,
  updatedByUser: { select: { uuid: true, name: true } },
};

function normalise(row) {
  if (!row) return null;
  return {
    organisationName: row.organisationName,
    logoPath: row.logoPath ?? null,
    logoMime: row.logoMime ?? null,
    faviconPath: row.faviconPath ?? null,
    primaryColour: row.primaryColour ?? null,
    secondaryColour: row.secondaryColour ?? null,
    supportEmail: row.supportEmail ?? null,
    websiteUrl: row.websiteUrl ?? null,
    footerText: row.footerText ?? null,
    defaultCurrency: row.defaultCurrency,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedByUser
      ? { id: row.updatedByUser.uuid, name: row.updatedByUser.name }
      : null,
  };
}

async function get(tx) {
  return normalise(
    await client(tx).brandingSettings.findUnique({ where: { id: SINGLETON_ID }, select: SELECT })
  );
}

/**
 * Update the singleton.
 *
 * updatedBy is an external user uuid, resolved here. Colour values are NOT
 * validated in this function: the CHECK constraints enforce
 * ^#[0-9A-Fa-f]{6}$, so a malformed colour is rejected by MySQL. A duplicate
 * check here could drift from the constraint, and then one of the two would be
 * wrong without anything saying so.
 *
 * Only the listed fields are assignable. Spreading `fields` straight into the
 * update would let a caller set id, updatedAt, or anything else the schema
 * gains later.
 */
async function update(fields, updatedByUserId, tx) {
  const db = client(tx);

  let updatedBy;
  if (updatedByUserId) {
    const user = await db.user.findUnique({
      where: { uuid: updatedByUserId },
      select: { id: true },
    });
    updatedBy = user ? user.id : null;
  }

  const assignable = [
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

  const data = {};
  for (const key of assignable) {
    if (fields[key] !== undefined) data[key] = fields[key];
  }
  if (updatedBy !== undefined) data.updatedBy = updatedBy;

  await db.brandingSettings.update({ where: { id: SINGLETON_ID }, data });
  return get(tx);
}

module.exports = { get, update, normalise, SINGLETON_ID };
