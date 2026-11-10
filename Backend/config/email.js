const nodemailer = require('nodemailer');

// HTML escape helper to prevent injection in email templates (BE-MED-05)
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * =============================================================================
 * The transport (CP1): Resend first, SMTP as the fallback, neither = refuse
 * =============================================================================
 * RESEND when RESEND_API_KEY is set. Called directly over HTTPS with Node's
 * fetch rather than through the SDK: one POST, and RESEND_BASE_URL lets the
 * tests point it at a local server. Resend sends only from a verified domain,
 * so EMAIL_FROM is required with it.
 *
 * SMTP otherwise, exactly as before: EMAIL_SERVICE=gmail, or SMTP_HOST/PORT/
 * SECURE, authenticated as EMAIL_USER/EMAIL_PASSWORD.
 *
 * NEITHER: THIS MODULE REFUSES TO LOAD, as config/jwt.js does without a
 * secret. Every login sends a code, so an app that cannot send mail cannot let
 * anyone in - and before CP1 it started anyway, defaulted to smtp.gmail.com
 * with no credentials, and failed one request at a time.
 *
 * Sends never throw. Every function below returns { success, messageId } or
 * { success: false, error }, which is what routes/auth.js was written against:
 * /login answers 500 when its code cannot be sent, and the SEC-08 paths are
 * fire-and-forget.
 * =============================================================================
 */
const DEFAULT_ORGANISATION_NAME = 'Your Organisation'; // the schema's default branding row
const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
const RESEND_TIMEOUT_MS = 10000;

function selectTransport(env) {
  if (env.RESEND_API_KEY) {
    if (!env.EMAIL_FROM) {
      throw new Error(
        'RESEND_API_KEY is set but EMAIL_FROM is not. Resend sends only from a verified domain: ' +
          'set EMAIL_FROM to an address on it, e.g. no-reply@your-domain.org.'
      );
    }
    return { kind: 'resend', from: env.EMAIL_FROM };
  }
  if (env.EMAIL_USER && env.EMAIL_PASSWORD) {
    return { kind: 'smtp', from: env.EMAIL_FROM || env.EMAIL_USER };
  }
  throw new Error(
    'No email transport is configured, and every login sends a code by email. Set RESEND_API_KEY and ' +
      'EMAIL_FROM (Resend), or EMAIL_USER and EMAIL_PASSWORD (SMTP; with EMAIL_SERVICE=gmail or SMTP_HOST).'
  );
}

const TRANSPORT = selectTransport(process.env);

function createSmtpTransporter() {
  // For Gmail service
  if (process.env.EMAIL_SERVICE === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD, // Use App Password for Gmail
      },
    });
  }

  // For generic SMTP (Brevo, SendGrid, Mailgun, etc.)
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
}

/**
 * CB2-9. The name every email uses, from branding - not the first NGO's name
 * hardcoded in seventeen places. Unreadable branding must not stop a login code, so it
 * falls back to the default row's name rather than failing the send.
 */
async function organisationName() {
  try {
    const branding = await require('../repositories/branding').getPublic();
    return (branding && branding.organisationName) || DEFAULT_ORGANISATION_NAME;
  } catch {
    return DEFAULT_ORGANISATION_NAME;
  }
}

/** The display name in From:, made safe for a header - no CR/LF, quotes or angle brackets. */
function senderName(name) {
  return String(name).replace(/[\r\n"<>]/g, '').trim() || DEFAULT_ORGANISATION_NAME;
}

async function sendViaResend({ to, subject, html }, name) {
  const base = (process.env.RESEND_BASE_URL || RESEND_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Resend rejects a request with no User-Agent (403).
      'User-Agent': 'KindLedger',
    },
    body: JSON.stringify({ from: `${name} <${TRANSPORT.from}>`, to: [to], subject, html }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  const text = await res.text();
  // Status and body verbatim: Resend's reason ("domain is not verified") is
  // the useful part, and its error body's fields are not pinned down here.
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${text.slice(0, 300)}`);
  let id;
  try {
    id = JSON.parse(text).id;
  } catch {
    id = undefined;
  }
  return id;
}

async function sendViaSmtp({ to, subject, html }, name) {
  const info = await createSmtpTransporter().sendMail({
    from: { name, address: TRANSPORT.from },
    to,
    subject,
    html,
  });
  return info.messageId;
}

/** Send one message on the configured transport. Never throws. */
async function deliver(message, organisation) {
  const name = senderName(organisation);
  try {
    const messageId =
      TRANSPORT.kind === 'resend' ? await sendViaResend(message, name) : await sendViaSmtp(message, name);
    return { success: true, messageId };
  } catch (error) {
    return { success: false, error: (error && error.message) || String(error) };
  }
}

// Send verification email
const sendVerificationEmail = async (email, code, userName = 'User') => {
  try {
    const org = await organisationName();

    const mailOptions = {
      to: email,
      subject: 'Password Reset Verification Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #05699e 0%, #044d73 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .code-box { background: white; border: 2px dashed #05699e; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
            .code { font-size: 32px; font-weight: bold; color: #05699e; letter-spacing: 5px; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hi ${escapeHtml(userName)},</p>
              <p>We received a request to reset your password for your ${escapeHtml(org)} account.</p>
              
              <div class="code-box">
                <p style="margin: 0; font-size: 14px; color: #666;">Your verification code is:</p>
                <div class="code">${code}</div>
              </div>
              
              <p>Enter this code on the password reset page to continue. This code will expire in <strong>15 minutes</strong>.</p>
              
              <div class="warning">
                <strong>⚠️ Security Notice:</strong><br>
                If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
              </div>
              
              <p>For security reasons, we recommend:</p>
              <ul>
                <li>Never share your verification code with anyone</li>
                <li>Use a strong, unique password</li>
                <li>Change your password regularly</li>
              </ul>
              
              <p>Best regards,<br>The ${escapeHtml(org)} Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply to this message.</p>
              <p>&copy; ${new Date().getFullYear()} ${escapeHtml(org)}. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    const result = await deliver(mailOptions, org);
    if (result.success) console.log('Email sent:', result.messageId);
    else console.error('Email sending error:', result.error);
    return result;
  } catch (error) {
    console.error('Email sending error:', error);
    return { success: false, error: error.message };
  }
};

/**
 * =============================================================================
 * "Someone tried to register with your address" (SEC-08, package 3.5a)
 * =============================================================================
 * THE SECOND TEMPLATE, AND THE ONLY REASON THIS PACKAGE EXISTS.
 *
 * `/signup` answered `400 "User already exists with this email"` for an address
 * that holds an account, which told an attacker the account exists. Closing it
 * means always answering "check your email" - and then ACTUALLY SENDING
 * SOMETHING, or the person whose address was used sees nothing while the
 * attacker learns nothing. Both halves are required: a uniform response with no
 * email behind it is a lie to the attacker and a silence to the victim.
 *
 * WHAT THIS EMAIL MUST NOT DO, and it is the whole design:
 *
 *   - IT CARRIES NO CODE AND NO LINK. Someone who does not control the address
 *     caused it to be sent. Anything actionable in it is a capability handed to
 *     them if the mailbox is ever compromised, and there is nothing this
 *     recipient needs to DO.
 *   - IT DOES NOT SAY WHO TRIED. We do not know, and the attempt carries no
 *     verified identity - only an address and a name the attacker typed.
 *   - IT DOES NOT ECHO THE ATTACKER'S NAME. `signup` takes a `name` field, and
 *     reflecting it would let an attacker send arbitrary text to any address in
 *     the system, in an email from us. THE ONLY ATTACKER-CONTROLLED VALUE HERE
 *     IS THE ADDRESS ITSELF, which the recipient already knows. The greeting
 *     uses the name on the EXISTING account.
 *
 * ADR-027, escape per sink: `escapeHtml` is applied to the one interpolated
 * value, as it is in every other template in this file.
 */
async function sendSignupAttemptNotice(email, existingUserName = 'there') {
  try {
    const org = await organisationName();

    const mailOptions = {
      to: email,
      // Deliberately NOT "Verify your email" - the subject line is visible on a
      // lock screen, and it should read as information rather than as an action.
      subject: 'A registration attempt used your email address',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #05699e 0%, #044d73 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .notice { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${escapeHtml(org)}</h1>
            </div>
            <div class="content">
              <p>Hi ${escapeHtml(existingUserName)},</p>
              <p>Someone just tried to create a new account using this email address. You already have an account with us, so no new account was created and nothing has changed.</p>

              <div class="notice">
                <strong>If this was you</strong><br>
                You already have an account - just sign in as usual. If you have forgotten your password, use the "Forgot password" link on the sign-in page.
              </div>

              <p><strong>If this was not you</strong>, you do not need to do anything. No account was created and your existing account has not been affected. Someone may simply have mistyped their own address.</p>

              <p>We will never ask you for your password or a verification code by email.</p>

              <p>Best regards,<br>The ${escapeHtml(org)} Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply to this message.</p>
              <p>&copy; ${new Date().getFullYear()} ${escapeHtml(org)}. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    const result = await deliver(mailOptions, org);
    if (!result.success) console.error('[email] signup-attempt notice failed:', result.error);
    return result;
  } catch (error) {
    console.error('[email] signup-attempt notice failed:', error && error.message);
    return { success: false, error: error && error.message };
  }
}

module.exports = {
  sendVerificationEmail,
  sendLoginOTP,
  sendSignupOTP,
  sendSignupAttemptNotice,
};

// Send Login OTP
async function sendLoginOTP(email, otp, userName = 'User') {
  try {
    const org = await organisationName();

    const mailOptions = {
      to: email,
      subject: 'Login Verification Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #05699e 0%, #044d73 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .code-box { background: white; border: 2px dashed #05699e; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
            .code { font-size: 32px; font-weight: bold; color: #05699e; letter-spacing: 5px; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Login Verification</h1>
            </div>
            <div class="content">
              <p>Hi ${escapeHtml(userName)},</p>
              <p>Someone is trying to log in to your ${escapeHtml(org)} account. To continue, please use this verification code:</p>
              
              <div class="code-box">
                <p style="margin: 0; font-size: 14px; color: #666;">Your OTP is:</p>
                <div class="code">${otp}</div>
              </div>
              
              <p>This code will expire in <strong>10 minutes</strong>.</p>
              
              <div class="warning">
                <strong>⚠️ Security Notice:</strong><br>
                If you didn't attempt to log in, please ignore this email and ensure your account password is secure.
              </div>
              
              <p>Best regards,<br>The ${escapeHtml(org)} Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply to this message.</p>
              <p>&copy; ${new Date().getFullYear()} ${escapeHtml(org)}. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    const result = await deliver(mailOptions, org);
    if (result.success) console.log('Login OTP email sent:', result.messageId);
    else console.error('Login OTP email error:', result.error);
    return result;
  } catch (error) {
    console.error('Login OTP email error:', error);
    return { success: false, error: error.message };
  }
}

// Send Signup OTP
async function sendSignupOTP(email, otp, userName = 'User') {
  try {
    const org = await organisationName();

    const mailOptions = {
      to: email,
      subject: 'Welcome! Verify Your Email',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #05699e 0%, #044d73 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .code-box { background: white; border: 2px dashed #05699e; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
            .code { font-size: 32px; font-weight: bold; color: #05699e; letter-spacing: 5px; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .welcome { background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to ${escapeHtml(org)}!</h1>
            </div>
            <div class="content">
              <p>Hi ${escapeHtml(userName)},</p>
              <p>Thank you for joining ${escapeHtml(org)}! To complete your registration, please verify your email address with this code:</p>
              
              <div class="code-box">
                <p style="margin: 0; font-size: 14px; color: #666;">Your verification code is:</p>
                <div class="code">${otp}</div>
              </div>
              
              <p>This code will expire in <strong>10 minutes</strong>.</p>
              
              <!--
                SIGNUP-01. THIS ENDPOINT IS UNAUTHENTICATED AND ANYONE CAN CAUSE
                THIS EMAIL TO BE SENT TO ANY ADDRESS. The recipient is therefore
                not necessarily the person who asked for it, and this template
                was written as though they always were - it thanked them for
                joining and asked for an action, with no way to tell that they
                had not joined anything.

                The warning is a MITIGATION, NOT THE FIX. The fix is that
                /signup/verify-otp now requires the password the signup was
                started with, so a recipient who did not start it cannot
                complete it however convincing the email looks.
              -->
              <div class="notice" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                <strong>Did not sign up?</strong><br>
                If you did not create an account with us, please ignore this email and <strong>do not enter this code</strong>. No account exists until the code is used, and we will never ask you for your password or a verification code by email.
              </div>

              <div class="welcome">
                <strong>✓ What's Next?</strong><br>
                Once verified, you'll be able to sign in, make donations and see your donation history.
              </div>
              
              <p>Best regards,<br>The ${escapeHtml(org)} Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply to this message.</p>
              <p>&copy; ${new Date().getFullYear()} ${escapeHtml(org)}. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    const result = await deliver(mailOptions, org);
    if (result.success) console.log('Signup OTP email sent:', result.messageId);
    else console.error('Signup OTP email error:', result.error);
    return result;
  } catch (error) {
    console.error('Signup OTP email error:', error);
    return { success: false, error: error.message };
  }
}

