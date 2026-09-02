-- Team-only TOTP assurance for sensitive human mutations.
--
-- This migration is expand-only. Existing sessions remain AAL1, and the
-- existing short-lived break-glass session remains a distinct recovery path.

ALTER TABLE "team_members"
  ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL,
  ADD COLUMN "mfa_enrolled_at" timestamp with time zone;

ALTER TABLE "team_sessions"
  ADD COLUMN "assurance_level" text DEFAULT 'aal1' NOT NULL,
  ADD COLUMN "mfa_verified_at" timestamp with time zone,
  ADD CONSTRAINT "team_sessions_assurance_level_check"
    CHECK ("assurance_level" IN ('aal1', 'aal2')),
  ADD CONSTRAINT "team_sessions_assurance_state_check"
    CHECK (
      ("assurance_level" = 'aal1' AND "mfa_verified_at" IS NULL)
      OR (
        "assurance_level" = 'aal2'
        AND "mfa_verified_at" IS NOT NULL
        AND "auth_method" = 'team_session'
      )
    );

CREATE TABLE "team_mfa_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE CASCADE,
  "method_type" text NOT NULL,
  "label" text,
  "totp_secret_ciphertext" text NOT NULL,
  "totp_secret_key_version" integer NOT NULL,
  "last_totp_counter" integer,
  "enabled" boolean DEFAULT true NOT NULL,
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_mfa_methods_type_check"
    CHECK ("method_type" = 'totp'),
  CONSTRAINT "team_mfa_methods_enabled_state_check"
    CHECK (
      ("enabled" = true AND "disabled_at" IS NULL)
      OR ("enabled" = false AND "disabled_at" IS NOT NULL)
    ),
  CONSTRAINT "team_mfa_methods_key_version_check"
    CHECK ("totp_secret_key_version" > 0),
  CONSTRAINT "team_mfa_methods_last_counter_check"
    CHECK ("last_totp_counter" IS NULL OR "last_totp_counter" >= 0)
);

CREATE INDEX "team_mfa_methods_member_idx"
  ON "team_mfa_methods" ("team_member_id", "enabled");

CREATE UNIQUE INDEX "team_mfa_methods_active_totp_key"
  ON "team_mfa_methods" ("team_member_id")
  WHERE "method_type" = 'totp' AND "enabled" = true;

CREATE TABLE "team_mfa_enrollment_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE CASCADE,
  "secret_ciphertext" text NOT NULL,
  "secret_key_version" integer NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_mfa_enrollment_key_version_check"
    CHECK ("secret_key_version" > 0),
  CONSTRAINT "team_mfa_enrollment_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 8)
);

CREATE UNIQUE INDEX "team_mfa_enrollment_active_member_key"
  ON "team_mfa_enrollment_challenges" ("team_member_id")
  WHERE "consumed_at" IS NULL;

CREATE INDEX "team_mfa_enrollment_expiry_idx"
  ON "team_mfa_enrollment_challenges" ("expires_at", "consumed_at");

CREATE TABLE "team_mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "method_id" uuid NOT NULL REFERENCES "team_mfa_methods"("id")
    ON DELETE CASCADE,
  "code_hash" varchar(64) NOT NULL,
  "key_version" integer NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_mfa_recovery_code_hash_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_mfa_recovery_key_version_check"
    CHECK ("key_version" > 0)
);

CREATE UNIQUE INDEX "team_mfa_recovery_method_code_key"
  ON "team_mfa_recovery_codes" ("method_id", "code_hash");

CREATE INDEX "team_mfa_recovery_unused_idx"
  ON "team_mfa_recovery_codes" ("method_id", "used_at");

COMMENT ON TABLE "team_mfa_methods" IS
  'Team-only encrypted MFA authenticators; partner credentials are never stored here.';
COMMENT ON TABLE "team_mfa_enrollment_challenges" IS
  'Short-lived encrypted Team TOTP bootstrap material awaiting proof of possession.';
COMMENT ON TABLE "team_mfa_recovery_codes" IS
  'Keyed, single-use Team recovery-code digests.';
