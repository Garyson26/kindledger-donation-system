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
async function list({ includeArchived = false, skip, take } = {}, tx) {
  const rows = await client(tx).category.findMany({
    where: includeArchived ? {} : { deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    select: SELECT,
    // Only applied when supplied, so the unpaginated caller is unaffected.
    ...(Number.isInteger(skip) ? { skip } : {}),
    ...(Number.isInteger(take) ? { take } : {}),
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

/** By the MongoDB ObjectId. The bridge's MySQL-first lookup (ADR-050). */
async function findByLegacyId(legacyId, tx) {
  if (!legacyId) return null;
  return normalise(
    await client(tx).category.findUnique({ where: { legacyId: String(legacyId) }, select: SELECT })
  );
}

/**
 * By name, for the duplicate check.
 *
 * Includes archived categories DELIBERATELY. `uq_categories_name` is a plain
 * UNIQUE key with no `deleted_at` in it, so an archived category still occupies
 * its name - filtering it out here would let the route report "available" and
 * then fail on the insert with a constraint violation, which is a 500 where a
 * 400 belongs.
 */
async function findByName(name, tx) {
  if (!name) return null;
  return normalise(
    await client(tx).category.findUnique({ where: { name: String(name) }, select: SELECT })
  );
}

/**
 * Partial update. ONLY the keys actually supplied are written.
 *
 * This is the BUG-09 fix and the reason this is not a spread. The Mongoose
 * route built `{ descriptions: descriptions || [] }` unconditionally, so a
 * caller sending only `{ donationAmount }` - which is what the edit-price form
 * sends - cleared the description list with no error.
 */
async function update(id, fields, tx) {
  const db = client(tx);
  const existing = await db.category.findUnique({ where: { uuid: id }, select: { id: true } });
  if (!existing) return null;

  const data = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.shortDescription !== undefined) data.shortDescription = fields.shortDescription;
  if (fields.donationAmountMinor !== undefined) {
    data.donationAmountMinor = BigInt(fields.donationAmountMinor);
  }
  if (fields.displayOrder !== undefined) data.displayOrder = fields.displayOrder;

  if (Object.keys(data).length > 0) {
    await db.category.update({ where: { id: existing.id }, data });
  }

  // `descriptions` is replaced only when the caller supplies the key at all.
  if (fields.descriptions !== undefined) {
    await replaceDescriptions(id, fields.descriptions, tx);
  }

  return findById(id, tx);
}

/** For the reorder endpoint. Returns false when the id does not resolve. */
async function setDisplayOrder(id, displayOrder, tx) {
  const db = client(tx);
  const existing = await db.category.findUnique({ where: { uuid: id }, select: { id: true } });
  if (!existing) return false;
  await db.category.update({ where: { id: existing.id }, data: { displayOrder } });
  return true;
}

/**
 * The next display order: max + 1, or 0 when there are none.
 *
 * Matches the Mongoose route's behaviour exactly, including that the FIRST
 * category gets 0 rather than 1. Archived rows are included, so archiving the
 * highest-ordered category does not cause the next new one to reuse its slot.
 */
async function nextDisplayOrder(tx) {
  const top = await client(tx).category.findFirst({
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  });
  return top ? (top.displayOrder || 0) + 1 : 0;
}

/** Active categories only, matching `list`. */
async function count(tx) {
  return client(tx).category.count({ where: { deletedAt: null } });
}

async function deleteByNamePrefix(prefix, tx) {
  const res = await client(tx).category.deleteMany({ where: { name: { startsWith: prefix } } });
  return res.count;
}

module.exports = {
  create,
  findById,
  findByLegacyId,
  findByName,
  list,
  count,
  update,
  setDisplayOrder,
  nextDisplayOrder,
  replaceDescriptions,
  archive,
  deleteByNamePrefix,
  normalise,
};
