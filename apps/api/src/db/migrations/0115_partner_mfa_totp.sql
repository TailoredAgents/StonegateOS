-- Encrypted, replay-safe TOTP enrollment and hashed single-use recovery codes.
-- This remains expand-only: legacy opaque authenticator references are valid,
-- while all newly enrolled TOTP methods use the encrypted columns below.

ALTER TABLE "partner_mfa_methods"
  ADD COLUMN "totp_secret_ciphertext" text,
  ADD COLUMN "totp_secret_key_version" integer,
  ADD COLUMN "last_totp_counter" integer,
  ADD CONSTRAINT "partner_mfa_methods_totp_secret_pair_check"
    CHECK (("totp_secret_ciphertext" IS NULL) = ("totp_secret_key_version" IS NULL)),
  ADD CONSTRAINT "partner_mfa_methods_totp_key_version_check"
    CHECK ("totp_secret_key_version" IS NULL OR "totp_secret_key_version" > 0),
  ADD CONSTRAINT "partner_mfa_methods_last_totp_counter_check"
    CHECK ("last_totp_counter" IS NULL OR "last_totp_counter" >= 0);

CREATE TABLE "partner_mfa_enrollment_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users"("id")
    ON DELETE CASCADE,
  "secret_ciphertext" text NOT NULL,
  "secret_key_version" integer NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_mfa_enrollment_key_version_check"
    CHECK ("secret_key_version" > 0),
  CONSTRAINT "partner_mfa_enrollment_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 8)
);

CREATE UNIQUE INDEX "partner_mfa_enrollment_active_user_key"
  ON "partner_mfa_enrollment_challenges" ("partner_user_id")
  WHERE "consumed_at" IS NULL;

CREATE INDEX "partner_mfa_enrollment_expiry_idx"
  ON "partner_mfa_enrollment_challenges" ("expires_at", "consumed_at");

CREATE TABLE "partner_mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "method_id" uuid NOT NULL REFERENCES "partner_mfa_methods"("id")
    ON DELETE CASCADE,
  "code_hash" varchar(64) NOT NULL,
  "key_version" integer NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_mfa_recovery_code_hash_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_mfa_recovery_key_version_check"
    CHECK ("key_version" > 0)
);

CREATE UNIQUE INDEX "partner_mfa_recovery_method_code_key"
  ON "partner_mfa_recovery_codes" ("method_id", "code_hash");

CREATE INDEX "partner_mfa_recovery_unused_idx"
  ON "partner_mfa_recovery_codes" ("method_id", "used_at");

COMMENT ON COLUMN "partner_mfa_methods"."totp_secret_ciphertext" IS
  'AES-256-GCM envelope for a confirmed TOTP secret. Plaintext is never persisted.';

COMMENT ON TABLE "partner_mfa_enrollment_challenges" IS
  'Short-lived encrypted TOTP bootstrap material awaiting proof of possession.';

COMMENT ON TABLE "partner_mfa_recovery_codes" IS
  'Keyed recovery-code digests; each row may be consumed exactly once.';
