/**
 * =============================================================================
 * Email transport - CP1: Resend first, SMTP as the fallback, neither = refuse
 * =============================================================================
 *   npm run test:email
 *
 * No database and no mail server. Resend is a local HTTP server reached through
 * RESEND_BASE_URL, which is the only thing that variable is for. The SMTP
 * fallback is pointed at a closed local port, as every app-booting suite now is
 * (test/support/email-off.js). The organisation name comes from the branding
 * repository, replaced through require.cache so a test can choose it; nothing
 * else is faked. Assertions are on what config/email.js sends and returns -
 * its contract at the boundary.
 * =============================================================================
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');
const EMAIL_MODULE = path.join(BACKEND, 'config', 'email.js');
const BRANDING_MODULE = path.join(BACKEND, 'repositories', 'branding.js');

const MAIL_VARS = [
  'RESEND_API_KEY', 'RESEND_BASE_URL', 'EMAIL_FROM',
  'EMAIL_SERVICE', 'EMAIL_USER', 'EMAIL_PASSWORD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
];

let saved;
let fakeResend;
let received;
let reply;

/** A fresh config/email.js under `env`, with the organisation name chosen. */
function loadEmail(env, { organisationName = 'Test Org & Co', brandingFails = false } = {}) {
  for (const k of MAIL_VARS) delete process.env[k];
  Object.assign(process.env, env);
  require.cache[BRANDING_MODULE] = {
    id: BRANDING_MODULE,
    filename: BRANDING_MODULE,
    loaded: true,
    exports: {
      getPublic: async () => {
        if (brandingFails) throw new Error('database unreachable');
        return { organisationName };
      },
    },
  };
  delete require.cache[EMAIL_MODULE];
  return require(EMAIL_MODULE);
}

/** Load config/email.js in a CHILD process with only `env` for mail; returns { code, stderr }. */
function loadInChild(env) {
  const childEnv = { ...process.env };
  for (const k of MAIL_VARS) delete childEnv[k];
  Object.assign(childEnv, env);
  try {
    execFileSync(process.execPath, ['-e', "require('./config/email')"], {
      cwd: BACKEND, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status, stderr: String(err.stderr) };
  }
}

const resendEnv = () => ({
  RESEND_API_KEY: 're_test_key',
  RESEND_BASE_URL: `http://127.0.0.1:${fakeResend.address().port}`,
  EMAIL_FROM: 'no-reply@example.org',
});

beforeEach(async () => {
  saved = Object.fromEntries(MAIL_VARS.map((k) => [k, process.env[k]]));
  received = [];
  reply = { status: 200, body: { id: 'resend-id-1' } };
  fakeResend = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => fakeResend.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  await new Promise((r) => fakeResend.close(r));
  for (const k of MAIL_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete require.cache[EMAIL_MODULE];
  delete require.cache[BRANDING_MODULE];
});

// -----------------------------------------------------------------------------
// Selection, and the refusal
// -----------------------------------------------------------------------------

test('CP1: with NO transport configured, config/email.js refuses to load - and says what to set', () => {
  const { code, stderr } = loadInChild({});
  assert.notEqual(code, 0, 'loading must fail: an app that cannot send a login code cannot let anyone log in');
  assert.match(stderr, /RESEND_API_KEY/);
  assert.match(stderr, /EMAIL_USER/);
});

test('CP1: RESEND_API_KEY without EMAIL_FROM refuses to load - Resend sends only from a verified domain', () => {
  const { code, stderr } = loadInChild({ RESEND_API_KEY: 're_x' });
  assert.notEqual(code, 0);
  assert.match(stderr, /EMAIL_FROM/);
});

test('CP1: SMTP alone loads (the fallback), and so does Resend alone', () => {
  assert.equal(loadInChild({ EMAIL_USER: 'a@example.org', EMAIL_PASSWORD: 'x' }).code, 0);
  assert.equal(loadInChild({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'no-reply@example.org' }).code, 0);
});

// -----------------------------------------------------------------------------
// Resend: what is sent
// -----------------------------------------------------------------------------

test('CP1: a login code goes to Resend - POST /emails, the key, a User-Agent, JSON, the branded sender', async () => {
  const email = loadEmail(resendEnv());
  const result = await email.sendLoginOTP('donor@example.org', '123456', 'Asha');

  assert.deepEqual(result, { success: true, messageId: 'resend-id-1' });
  assert.equal(received.length, 1);
  const [req] = received;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/emails');
  assert.equal(req.headers.authorization, 'Bearer re_test_key');
  assert.match(req.headers['content-type'], /^application\/json/);
  assert.ok(req.headers['user-agent'], 'Resend rejects a request with no User-Agent (403)');
  assert.equal(req.body.from, 'Test Org & Co <no-reply@example.org>');
  assert.deepEqual(req.body.to, ['donor@example.org']);
  assert.equal(req.body.subject, 'Login Verification Code');
  assert.match(req.body.html, /123456/);
  assert.match(req.body.html, /Test Org &amp; Co/, 'the name is HTML-escaped in the body');
});

test('CP1: Resend is used when BOTH are configured - SMTP is the fallback, not a peer', async () => {
  const email = loadEmail({ ...resendEnv(), EMAIL_USER: 'a@example.org', EMAIL_PASSWORD: 'x', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  const result = await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(result.success, true);
  assert.equal(received.length, 1);
});

test('CP1: a Resend refusal is RETURNED as { success: false } with the status - never thrown', async () => {
  reply = { status: 403, body: { name: 'validation_error', message: 'The example.org domain is not verified.' } };
  const email = loadEmail(resendEnv());
  const result = await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(result.success, false);
  assert.match(result.error, /403/);
  assert.match(result.error, /not verified/, "Resend's own reason reaches the log");
});

test('CP1: Resend unreachable is RETURNED as { success: false }, not thrown', async () => {
  const env = { ...resendEnv(), RESEND_BASE_URL: 'http://127.0.0.1:1' };
  const email = loadEmail(env);
  const result = await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(result.success, false);
});

// -----------------------------------------------------------------------------
// Whitelabel: CB2-9
// -----------------------------------------------------------------------------

test('CB2-9: all four emails carry the organisation name from branding, and none says "For Ocean Foundation"', async () => {
  const email = loadEmail(resendEnv(), { organisationName: 'Harbour Trust' });
  await email.sendVerificationEmail('a@example.org', '111111', 'A');
  await email.sendLoginOTP('a@example.org', '222222', 'A');
  await email.sendSignupOTP('a@example.org', '333333', 'A');
  await email.sendSignupAttemptNotice('a@example.org', 'A');

  assert.equal(received.length, 4);
  for (const { body } of received) {
    assert.equal(body.from, 'Harbour Trust <no-reply@example.org>', body.subject);
    assert.match(body.html, /Harbour Trust/, body.subject);
    assert.doesNotMatch(body.html, /Ocean/i, `${body.subject}: no For Ocean Foundation text, and no ocean copy`);
  }
});

test('CB2-9: the name cannot inject a header - CR, LF, quotes and angle brackets are removed from the sender', async () => {
  const email = loadEmail(resendEnv(), { organisationName: 'Evil"\r\nBcc: x@evil.test <y>' });
  await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(received[0].body.from, 'EvilBcc: x@evil.test y <no-reply@example.org>');
});

test('CB2-9: with branding unreadable the email still goes, under the default name', async () => {
  const email = loadEmail(resendEnv(), { brandingFails: true });
  const result = await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(result.success, true);
  assert.equal(received[0].body.from, 'Your Organisation <no-reply@example.org>');
});

// -----------------------------------------------------------------------------
// SMTP fallback
// -----------------------------------------------------------------------------

test('CP1: SMTP fallback - a closed port fails FAST as { success: false }, the shape every suite now relies on', async () => {
  const email = loadEmail({ EMAIL_USER: 'a@example.org', EMAIL_PASSWORD: 'x', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  const started = Date.now();
  const result = await email.sendLoginOTP('donor@example.org', '123456');
  assert.equal(result.success, false);
  assert.ok(Date.now() - started < 10000, 'a refused connection must not hang');
  assert.equal(received.length, 0, 'and Resend is not involved');
});
