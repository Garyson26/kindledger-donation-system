/**
 * =============================================================================
 * Logo upload - SPEC-5 package 5.3
 * =============================================================================
 * New attack surface, and the constraints are not negotiable. Each one is here
 * with the attack it stops, because a constraint whose reason is elsewhere is a
 * constraint somebody relaxes.
 *
 * -----------------------------------------------------------------------------
 * 1. NO SVG, AND NOT BY LETTING THE DECODER DECIDE
 * -----------------------------------------------------------------------------
 * SVG is XML. It carries `<script>`, `onload=`, and external entity references,
 * and it is served from our own origin - so a stored SVG is stored XSS with the
 * session cookie of whoever opens it. An NGO admin uploading the logo their
 * designer sent is exactly how one arrives.
 *
 * **`sharp` DECODES SVG HAPPILY** - it is in its input format list. So "decode
 * it and see" would rasterise the SVG and accept it, and a naive implementation
 * would look like it worked. Worse, the decode itself runs librsvg against
 * attacker-controlled XML before any of our checks see it.
 *
 * The container is therefore identified from the MAGIC BYTES, before `sharp` is
 * given the buffer at all. The declared `Content-Type` and the filename
 * extension are ignored entirely - both are attacker-controlled strings.
 *
 * -----------------------------------------------------------------------------
 * 2. RE-ENCODED FROM DECODED PIXELS
 * -----------------------------------------------------------------------------
 * The bytes that land on disk are produced from the decoded raster, never
 * copied from the request. That is what neutralises a polyglot - a file that is
 * a valid PNG and a valid HTML document, or a JPEG with a PHP payload in a
 * comment segment. Re-encoding keeps the pixels and discards everything else,
 * including every metadata block.
 *
 * -----------------------------------------------------------------------------
 * 3. SIZE LIMITS BEFORE FULL DECODE
 * -----------------------------------------------------------------------------
 * A decompression bomb is a SMALL file. A 4 KB PNG can describe 50000x50000
 * pixels, which is 10 GB of RAM the moment anything decodes it.
 *
 * So there are three bounds, in order: the multipart byte limit (before we hold
 * the whole thing), `limitInputPixels` (which makes sharp refuse the DECLARED
 * dimensions before allocating), and a dimension check on the metadata - which
 * sharp reads from the header without decoding the pixel data.
 *
 * -----------------------------------------------------------------------------
 * 4. GENERATED FILENAMES
 * -----------------------------------------------------------------------------
 * No part of the uploaded name is used. Not sanitised - UNUSED. `../`, a null
 * byte, a leading `/`, a Windows drive letter, a trailing dot, a name that is
 * 4096 characters: all of it is discarded, so none of it has to be anticipated.
 *
 * The extension comes from what was DECODED, not from what was uploaded.
 *
 * -----------------------------------------------------------------------------
 * 5. CONTAINMENT IS ASSERTED AT THE PATH, NOT AT THE NAME
 * -----------------------------------------------------------------------------
 * `resolveWithin()` resolves the final absolute path and refuses anything
 * outside the uploads directory. It guards BOTH ends: the write, where the name
 * is ours and containment is nearly free, and the READ, where the path comes
 * back from the database.
 *
 * **That second one is the one people forget.** A stored path joined to a
 * directory is a traversal sink whatever the upload did, because the row could
 * have been written by an older version, a migration, or a different bug.
 * =============================================================================
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

/** Where the uploads volume is mounted. */
const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/var/lib/kindledger/uploads';
const BRANDING_DIR = 'branding';

/** The only three containers accepted, by magic bytes. */
const ACCEPTED = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 4000;
/** 40 megapixels. A logo is never this big; a bomb always is. */
const MAX_PIXELS = 40 * 1000 * 1000;

/**
 * Identify the container from its first bytes.
 *
 * Deliberately NOT a library. The whole point is that this runs before any
 * parser touches attacker-controlled bytes, so it reads a handful of constants
 * and nothing else. It returns null for everything it does not recognise -
 * including SVG, which is why SVG never reaches `sharp`.
 */
function sniffFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';

  // WebP: "RIFF" .... "WEBP"
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  return null;
}

/**
 * Resolve `relative` inside the uploads root, or throw.
 *
 * THE CHECK IS ON THE RESOLVED PATH, not on the string. `path.resolve` collapses
 * `..`, symlink-free, so comparing the result to the root is a statement about
 * where the file IS rather than about what the name looked like.
 *
 * `root + path.sep` and not `root`: without the separator, `/uploads-evil`
 * starts with `/uploads` and passes.
 */
function resolveWithin(relative, root = UPLOADS_ROOT) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, String(relative || ''));
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
    const err = new Error(
      `REFUSING: "${relative}" resolves to ${target}, which is outside the uploads directory.`
    );
    err.code = 'ERR_PATH_ESCAPE';
    throw err;
  }
  return target;
}

/**
 * Decode, validate and re-encode an uploaded logo.
 *
 * @returns {{relativePath: string, mime: string, width: number, height: number, bytes: number}}
 */
async function storeLogo(buffer, { root = UPLOADS_ROOT } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('No file was uploaded.');
    err.code = 'ERR_NO_FILE';
    throw err;
  }

  // BOUND ONE: bytes. multer also limits this, and it is repeated here because
  // this function is callable without going through multer.
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`The image is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    err.code = 'ERR_TOO_LARGE';
    throw err;
  }

  // THE SNIFF, BEFORE ANY DECODER SEES THE BYTES.
  const sniffed = sniffFormat(buffer);
  if (!sniffed) {
    const err = new Error(
      'Only PNG, JPEG and WebP images are accepted. SVG is not, because it can ' +
        'carry script and would be served from this origin.'
    );
    err.code = 'ERR_UNSUPPORTED_FORMAT';
    throw err;
  }

  // BOUND TWO: pixels, enforced by sharp BEFORE it allocates for the raster.
  const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, sequentialRead: true });

  let meta;
  try {
    // Reads the header only. A bomb is refused here, not after decoding it.
    meta = await image.metadata();
  } catch (err) {
    const wrapped = new Error('That file could not be read as an image.');
    wrapped.code = 'ERR_UNDECODABLE';
    wrapped.cause = err;
    throw wrapped;
  }

  // THE SNIFF AND THE DECODER MUST AGREE. Either alone is a single point of
  // trust: the sniff could be fooled by a container that starts with PNG magic
  // and is parsed as something else, and sharp's own detection is the thing we
  // declined to rely on for SVG.
  if (!ACCEPTED[meta.format] || meta.format !== sniffed) {
    const err = new Error(
      `The file's magic bytes say "${sniffed}" and its contents decode as ` +
        `"${meta.format}". Refusing a file that is two things at once.`
    );
    err.code = 'ERR_FORMAT_MISMATCH';
    throw err;
  }

  // BOUND THREE: dimensions, from the header.
  if (!meta.width || !meta.height || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    const err = new Error(`The image must be at most ${MAX_DIMENSION}x${MAX_DIMENSION} pixels.`);
    err.code = 'ERR_TOO_LARGE';
    throw err;
  }

  const target = ACCEPTED[meta.format];

  // RE-ENCODED FROM THE DECODED RASTER. `rotate()` with no argument applies the
  // EXIF orientation and then drops it, so the stored image is upright and
  // carries no metadata at all - sharp writes none unless asked.
  const reencoded = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .toFormat(meta.format)
    .toBuffer();

  // GENERATED NAME. Nothing from the upload appears in it.
  const filename = `${crypto.randomUUID()}.${target.ext}`;
  const relativePath = path.posix.join(BRANDING_DIR, filename);

  const absolute = resolveWithin(relativePath, root);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, reencoded, { flag: 'wx' });

  return {
    relativePath,
    mime: target.mime,
    width: meta.width,
    height: meta.height,
    bytes: reencoded.length,
  };
}

/**
 * Delete a previously stored logo.
 *
 * -----------------------------------------------------------------------------
 * THE PATH MUST COME FROM THE DATABASE, NEVER FROM A REQUEST (BS2)
 * -----------------------------------------------------------------------------
 * Replacing a logo without deleting the old one accumulates files for ever -
 * on a volume an NGO is paying for, holding images nothing references. So the
 * previous file IS deleted.
 *
 * That makes this a delete-by-path, which is a dangerous shape. It is safe only
 * because of two properties, and both are load-bearing:
 *
 *   1. the caller passes the value stored in `branding_settings.logo_path`, and
 *      the route never passes anything from `req`;
 *   2. it is resolved through `resolveWithin()` anyway - the database is not
 *      trusted either, because a row can be older than the current code.
 *
 * A missing file is NOT an error. The common reason is that the volume was
 * recreated while the row survived, and failing a logo change because the
 * previous image is already gone helps nobody.
 */
async function deleteLogo(relativePathFromDatabase, { root = UPLOADS_ROOT } = {}) {
  if (!relativePathFromDatabase) return { deleted: false, reason: 'nothing stored' };

  const absolute = resolveWithin(relativePathFromDatabase, root);
  try {
    await fs.unlink(absolute);
    return { deleted: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { deleted: false, reason: 'already absent' };
    throw err;
  }
}

module.exports = {
  UPLOADS_ROOT,
  BRANDING_DIR,
  ACCEPTED,
  MAX_BYTES,
  MAX_DIMENSION,
  MAX_PIXELS,
  sniffFormat,
  resolveWithin,
  storeLogo,
  deleteLogo,
};
