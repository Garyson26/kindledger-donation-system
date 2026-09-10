/**
 * =============================================================================
 * Category repository (SPEC-2 section 4)
 * =============================================================================
 * donationAmountMinor is the authoritative price. Every read path filters
 * deletedAt: null, because ADR-004 made category deletion a SOFT delete - a
 * financial record must not lose the category that priced it, and
 * donations.category_id carries ON DELETE RESTRICT.
 * =============================================================================
 */

'use strict';

const { client, newUuid, fromBigInt, iso } = require('./_shared');

const SELECT = {
  uuid: true,
  legacyId: true,
  name: true,
  shortDescription: true,
  donationAmountMinor: true,
  displayOrder: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  descriptions: { select: { position: true, text: true }, orderBy: { position: 'asc' } },
};

function normalise(row) {
  if (!row) return null;
  return {
    id: row.uuid,
    legacyId: row.legacyId,
    name: row.name,
    shortDescription: row.shortDescription,
    donationAmountMinor: fromBigInt(row.donationAmountMinor),
    displayOrder: row.displayOrder,
    isArchived: Boolean(row.deletedAt),
    archivedAt: iso(row.deletedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    descriptions: (row.descriptions || []).map((d) => d.text),
  };
}

async function create(input, tx) {
  const row = await client(tx).category.create({
    data: {
      uuid: input.uuid || newUuid(),
      legacyId: input.legacyId ?? null,
      name: input.name,
      shortDescription: input.shortDescription,
      donationAmountMinor: BigInt(input.donationAmountMinor),
      displayOrder: input.displayOrder ?? 0,
      descriptions: {
        create: (input.descriptions || []).map((text, position) => ({ position, text })),
      },
    },
    select: SELECT,
  });
  return normalise(row);
}

async function findById(id, tx) {
  return normalise(await client(tx).category.findUnique({ where: { uuid: id }, select: SELECT }));
}

/** Active categories only. includeArchived is for admin views and the ETL. */
async function list({ includeArchived = false } = {}, tx) {
  const rows = await client(tx).category.findMany({
    where: includeArchived ? {} : { deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    select: SELECT,
  });
  return rows.map(normalise);
}

/**
 * Replace the description list.
 *
 * Delete-then-insert, and the ordering is load-bearing rather than stylistic:
 * UNIQUE (category_id, position) means inserting before deleting would collide
 * transiently. Callers should wrap this in withTransaction so a failure between
 * the two does not leave the list empty (ADR-005).
 */
async function replaceDescriptions(id, texts, tx) {
  const db = client(tx);
  const cat = await db.category.findUnique({ where: { uuid: id }, select: { id: true } });
  if (!cat) return null;

  await db.categoryDescription.deleteMany({ where: { categoryId: cat.id } });
  if (texts.length > 0) {
    await db.categoryDescription.createMany({
      data: texts.map((text, position) => ({ categoryId: cat.id, position, text })),
    });
  }
  return findById(id, tx);
}

/** ADR-004: archive, never hard delete. */
async function archive(id, tx) {
  await client(tx).category.update({ where: { uuid: id }, data: { deletedAt: new Date() } });
  return findById(id, tx);
}

async function deleteByNamePrefix(prefix, tx) {
  const res = await client(tx).category.deleteMany({ where: { name: { startsWith: prefix } } });
  return res.count;
}

module.exports = {
  create,
  findById,
  list,
  replaceDescriptions,
  archive,
  deleteByNamePrefix,
  normalise,
};
