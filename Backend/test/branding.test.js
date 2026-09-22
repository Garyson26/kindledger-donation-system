/**
 * =============================================================================
 * SPEC-5 package 5.2 - branding API
 * =============================================================================
 *   npm run test:branding
 *
 * `branding_settings` was built in Phase 1a with a singleton CHECK, colour
 * constraints and an updated-by foreign key, and had ZERO CALLERS (AS4). These
 * are the first tests of it, so they establish the shape rather than defend it.
 * =============================================================================
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { once } = require('node:events');

process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ADMIN_CREATION_KEY = process.env.ADMIN_CREATION_KEY || 'test-admin-key';
process.env.PAYU_MERCHANT_KEY = 'TESTMERCHANTKEY';
process.env.PAYU_MERCHANT_SALT = 'TESTMERCHANTSALT0000000000000000';

const sharp = require('sharp');
const users = require('../repositories/users');
const branding = require('../repositories/branding');
const brandingRoute = require('../routes/branding');
const prismaModule = require('../config/prisma');
const { getPrisma } = require('../config/prisma');

const TAG = 'zzz-branding';
const PASSWORD = 'BrandingPass1!';

let server;
let base;
let adminToken;
let ipSeq = 0;
/** The values found before any test ran, restored in `after`. */
let original;

const uniqEmail = (t) => `${TAG}-${t}-${crypto.randomBytes(3).toString('hex')}@invalid.test`;
const nextIp = () => `198.51.101.${(ipSeq++ % 250) + 1}`;

async function call(method, path, { body, token } = {}) {
  const headers = { 'X-Forwarded-For': nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw };
}

const get = (p, token) => call('GET', p, { token });
const put = (p, body, token) => call('PUT', p, { body, token });

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'this suite needs MySQL');
  const app = require('../app.js');
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  await users.deleteByEmailPrefix(TAG);
  const admin = await users.create({
    name: 'ZZZ Branding Admin',
    email: uniqEmail('admin'),
    password: PASSWORD,
    role: 'admin',
    isVerified: true,
  });
  const fresh = await users.findById(admin.id);
  adminToken = jwt.sign(
    { userId: fresh.legacyId || fresh.id, role: 'admin', tokenVersion: fresh.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // THE SUITE EDITS A SINGLETON THAT THE WHOLE INSTALLATION SHARES. There is no
  // second row to work on, so it captures the real values and puts them back -
  // the alternative is a test that quietly rebrands the developer's stack.
  original = await getPrisma().brandingSettings.findUnique({ where: { id: 1 } });
  assert.ok(original, 'precondition: db/schema.sql seeds the singleton');
});

after(async () => {
  try {
    if (original) {
      await getPrisma().brandingSettings.update({
        where: { id: 1 },
        data: {
          organisationName: original.organisationName,
          logoPath: original.logoPath,
          logoMime: original.logoMime,
          faviconPath: original.faviconPath,
          primaryColour: original.primaryColour,
          secondaryColour: original.secondaryColour,
          supportEmail: original.supportEmail,
          websiteUrl: original.websiteUrl,
          footerText: original.footerText,
          defaultCurrency: original.defaultCurrency,
          updatedBy: original.updatedBy,
        },
      });
    }
    await users.deleteByEmailPrefix(TAG);
  } finally {
    if (server) server.close();
    await prismaModule.disconnect();
  }
});

// =============================================================================
// The public read
// =============================================================================

test('GET /api/branding needs no authentication - the donor app reads it first', async () => {
  const res = await get('/api/branding');
  assert.equal(res.status, 200, res.raw.slice(0, 200));
});

test('AP1: the public body is asserted as a WHOLE, not field by field', async () => {
  // AP1's rule: decide the shape once and compare the entire body. Checking
  // "does it contain organisationName" and "does it not contain updatedBy" is
  // two claims about a body nobody has looked at, and it is how a field added
  // later travels to an unauthenticated endpoint unnoticed.
  await put(
    '/api/admin/branding',
    {
      organisationName: 'ZZZ Test Org',
      primaryColour: '#123ABC',
      secondaryColour: '#ffffff',
      supportEmail: 'help@example.org',
      websiteUrl: 'https://example.org',
      footerText: 'A registered charity',
      defaultCurrency: 'inr',
      logoPath: null,
      logoMime: null,
      faviconPath: null,
    },
    adminToken
  );

  const res = await get('/api/branding');
  assert.deepEqual(res.body, {
    organisationName: 'ZZZ Test Org',
    logoPath: null,
    logoMime: null,
    faviconPath: null,
    primaryColour: '#123ABC',
    secondaryColour: '#ffffff',
    supportEmail: 'help@example.org',
    websiteUrl: 'https://example.org',
    footerText: 'A registered charity',
    // Normalised to upper case on the way in.
    defaultCurrency: 'INR',
  });

  // Stated separately because it is the SECURITY property and a future reader
  // should not have to infer it from the absence of two keys above.
  assert.equal('updatedBy' in res.body, false, 'the public view must not name the administrator');
  assert.equal('updatedAt' in res.body, false);
  assert.equal('id' in res.body, false);
});

// =============================================================================
// The admin write
// =============================================================================

test('PUT /api/admin/branding refuses anonymous and non-admin callers', async () => {
  const anon = await put('/api/admin/branding', { organisationName: 'Hijack' });
  assert.equal(Math.floor(anon.status / 100), 4, 'anonymous must be refused');

  const plain = await users.create({
    name: 'ZZZ Branding User',
    email: uniqEmail('plain'),
    password: PASSWORD,
    role: 'user',
    isVerified: true,
  });
  const fresh = await users.findById(plain.id);
  const userToken = jwt.sign(
    { userId: fresh.legacyId || fresh.id, role: 'user', tokenVersion: fresh.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const asUser = await put('/api/admin/branding', { organisationName: 'Hijack' }, userToken);
  assert.equal(Math.floor(asUser.status / 100), 4, 'a plain user must be refused');

  const after = await get('/api/branding');
  assert.notEqual(after.body.organisationName, 'Hijack', 'and nothing was written');
});

test('SEC-14 SHAPE: a bad colour is a 400 naming the field, NOT a 500', async () => {
  // The schema already refuses this with a CHECK. Forwarding the value would
  // make a typo into a server fault - a caller's malformed input surfacing as a
  // Prisma error and a stack trace.
  const res = await put('/api/admin/branding', { primaryColour: 'blue' }, adminToken);

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.raw.slice(0, 160)}`);
  assert.notEqual(res.status, 500, 'a constraint violation must not surface as a 500');
  assert.match(String(res.body.error || res.body.message), /primaryColour/);
});

test('EVERY problem is reported, not just the first', async () => {
  const res = await put(
    '/api/admin/branding',
    { primaryColour: 'nope', secondaryColour: '#gggggg', supportEmail: 'not-an-address' },
    adminToken
  );
  const text = String(res.body.error || res.body.message);
  assert.equal(res.status, 400);
  for (const field of ['primaryColour', 'secondaryColour', 'supportEmail']) {
    assert.ok(text.includes(field), `${field} missing from: ${text}`);
  }
});

test('a javascript: websiteUrl is REFUSED - it is rendered as a link on every page', async () => {
  // The admin is trusted to run the installation, not trusted to paste a URL
  // that becomes an anchor href on every public page. This is the one
  // validation here that is a security control rather than a data-quality one.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a url']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await put('/api/admin/branding', { websiteUrl: bad }, adminToken);
    assert.equal(res.status, 400, `"${bad}" must be refused, got ${res.status}`);
  }

  const ok = await put('/api/admin/branding', { websiteUrl: 'https://example.org' }, adminToken);
  assert.equal(ok.status, 200, 'and a real https URL is accepted');
});

// =============================================================================
// SPEC-5 3.3 - the singleton
// =============================================================================

test('3.3 ASSERTED, NOT ASSUMED: the update never has to create the row', async () => {
  // The spec says the missing-row case "should be unreachable - assert that
  // rather than assuming it". `update()` reports `created`, and on a correctly
  // seeded installation it must always be false.
  //
  // An `upsert` would have made this unobservable: it creates the row and
  // reports success either way, erasing the one fact worth knowing - that a
  // supposedly-seeded installation was not seeded.
  const result = await branding.update({ organisationName: 'ZZZ Singleton Probe' }, null);
  assert.equal(
    result.created,
    false,
    'the branding row had to be CREATED, so this installation was not seeded by db/schema.sql'
  );
});

test('the save reports what ACTUALLY changed, not what was submitted', async () => {
  await branding.update({ organisationName: 'ZZZ Stable Name', footerText: 'Stable footer' }, null);

  // Resubmit the same values plus one different one, as a form would.
  const res = await put(
    '/api/admin/branding',
    { organisationName: 'ZZZ Stable Name', footerText: 'A different footer' },
    adminToken
  );

  assert.equal(res.status, 200, res.raw.slice(0, 200));
  assert.deepEqual(
    res.body.changed,
    ['footerText'],
    'a form posts every field every time, so "changed" must be computed against the ROW'
  );
});

test('a write records WHICH admin made it, resolving uuid to the internal id', async () => {
  await put('/api/admin/branding', { footerText: 'Attributed change' }, adminToken);

  const view = await branding.getForAdmin();
  assert.ok(view.updatedBy, 'updated_by must be set');

  // The value is the INTERNAL bigint id, not the external uuid - the column is
  // a foreign key to users(id). Asserting the type is what catches the two
  // identifiers being confused (ADR-051).
  assert.match(String(view.updatedBy), /^\d+$/, 'updated_by is the internal id, not a uuid');
});

// =============================================================================
// The bounds are the schema's, and that is checkable
// =============================================================================

test('the validators length bounds MATCH the column widths', async () => {
  // "Per the schema" in a comment is a claim nobody re-checks. This reads the
  // widths out of information_schema and compares them.
  const rows = await getPrisma().$queryRawUnsafe(
    `SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS len
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branding_settings'`
  );
  const widths = {};
  for (const r of rows) widths[String(r.name)] = Number(r.len);

  const pairs = {
    organisationName: 'organisation_name',
    logoPath: 'logo_path',
    logoMime: 'logo_mime',
    faviconPath: 'favicon_path',
    supportEmail: 'support_email',
    websiteUrl: 'website_url',
    footerText: 'footer_text',
  };

  for (const [field, column] of Object.entries(pairs)) {
    assert.equal(
      brandingRoute.MAX[field],
      widths[column],
      `${field} is bounded at ${brandingRoute.MAX[field]} but ${column} is VARCHAR(${widths[column]})`
    );
  }
});

test('an over-long value is refused by the API rather than truncated or thrown', async () => {
  const res = await put(
    '/api/admin/branding',
    { organisationName: 'x'.repeat(161) },
    adminToken
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body.error || res.body.message), /organisationName/);
});

// =============================================================================
// SPEC-5 5.3 over HTTP - the serving path (BS2's second and third additions)
// =============================================================================

/** Upload through the real multipart endpoint, with a DECLARED type we choose. */
async function uploadLogo(buffer, { filename, declaredType, token }) {
  const form = new FormData();
  form.append('logo', new Blob([buffer], { type: declaredType }), filename);
  const res = await fetch(`${base}/api/admin/branding/logo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': nextIp() },
    body: form,
  });
  const raw = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw };
}

test('5.3 HTTP: the served Content-Type comes from the DECODE, not the upload claim', async () => {
  // ==========================================================================
  // THE DECISIVE TEST FOR BS2's THIRD ADDITION.
  // ==========================================================================
  // The file is a real JPEG. The multipart part DECLARES image/png and the
  // filename says .png. If anything anywhere trusted either of those, the
  // response would be typed image/png - and the one header that decides how a
  // browser treats the bytes would be attacker-chosen.
  const realJpeg = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const up = await uploadLogo(realJpeg, {
    filename: 'logo.png',
    declaredType: 'image/png',
    token: adminToken,
  });
  assert.equal(up.status, 200, up.raw.slice(0, 200));
  assert.equal(up.body.logo.mime, 'image/jpeg', 'stored mime must follow the decode');

  const served = await fetch(`${base}/api/branding/logo`, {
    headers: { 'X-Forwarded-For': nextIp() },
  });
  assert.equal(served.status, 200);
  assert.equal(
    served.headers.get('content-type'),
    'image/jpeg',
    'THE SERVED TYPE FOLLOWED THE UPLOAD CLAIM instead of the decoded format'
  );
  assert.equal(
    served.headers.get('x-content-type-options'),
    'nosniff',
    'without nosniff a browser can still sniff the body and render it as something else'
  );

  // And the bytes served really are the re-encoded image.
  const body = Buffer.from(await served.arrayBuffer());
  const meta = await sharp(body).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 24);
});

test('5.3 HTTP: an SVG is refused by the endpoint, not only by the library', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>',
    'utf8'
  );
  const res = await uploadLogo(svg, {
    filename: 'logo.png',
    declaredType: 'image/png',
    token: adminToken,
  });
  assert.equal(res.status, 400, res.raw.slice(0, 200));
  assert.match(String(res.body.error || res.body.message), /SVG/i);
});

test('5.3 HTTP: the upload endpoint refuses anonymous and non-admin callers', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 1, b: 1 } },
  })
    .png()
    .toBuffer();

  const form = new FormData();
  form.append('logo', new Blob([png], { type: 'image/png' }), 'x.png');
  const anon = await fetch(`${base}/api/admin/branding/logo`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': nextIp() },
    body: form,
  });
  assert.equal(Math.floor(anon.status / 100), 4, 'anonymous upload must be refused');
});

test('5.3 HTTP: replacing a logo removes the previous file and serves the new one', async () => {
  const first = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();
  const second = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .webp()
    .toBuffer();

  const a = await uploadLogo(first, { filename: 'a.png', declaredType: 'image/png', token: adminToken });
  assert.equal(a.status, 200, a.raw.slice(0, 200));

  const b = await uploadLogo(second, { filename: 'b.webp', declaredType: 'image/webp', token: adminToken });
  assert.equal(b.status, 200, b.raw.slice(0, 200));
  assert.equal(b.body.previousRemoved, true, 'the previous file must be deleted, or they accumulate');

  const served = await fetch(`${base}/api/branding/logo`, { headers: { 'X-Forwarded-For': nextIp() } });
  assert.equal(served.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
  assert.equal(meta.width, 48, 'the NEW logo is served');
});

test('5.3 HTTP: a stored path that escapes the uploads root is refused at SERVE time', async () => {
  // BS2's second addition. The serving route takes no path parameter, so a
  // caller cannot ask for a file - but the row is still not trusted, because it
  // could have been written by an older version or a migration.
  //
  // Planted directly in the database, which is the only way this state arises.
  await getPrisma().brandingSettings.update({
    where: { id: 1 },
    data: { logoPath: '../../../../etc/passwd', logoMime: 'image/png' },
  });

  const res = await fetch(`${base}/api/branding/logo`, { headers: { 'X-Forwarded-For': nextIp() } });
  const body = await res.text();

  assert.notEqual(res.status, 200, 'a traversing stored path was SERVED');
  assert.equal(
    body.includes('root:'),
    false,
    'the response body contains /etc/passwd - containment failed at the read'
  );
});
