-- Prisma initial migration - KindLedger Donation System
--
-- This file is a verbatim copy of db/schema.sql, which is the normative
-- artefact (SPEC-1A section 0). It is duplicated rather than referenced
-- because Prisma requires migration SQL to live inside the migration
-- directory. If you change db/schema.sql, author a NEW migration; never
-- edit this one after it has been applied anywhere.
--
-- Apply with: prisma migrate deploy   (never 'migrate dev' - see schema.prisma)

-- =============================================================================
-- KindLedger Donation System - normative schema
-- =============================================================================
-- Target: MySQL 8.4 LTS (requires >= 8.0.16 for enforced CHECK constraints)
--
-- THIS FILE IS THE SOURCE OF TRUTH. The Prisma schema in Backend/prisma is
-- generated to match this DDL, not the other way round. If the two disagree,
-- this file wins and the ORM layer is corrected.
--
-- Conventions (SPEC-1A section 4):
--   Engine        InnoDB
--   Charset       utf8mb4 / utf8mb4_0900_ai_ci  (email columns: _as_ci, see below)
--   Row format    DYNAMIC
--   Naming        snake_case, tables plural, columns singular
--   Timestamps    DATETIME(3), UTC always. Never TIMESTAMP - it has a 2038 range
--                 limit and performs implicit session-timezone conversion.
--   Booleans      BOOLEAN (TINYINT(1)), NOT NULL with an explicit default
--   Money         integer minor units (paise), BIGINT UNSIGNED, _minor suffix
--   Identifiers   internal BIGINT UNSIGNED PK, external CHAR(36) UUID
--
-- This file is idempotent: it may be applied repeatedly to the same database.
-- Table order below satisfies foreign key resolution; do not reorder.
--
-- CHECK CONSTRAINTS REQUIRE MySQL >= 8.0.16. Below that the syntax parses and
-- is then SILENTLY IGNORED - the money and singleton guarantees in this file
-- would evaporate without a single error being raised.
-- Backend/db/require-mysql-version.js refuses to initialise on an unsupported
-- server for exactly that reason.
--
-- CONSTRAINT INTERACTION TO KNOW ABOUT BEFORE THE NEXT SCHEMA CHANGE:
-- MySQL prohibits a CHECK constraint on a column used in a foreign key's
-- referential action, and equally prohibits such an action on a column that
-- carries a CHECK. Concretely, adding a CHECK to a column whose FK is
-- declared ON DELETE SET NULL or ON UPDATE CASCADE is rejected, because the
-- action would have to write a value the CHECK might refuse.
--
-- No column in this file carries both. Verified: the CHECK columns are
-- categories.donation_amount_minor, donations.quantity, donations.amount_minor
-- and branding_settings.{id, primary_colour, secondary_colour}; the foreign
-- key columns are category_descriptions.category_id,
-- donations.{user_id, category_id}, donation_payment_details.donation_id and
-- branding_settings.updated_by. The two sets are disjoint.
--
-- A later change that puts a CHECK on a foreign key column, or a referential
-- action on a checked column, will be rejected at DDL time. This note exists
-- so that failure reads as a known constraint rather than a baffling one.
-- =============================================================================

SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 1;


-- =============================================================================
-- users
-- =============================================================================
-- On the email collation: utf8mb4_0900_as_ci is accent-SENSITIVE and
-- case-INSENSITIVE.
--   Case-insensitive is deliberate - it makes the unique index itself prevent
--   the duplicate-account gap where Alice@x.com and alice@x.com are two
--   distinct users. The application must still lowercase on write, so this is
--   defence in depth rather than the only control.
--   Accent-sensitive matters because the schema default utf8mb4_0900_ai_ci
--   would treat jose@x.com and josé@x.com as the same address, which is wrong.
--
-- MIGRATION HAZARD: if the live data holds two accounts whose emails differ
-- only by case, this index rejects the second row. The ETL must pre-flight
-- for it and surface the collision for a human decision (SPEC-1A section 8.1).
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  uuid                   CHAR(36)         NOT NULL,
  legacy_id              CHAR(24)         NULL      COMMENT 'Original MongoDB ObjectId hex. NULL on fresh installs and post-cutover rows.',
  name                   VARCHAR(120)     NOT NULL,
  email                  VARCHAR(255)     COLLATE utf8mb4_0900_as_ci NOT NULL,
  password_hash          VARCHAR(255)     NOT NULL  COMMENT 'bcrypt output is 60 chars; width allows a later move to argon2.',
  role                   ENUM('user','admin') NOT NULL DEFAULT 'user',
  phone                  VARCHAR(32)      NULL,
  address                VARCHAR(512)     NULL,
  is_active              BOOLEAN          NOT NULL DEFAULT TRUE   COMMENT 'SEC-05. Enforced in Phase 3, not by this schema.',
  is_verified            BOOLEAN          NOT NULL DEFAULT FALSE,
  token_version          INT UNSIGNED     NOT NULL DEFAULT 0      COMMENT 'SEC-05 revocation. Increment on password change, reset and disable.',
  login_otp_hash         CHAR(64)         NULL      COMMENT 'SHA-256 hex. SEC-13 - never store the plaintext OTP.',
  login_otp_expires_at   DATETIME(3)      NULL,
  login_otp_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  reset_code_hash        CHAR(64)         NULL      COMMENT 'SHA-256 hex. SEC-13.',
  reset_code_expires_at  DATETIME(3)      NULL,
  reset_code_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0      COMMENT 'SEC-02. The MongoDB equivalent exists and is never read; Phase 3 must read it.',
  created_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_uuid      (uuid),
  UNIQUE KEY uq_users_email     (email),
  UNIQUE KEY uq_users_legacy_id (legacy_id),
  KEY ix_users_created_at_role  (created_at, role) COMMENT 'Retention purge.'
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- pending_signups
-- =============================================================================
-- MySQL has no TTL index. MongoDB's 24-hour self-deletion on this collection
-- has no database-level equivalent, so expires_at plus its index replaces it
-- and a scheduled job must delete expired rows.
--
-- Do NOT use the MySQL event scheduler for that sweep: it is disabled by
-- default on many managed instances and is one more thing a self-hoster has to
-- know about. The sweep belongs in the application cron, which is possible now
-- that the API is no longer serverless.
--
-- Rows in this table are NOT migrated - they are abandoned or in-flight
-- registrations with a 24-hour lifetime, and the cutover freeze handles them.
-- =============================================================================
CREATE TABLE IF NOT EXISTS pending_signups (
  id                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  uuid                   CHAR(36)         NOT NULL,
  name                   VARCHAR(120)     NOT NULL,
  email                  VARCHAR(255)     COLLATE utf8mb4_0900_as_ci NOT NULL,
  password_hash          VARCHAR(255)     NOT NULL,
  role                   ENUM('user','admin') NOT NULL DEFAULT 'user',
  signup_otp_hash        CHAR(64)         NOT NULL  COMMENT 'SHA-256 hex. SEC-13.',
  signup_otp_expires_at  DATETIME(3)      NOT NULL,
  signup_otp_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'New column. Parity with the login OTP cap, which is enforced while the reset path is not.',
  expires_at             DATETIME(3)      NOT NULL  COMMENT 'Replaces the MongoDB TTL index. Swept by the application cron.',
  created_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pending_signups_uuid  (uuid),
  UNIQUE KEY uq_pending_signups_email (email),
  KEY ix_pending_signups_expires_at   (expires_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- categories
-- =============================================================================
-- Field rename: the Mongoose field is `sortDescription`. Verified against
-- source - its form label is "Short Description", its placeholder is "Brief
-- one-line description", and it is rendered as a paragraph under the category
-- name. It is never used in a sort. The SQL column is short_description and
-- the ETL maps across.
--
-- Soft delete is a BEHAVIOUR CHANGE. DELETE /api/categories/:id currently
-- hard-deletes. With donations.category_id carrying ON DELETE RESTRICT,
-- deleting a category that has ever received a donation would now fail at the
-- database. Financial records must not lose the category that priced them, so
-- the delete endpoint becomes a soft delete in Phase 3 and every read path
-- filters `deleted_at IS NULL`. See docs/decisions.md ADR-004.
-- =============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  uuid                   CHAR(36)         NOT NULL,
  legacy_id              CHAR(24)         NULL,
  name                   VARCHAR(160)     NOT NULL,
  short_description      VARCHAR(500)     NOT NULL  COMMENT 'Source field is Mongoose `sortDescription` - a typo for "short".',
  donation_amount_minor  BIGINT UNSIGNED  NOT NULL  COMMENT 'The authoritative price, in minor units.',
  display_order          INT              NOT NULL DEFAULT 0,
  deleted_at             DATETIME(3)      NULL      COMMENT 'Soft delete. Read paths must filter deleted_at IS NULL.',
  created_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_uuid      (uuid),
  UNIQUE KEY uq_categories_name      (name),
  UNIQUE KEY uq_categories_legacy_id (legacy_id),
  KEY ix_categories_deleted_display  (deleted_at, display_order),
  CONSTRAINT ck_categories_amount_positive CHECK (donation_amount_minor > 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- category_descriptions
-- =============================================================================
-- The MongoDB `descriptions` String array, normalised.
--
-- Verified against source: descriptions ARE individually addressed in the
-- admin form (add, remove and edit by index in AddCategoryForm.jsx), and the
-- category list already has a drag-to-reorder pattern for display_order. The
-- condition SPEC-1A section 5.4 set for collapsing this into a JSON column is
-- therefore not met, and the child table stands. See docs/decisions.md ADR-005.
-- =============================================================================
CREATE TABLE IF NOT EXISTS category_descriptions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id  BIGINT UNSIGNED NOT NULL,
  position     INT UNSIGNED    NOT NULL,
  text         VARCHAR(1000)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_category_descriptions_position (category_id, position),
  CONSTRAINT fk_category_descriptions_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- donations
-- =============================================================================
-- ENUM columns close three findings at the schema layer. BUG-02 (mixed
-- casing), BUG-03 (dashboard counter always zero) and SEC-16 (PUT
-- /donations/:id writes arbitrary strings) all exist because Mongoose's enum
-- was not enforced on findByIdAndUpdate. MySQL enforces it unconditionally.
--
-- HOW IT ENFORCES, PRECISELY - verified against mysql:8.4.11:
--   * An out-of-set value ('banana') is REJECTED: ERROR 1265, data truncated.
--   * A case variant ('approved') is ACCEPTED and CANONICALISED to
--     'Approved'. ENUM assignment is subject to the column's collation, and
--     utf8mb4_0900_ai_ci is case-insensitive. HEX(status) confirms the stored
--     bytes are the canonical member.
--
-- Canonicalisation is the better outcome: a legacy caller sending lowercase
-- still succeeds, and the stored value is always the canonical form, so
-- BUG-03's `status = 'Approved'` count can no longer miss rows. Were this
-- column ever given a _bin or _cs collation, those writes would start failing
-- instead.
--
-- CONSEQUENCE FOR THE PHASE 4 ETL, which corrects SPEC-1A section 8.2: the
-- ENUM will NOT fail the load on mixed-case status values, it will silently
-- normalise them. The corruption is therefore repaired rather than surfaced.
-- If its scale is to be on record, the ETL must COUNT mixed-case values
-- before insert and report them explicitly - nothing downstream will.
--
-- transaction_ref replaces `TXN${Date.now()}${Math.floor(Math.random()*1000)}`,
-- a millisecond timestamp plus three digits that is guessable within a narrow
-- window and is the mechanism behind SEC-06. Migrated rows keep their original
-- TXN... value in legacy_id and receive a fresh UUID here.
--
-- ON DELETE SET NULL on user_id is a BEHAVIOUR CHANGE. DELETE
-- /admin/users/:id currently hard-deletes a user and leaves the donation
-- pointing at a missing document. Under a real foreign key the donation
-- survives as a guest donation with donor_name and donor_email preserved on
-- the row. A financial record is not deleted because an account was.
-- See docs/decisions.md ADR-003.
--
-- Deliberately NO CHECK asserting
--   amount_minor = base_amount_minor + extra_amount_minor
-- Historic rows migrated from MongoDB may not satisfy it, because baseAmount
-- and extraAmount were written independently of amount. Enforce the
-- relationship in the pricing code and reconcile in the ETL harness instead.
-- =============================================================================
CREATE TABLE IF NOT EXISTS donations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                CHAR(36)        NOT NULL,
  legacy_id           CHAR(24)        NULL,
  transaction_ref     CHAR(36)        NOT NULL  COMMENT 'crypto.randomUUID(). Replaces the guessable TXN<epoch><rand> scheme.',
  donor_name          VARCHAR(120)    NOT NULL,
  donor_email         VARCHAR(255)    NOT NULL  COMMENT 'Not unique - guests recur.',
  donor_phone         VARCHAR(32)     NULL,
  user_id             BIGINT UNSIGNED NULL      COMMENT 'NULL for guest donations.',
  category_id         BIGINT UNSIGNED NOT NULL,
  item                VARCHAR(200)    NULL,
  quantity            INT UNSIGNED    NOT NULL DEFAULT 1,
  base_amount_minor   BIGINT UNSIGNED NOT NULL,
  extra_amount_minor  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  amount_minor        BIGINT UNSIGNED NOT NULL,
  currency            CHAR(3)         NOT NULL DEFAULT 'INR' COMMENT 'Recorded, not supported. Single currency per installation this phase.',
  status              ENUM('Pending','Approved','Rejected')          NOT NULL DEFAULT 'Pending',
  payment_status      ENUM('Pending','Paid','Failed','Cancelled')    NOT NULL DEFAULT 'Pending',
  failure_reason      VARCHAR(500)    NULL      COMMENT 'Verbatim PayU text.',
  error_message       VARCHAR(1000)   NULL      COMMENT 'Verbatim PayU text.',
  donated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Mongo `date`. The field all reports filter on.',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_donations_uuid            (uuid),
  UNIQUE KEY uq_donations_transaction_ref (transaction_ref),
  UNIQUE KEY uq_donations_legacy_id       (legacy_id),
  KEY ix_donations_donated_at             (donated_at),
  KEY ix_donations_user_id                (user_id),
  KEY ix_donations_category_id            (category_id),
  KEY ix_donations_paystatus_donated_at   (payment_status, donated_at),
  KEY ix_donations_created_at             (created_at),
  CONSTRAINT fk_donations_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT,
  CONSTRAINT fk_donations_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_donations_quantity_min CHECK (quantity >= 1),
  CONSTRAINT ck_donations_amount_positive CHECK (amount_minor > 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- donation_payment_details
-- =============================================================================
-- The `paymentDetails` subdocument, extracted to a 1:1 table.
--
-- THE UNIQUE INDEX ON mihpayid IS A DATA-INTEGRITY CONTROL AND A SECONDARY
-- DEFENCE. It is NOT the replay defence.
--
-- SPEC-1A section 5.6 originally claimed it was, and that was wrong.
-- PayU's documented reverse hash covers only: status, udf1-5, email,
-- firstname, productinfo, amount, txnid and key. mihpayid is NOT in it, and
-- the callback arrives through the donor's browser, so mihpayid is unsigned
-- and attacker-mutable. An attacker can therefore:
--   * vary mihpayid freely to defeat uniqueness, so the index stops no replay;
--   * or collide it with an existing value to make a legitimate payment fail
--     to record - turning the index into a denial-of-recording tool.
--
-- THE LOAD-BEARING REPLAY CONTROL IS THE DONATION STATE TRANSITION, keyed on
-- SIGNED fields only: txnid and udf4 identify the donation, and the handler
-- refuses to re-process one whose paymentStatus is already 'Paid'. The
-- Package A hotfix implements that. See docs/decisions.md ADR-026.
--
-- What this index still earns its place for: it keeps the same gateway payment
-- identifier from being recorded against two different donations, which is a
-- genuine integrity property and catches double-processing by our own code or
-- by a retrying webhook. InnoDB permits multiple NULLs in a unique index,
-- which is exactly the behaviour wanted: unpaid donations have no mihpayid.
--
-- Phase 3 should still treat the resulting duplicate-key error as an
-- idempotent no-op rather than a failure - but must not rely on it for
-- security, and must not build any security decision on an unsigned field.
--
-- gateway_status holds PayU's raw status string and is deliberately NOT an
-- ENUM - it is a third party's vocabulary and must be recorded verbatim for
-- dispute handling. The internal interpretation lives in
-- donations.payment_status.
-- =============================================================================
CREATE TABLE IF NOT EXISTS donation_payment_details (
  donation_id     BIGINT UNSIGNED NOT NULL,
  mihpayid        VARCHAR(64)     NULL      COMMENT 'Data-integrity control, NOT the replay defence - unsigned by PayU. See ADR-026.',
  amount_minor    BIGINT UNSIGNED NULL,
  mode            VARCHAR(32)     NULL,
  bank_ref_num    VARCHAR(64)     NULL,
  gateway_status  VARCHAR(64)     NULL      COMMENT 'PayU raw status. Verbatim, deliberately not an ENUM.',
  error_message   VARCHAR(1000)   NULL,
  paid_at         DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (donation_id),
  UNIQUE KEY uq_donation_payment_details_mihpayid (mihpayid),
  CONSTRAINT fk_donation_payment_details_donation
    FOREIGN KEY (donation_id) REFERENCES donations (id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- =============================================================================
-- branding_settings
-- =============================================================================
-- Whitelabel configuration. Single-tenant: exactly one row per installation,
-- enforced by CHECK (id = 1) rather than by convention.
--
-- THE KINDLEDGER ATTRIBUTION IS NOT IN THIS TABLE AND MUST NEVER BE. The
-- "Powered by KindLedger Donation System" footer is a hardcoded frontend
-- component with no configuration surface. Putting it here would make removing
-- it a supported admin action, which defeats the purpose. Whether it is
-- legally removable by a forker is a licensing question that is still open
-- (SPEC-1A DEF-01); this schema does not pre-empt it.
--
-- NO SVG. logo_mime is constrained by the application to image/png,
-- image/jpeg and image/webp. SVG is a script-execution vector and a stored XSS
-- route, and an NGO admin uploading a logo their designer sent them is
-- precisely how one arrives. Phase 5 re-encodes uploads server-side rather
-- than trusting the declared type. This schema records the decision; it does
-- not enforce it.
-- =============================================================================
CREATE TABLE IF NOT EXISTS branding_settings (
  id                 TINYINT UNSIGNED NOT NULL COMMENT 'Singleton. CHECK (id = 1) makes a second row impossible.',
  organisation_name  VARCHAR(160)     NOT NULL,
  logo_path          VARCHAR(512)     NULL      COMMENT 'Relative path within the uploads volume.',
  logo_mime          VARCHAR(64)      NULL      COMMENT 'Raster only - png, jpeg, webp. Enforced by the application, not here.',
  favicon_path       VARCHAR(512)     NULL,
  primary_colour     CHAR(7)          NULL,
  secondary_colour   CHAR(7)          NULL,
  support_email      VARCHAR(255)     NULL,
  website_url        VARCHAR(512)     NULL,
  footer_text        VARCHAR(500)     NULL      COMMENT "The NGO's own footer line. Not the KindLedger attribution.",
  default_currency   CHAR(3)          NOT NULL DEFAULT 'INR',
  updated_by         BIGINT UNSIGNED  NULL,
  updated_at         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_branding_settings_updated_by (updated_by),
  CONSTRAINT fk_branding_settings_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT,
  CONSTRAINT ck_branding_settings_singleton CHECK (id = 1),
  CONSTRAINT ck_branding_settings_primary_colour
    CHECK (primary_colour IS NULL OR REGEXP_LIKE(primary_colour, '^#[0-9A-Fa-f]{6}$')),
  CONSTRAINT ck_branding_settings_secondary_colour
    CHECK (secondary_colour IS NULL OR REGEXP_LIKE(secondary_colour, '^#[0-9A-Fa-f]{6}$'))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;


-- -----------------------------------------------------------------------------
-- Singleton invariant.
-- The application must never have to handle a missing settings row, so seed a
-- placeholder here rather than in the seed script. Idempotent: re-applying this
-- file leaves an existing row untouched.
-- The For Ocean Foundation migration overwrites these values at cutover.
-- -----------------------------------------------------------------------------
INSERT INTO branding_settings (id, organisation_name, default_currency)
VALUES (1, 'Your Organisation', 'INR')
ON DUPLICATE KEY UPDATE id = id;


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
