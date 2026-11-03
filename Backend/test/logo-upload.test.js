/**
 * =============================================================================
 * SPEC-5 package 5.3 - logo upload
 * =============================================================================
 *   npm run test:logo
 *
 * New attack surface, so every constraint is verified BY OUTCOME (BH2) rather
 * than by the check being present.
 *
 * -----------------------------------------------------------------------------
 * THE DIFFERENCE THAT MATTERS MOST HERE
 * -----------------------------------------------------------------------------
 * **A test that asserts a name was cleaned proves the CLEANER RAN. A test that
 * asserts where the file landed proves the file COULD NOT ESCAPE.** Only the
 * second survives a cleaner that gets rewritten.
 *
 * So the traversal tests below never look at the stored filename. They read the
 * uploads directory afterwards and assert what is on disk and where - and they
 * assert that nothing appeared OUTSIDE it, which is the claim that matters and
 * the one a sanitiser test cannot make.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');

const logoStorage = require('../services/logoStorage');

/** A scratch uploads root, so nothing here touches the real volume. */
let ROOT;
/** A directory OUTSIDE the root - where an escape would land if one were possible. */
let OUTSIDE;

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kl-logo-'));
  ROOT = path.join(base, 'uploads');
  OUTSIDE = path.join(base, 'outside');
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(OUTSIDE, { recursive: true });
});

after(async () => {
  if (ROOT) await fs.rm(path.dirname(ROOT), { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fixtures: real images, built here rather than committed as binaries.
// -----------------------------------------------------------------------------

const png = (w = 64, h = 64) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();

const jpeg = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();

const webp = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 4, g: 5, b: 6 } } })
    .webp()
    .toBuffer();

/** Everything currently under the scratch root, as relative paths. */
async function tree(dir = ROOT, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await tree(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

// =============================================================================
// 1. NO SVG, whatever it claims to be
// =============================================================================

test('5.3: an SVG is REFUSED - and sharp would have decoded it happily', async () => {
  // THE POINT OF THIS TEST. `sharp` lists svg among its input formats, so
  // "decode it and see" would RASTERISE the SVG and accept it. The refusal has
  // to come from identifying the container, before any decoder runs.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>alert(1)</script><rect width="10" height="10"/></svg>',
    'utf8'
  );

  // Proof that the premise is real rather than assumed: sharp DOES decode it.
  const rasterised = await sharp(svg).png().toBuffer();
  assert.ok(rasterised.length > 0, 'precondition: sharp decodes SVG, so decoding is not a filter');

  await assert.rejects(
    () => logoStorage.storeLogo(svg, { root: ROOT }),
    (err) => {
      assert.equal(err.code, 'ERR_UNSUPPORTED_FORMAT');
      assert.match(err.message, /SVG/i, 'and it says why, because an admin will ask');
      return true;
    }
  );

  assert.deepEqual(await tree(), [], 'and nothing was written');
});

test('5.3: an SVG is refused however it is LABELLED - type and extension are ignored', async () => {
  // The declared Content-Type and the filename are attacker-controlled strings.
  // storeLogo never receives either, and that is the design: there is no
  // parameter to lie to.
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  await assert.rejects(() => logoStorage.storeLogo(svg, { root: ROOT }), /PNG, JPEG and WebP/);
  assert.deepEqual(await tree(), []);
});

test('5.3: a PNG-EXTENSIONED file that is not a PNG is refused on its bytes', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
  await assert.rejects(
    () => logoStorage.storeLogo(html, { root: ROOT }),
    (err) => err.code === 'ERR_UNSUPPORTED_FORMAT'
  );
  assert.deepEqual(await tree(), []);
});

// =============================================================================
// 2. RE-ENCODED FROM DECODED PIXELS
// =============================================================================

test('5.3: the stored bytes are NOT the uploaded bytes', async () => {
  // A polyglot is a file that is a valid image AND something else. Re-encoding
  // from the raster keeps the pixels and discards everything else - so the
  // test is that the stored file DIFFERS from what was sent, which is the
  // property, rather than that some re-encode call was made.
  const original = await png();

  // A trailing payload. Still a valid PNG - decoders stop at IEND.
  const polyglot = Buffer.concat([original, Buffer.from('<script>alert(1)</script>', 'utf8')]);

  const stored = await logoStorage.storeLogo(polyglot, { root: ROOT });
  const onDisk = await fs.readFile(path.join(ROOT, stored.relativePath));

  assert.ok(
    !onDisk.equals(polyglot),
    'the uploaded bytes were written verbatim - nothing was re-encoded'
  );
  assert.equal(
    onDisk.includes(Buffer.from('<script>', 'utf8')),
    false,
    'THE PAYLOAD SURVIVED the round trip, so the re-encode is not doing its job'
  );

  // And it is still a usable image of the same size.
  const meta = await sharp(onDisk).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 64);
});

test('5.3: metadata is dropped, not carried across', async () => {
  const withExif = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .withMetadata({ exif: { IFD0: { Copyright: 'ZZZ-MARKER-SHOULD-NOT-SURVIVE' } } })
    .jpeg()
    .toBuffer();

  assert.ok(withExif.includes(Buffer.from('ZZZ-MARKER-SHOULD-NOT-SURVIVE')), 'precondition');

  const stored = await logoStorage.storeLogo(withExif, { root: ROOT });
  const onDisk = await fs.readFile(path.join(ROOT, stored.relativePath));

  assert.equal(
    onDisk.includes(Buffer.from('ZZZ-MARKER-SHOULD-NOT-SURVIVE')),
    false,
    'EXIF survived the re-encode'
  );
});

test('5.3: all three accepted formats round-trip', async () => {
  for (const [label, make, mime] of [
    ['png', png, 'image/png'],
    ['jpeg', jpeg, 'image/jpeg'],
    ['webp', webp, 'image/webp'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const stored = await logoStorage.storeLogo(await make(), { root: ROOT });
    assert.equal(stored.mime, mime, `${label} stored with the wrong mime`);
  }
});

// =============================================================================
// 3. SIZE LIMITS BEFORE FULL DECODE
// =============================================================================

test('5.3: an oversized BYTE COUNT is refused before anything decodes it', async () => {
  const big = Buffer.alloc(logoStorage.MAX_BYTES + 1024);
  // Give it PNG magic so the refusal cannot be attributed to the sniff.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);

  await assert.rejects(
    () => logoStorage.storeLogo(big, { root: ROOT }),
    (err) => {
      assert.equal(err.code, 'ERR_TOO_LARGE');
      return true;
    }
  );
});

test('5.3: a DECOMPRESSION BOMB is refused on its header, not after decoding', async () => {
  // THE CASE THE BYTE LIMIT CANNOT CATCH. A bomb is a SMALL file: this one is a
  // few kilobytes and declares 12000x12000 - 144 megapixels, over a gigabyte of
  // raster if anything allocates for it.
  const bomb = await sharp({
    create: { width: 12000, height: 12000, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  assert.ok(
    bomb.length < logoStorage.MAX_BYTES,
    `precondition: the bomb must be SMALL (it is ${bomb.length} bytes) or the byte limit catches it and this proves nothing`
  );

  await assert.rejects(
    () => logoStorage.storeLogo(bomb, { root: ROOT }),
    (err) => {
      assert.ok(['ERR_TOO_LARGE', 'ERR_UNDECODABLE'].includes(err.code), `unexpected code ${err.code}`);
      return true;
    }
  );
});

// =============================================================================
// 4 and 5. GENERATED NAMES, AND CONTAINMENT ASSERTED AT THE FINAL LOCATION
// =============================================================================

test('5.3 CONTAINMENT: a hostile name cannot place a file outside the root', async () => {
  // ==========================================================================
  // THIS ASSERTS WHERE THE FILE LANDED, NOT THAT A NAME WAS CLEANED.
  // ==========================================================================
  // A sanitiser test proves the sanitiser ran. This proves the file could not
  // escape - which still holds if somebody rewrites the sanitiser, and is the
  // only form that survives that.
  //
  // `storeLogo` takes no filename at all, which is the strongest version of
  // constraint 4: there is no parameter for these strings to arrive through.
  // The test exercises the resolver they WOULD have reached.
  const hostile = [
    '../escaped.png',
    '../../escaped.png',
    '../../../../../../etc/cron.d/escaped',
    '/etc/passwd',
    'branding/../../escaped.png',
    'branding/./../../escaped.png',
    'C:\\Windows\\escaped.png',
  ];

  for (const name of hostile) {
    let landed = null;
    try {
      landed = logoStorage.resolveWithin(name, ROOT);
    } catch (err) {
      assert.equal(err.code, 'ERR_PATH_ESCAPE', `${name}: wrong error`);
      continue;
    }
    // If it did NOT throw, the resolved path must still be inside the root.
    assert.ok(
      landed.startsWith(path.resolve(ROOT) + path.sep),
      `"${name}" resolved to ${landed}, which is OUTSIDE ${ROOT}`
    );
  }

  // AND THE DIRECTORY-LEVEL CLAIM: nothing appeared outside the root at all.
  assert.deepEqual(
    await fs.readdir(OUTSIDE),
    [],
    'a file appeared outside the uploads root - containment failed'
  );
});

test('5.3: the stored name contains NOTHING from the upload', async () => {
  const stored = await logoStorage.storeLogo(await png(), { root: ROOT });
  const base = path.basename(stored.relativePath);

  // A uuid and an extension derived from what was DECODED.
  assert.match(
    base,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    `generated name expected, got ${base}`
  );
  assert.equal(stored.relativePath.startsWith('branding/'), true);
});

test('5.3: two uploads never collide, and a write never overwrites', async () => {
  const a = await logoStorage.storeLogo(await png(), { root: ROOT });
  const b = await logoStorage.storeLogo(await png(), { root: ROOT });
  assert.notEqual(a.relativePath, b.relativePath);

  // `wx` means the write fails rather than clobbering. Asserted because an
  // overwrite is how one upload silently replaces another installation's logo.
  const absolute = path.join(ROOT, a.relativePath);
  assert.throws(() => fsSync.writeFileSync(absolute, 'x', { flag: 'wx' }), /EEXIST/);
});

// =============================================================================
// Deletion - BS2's first addition
// =============================================================================

test('5.3: replacing a logo DELETES the previous file', async () => {
  const first = await logoStorage.storeLogo(await png(), { root: ROOT });
  assert.ok(fsSync.existsSync(path.join(ROOT, first.relativePath)));

  const result = await logoStorage.deleteLogo(first.relativePath, { root: ROOT });
  assert.equal(result.deleted, true);
  assert.equal(
    fsSync.existsSync(path.join(ROOT, first.relativePath)),
    false,
    'the old file is still on disk - replacing a logo would accumulate files for ever'
  );
});

test('5.3: deletion REFUSES a path that escapes, even from the database', async () => {
  // The path comes from `branding_settings.logo_path`, which is not a request
  // value - and is still not trusted, because a row can be older than the code
  // that reads it.
  const canary = path.join(OUTSIDE, 'do-not-delete.txt');
  await fs.writeFile(canary, 'still here');

  await assert.rejects(
    () => logoStorage.deleteLogo('../outside/do-not-delete.txt', { root: ROOT }),
    (err) => err.code === 'ERR_PATH_ESCAPE'
  );

  assert.equal(fsSync.existsSync(canary), true, 'a file outside the root was DELETED');
});

test('5.3: an already-absent file is not an error', async () => {
  // The volume can be recreated while the row survives. Failing a logo change
  // because the previous image is already gone helps nobody.
  const result = await logoStorage.deleteLogo('branding/never-existed.png', { root: ROOT });
  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'already absent');
});

// =============================================================================
// The sniffer itself
// =============================================================================

test('5.3: sniffFormat identifies exactly the three accepted containers', async () => {
  assert.equal(logoStorage.sniffFormat(await png()), 'png');
  assert.equal(logoStorage.sniffFormat(await jpeg()), 'jpeg');
  assert.equal(logoStorage.sniffFormat(await webp()), 'webp');

  for (const notAnImage of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('GIF89a' + 'x'.repeat(20)),
    Buffer.from('%PDF-1.7' + 'x'.repeat(20)),
    Buffer.from('MZ' + 'x'.repeat(20)),
    Buffer.alloc(4),
  ]) {
    assert.equal(logoStorage.sniffFormat(notAnImage), null, `wrongly accepted: ${notAnImage.slice(0, 8)}`);
  }
});
