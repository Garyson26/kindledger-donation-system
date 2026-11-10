/**
 * =============================================================================
 * Email for test suites: SMTP, pointed at a closed local port (CP1)
 * =============================================================================
 *   require('./support/email-off');   // before anything requires app.js
 *
 * config/email.js refuses to load with no transport configured, so every suite
 * that boots the app configures one - and this one cannot deliver anything.
 * Port 1 on loopback has no listener, so each send is refused at once and
 * returns { success: false }, which is the failed-send path routes/auth.js is
 * written for: /login answers 500, the SEC-08 paths carry on.
 *
 * Before CP1 these suites set nothing, and the module defaulted to
 * smtp.gmail.com with no credentials: every send went out to the internet and
 * failed there, and nodemailer held the sockets open until it gave up (the
 * reason signup-timing and password-timing exit explicitly).
 *
 * Resend is cleared so a developer's own RESEND_API_KEY can never make a test
 * run send real mail.
 * =============================================================================
 */

'use strict';

delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_SERVICE;
process.env.EMAIL_USER = 'kindledger-tests@invalid.test';
process.env.EMAIL_PASSWORD = 'test-only-not-a-password';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_SECURE = 'false';
