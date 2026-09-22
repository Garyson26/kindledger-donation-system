/**
 * =============================================================================
 * Branding - the public read, and the admin write (SPEC-5 package 5.2)
 * =============================================================================
 *   GET /api/branding          no auth. The donor app needs this before login
 *   PUT /api/admin/branding    adminAuth. Mounted from routes/admin.js
 *
 * -----------------------------------------------------------------------------
 * VALIDATION REFUSES BEFORE THE DATABASE DOES, AND THAT IS THE POINT
 * -----------------------------------------------------------------------------
 * `branding_settings` already constrains the colours with
 * `CHECK (REGEXP_LIKE(primary_colour, '^#[0-9A-Fa-f]{6}$'))`. If the API just
 * forwarded the value, a bad colour would surface as a Prisma error and a 500 -
 * **the SEC-14 shape**, where a caller's malformed input becomes a server fault
 * and the log fills with stack traces for something that is simply a typo.
 *
 * So the API validates the same rule and answers 400 with the field named. The
 * CHECK stays as the backstop: it is what makes the rule true of the DATA, and
 * this is what makes the response true of the REQUEST. Neither replaces the
 * other, and the duplication is deliberate rather than an oversight.
 * =============================================================================
 */

'use strict';

const express = require('express');
const branding = require('../repositories/branding');
const { refuse, failed } = require('../utils/respond');

const router = express.Router();

/** The same expression as `ck_branding_settings_primary_colour`. */
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/**
 * Length bounds, from the schema. Written as numbers next to the field names
 * because "per the schema" in a comment is a claim nobody re-checks - and
 * `test/branding.test.js` asserts these match the column widths.
 */
const MAX = {
  organisationName: 160,
  logoPath: 512,
  logoMime: 64,
  faviconPath: 512,
  supportEmail: 255,
  websiteUrl: 512,
  footerText: 500,
};

/** Deliberately permissive: an address is validated by sending mail to it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns an array of problems - EVERY problem, not the first.
 *
 * A form with four bad fields should not need four round trips to discover
 * that. Reporting one at a time is how a settings page becomes tedious enough
 * that somebody stops using it.
 */
function validate(body) {
  const problems = [];

  if (Object.prototype.hasOwnProperty.call(body, 'organisationName')) {
    const v = String(body.organisationName || '').trim();
    if (!v) problems.push('organisationName must not be empty');
    else if (v.length > MAX.organisationName) {
      problems.push(`organisationName must be at most ${MAX.organisationName} characters`);
    }
  }

  for (const field of ['primaryColour', 'secondaryColour']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const v = body[field];
    if (v === null || v === '') continue; // clearing a colour is legitimate
    if (!HEX_COLOUR.test(String(v))) {
      problems.push(`${field} must be a hex colour like #1A2B3C`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'supportEmail')) {
    const v = body.supportEmail;
    if (v !== null && v !== '' && !EMAIL.test(String(v))) {
      problems.push('supportEmail must be an email address');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'websiteUrl')) {
    const v = body.websiteUrl;
    if (v !== null && v !== '') {
      let parsed = null;
      try {
        parsed = new URL(String(v));
      } catch {
        parsed = null;
      }
      // http and https ONLY. `javascript:` and `data:` are the reason this is
      // an allowlist: the value is rendered as a link on every public page, so
      // a scheme check here is the difference between a website link and
      // stored XSS that an admin pasted in themselves.
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        problems.push('websiteUrl must be an http or https URL');
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'defaultCurrency')) {
    const v = String(body.defaultCurrency || '').trim();
    if (!/^[A-Za-z]{3}$/.test(v)) problems.push('defaultCurrency must be a 3-letter code');
  }

  for (const [field, max] of Object.entries(MAX)) {
    if (field === 'organisationName') continue;
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const v = body[field];
    if (v !== null && String(v).length > max) {
      problems.push(`${field} must be at most ${max} characters`);
    }
  }

  return problems;
}

/** Normalise what validation accepted: trim, upper-case the currency, '' -> null. */
function normalise(body) {
  const out = {};
  for (const field of branding.WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    let v = body[field];
    if (typeof v === 'string') v = v.trim();
    if (v === '') v = null;
    if (field === 'defaultCurrency' && v) v = String(v).toUpperCase();
    if (field === 'organisationName' && v === null) continue; // NOT NULL in the schema
    out[field] = v;
  }
  return out;
}

// =============================================================================

router.get('/', async (req, res) => {
  try {
    const view = await branding.getPublic();
    if (!view) {
      // A fresh installation seeds this row (Phase 1a 5.7), so this is the
      // "should be unreachable" case. It answers 200 with defaults rather than
      // 404: the donor app cannot render without branding, and an unseeded
      // installation is an operator problem, not a reason to break the site.
      return res.json({
        organisationName: 'KindLedger',
        logoPath: null,
        logoMime: null,
        faviconPath: null,
        primaryColour: null,
        secondaryColour: null,
        supportEmail: null,
        websiteUrl: null,
        footerText: null,
        defaultCurrency: 'INR',
      });
    }
    return res.json(view);
  } catch (err) {
    return failed(res, 'Could not load branding', err, { tag: 'branding' });
  }
});

/** Mounted by routes/admin.js behind adminAuth. */
async function updateBranding(req, res) {
  try {
    const problems = validate(req.body || {});
    if (problems.length > 0) {
      return refuse(res, 400, problems.join('; '));
    }

    const data = normalise(req.body || {});
    if (Object.keys(data).length === 0) {
      return refuse(res, 400, 'No branding fields were supplied');
    }

    // `req.user.uuid` is set by adminAuth via repositories/users.resolveForAuth.
    const result = await branding.update(data, req.user ? req.user.uuid : null);

    return res.json({
      message:
        result.changed.length === 0
          ? 'No changes - every field already had that value'
          : `Updated: ${result.changed.join(', ')}`,
      changed: result.changed,
      branding: result.row,
    });
  } catch (err) {
    return failed(res, 'Could not update branding', err, { tag: 'branding' });
  }
}

module.exports = { router, updateBranding, validate, normalise, HEX_COLOUR, MAX };
