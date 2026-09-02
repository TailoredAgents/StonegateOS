-- Verification-first Partner Portal identity and credential foundation.
-- Existing V1 rows remain readable while all new credentials are isolated by
-- purpose and all new applications remain tenantless until staff approval.

ALTER TABLE "partner_users"
  ADD COLUMN "normalized_email" text,
  ADD COLUMN "identity_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN "email_verified_at" timestamptz,
  ADD COLUMN "password_hash_version" integer NOT NULL DEFAULT 1;

WITH "email_collisions" AS (
  SELECT lower(btrim("email")) AS "normalized_email"
  FROM "partner_users"
  GROUP BY lower(btrim("email"))
  HAVING count(*) > 1
)
UPDATE "partner_users" AS "identity"
SET
  "normalized_email" = CASE
    WHEN "collision"."normalized_email" IS NULL
      THEN lower(btrim("identity"."email"))
    ELSE NULL
  END,
  "identity_status" = CASE
    WHEN "collision"."normalized_email" IS NOT NULL THEN 'quarantined'
    WHEN "identity"."active" = false THEN 'disabled'
    ELSE 'active'
  END
FROM (
  SELECT "identity_source"."id", "collisions"."normalized_email"
  FROM "partner_users" AS "identity_source"
  LEFT JOIN "email_collisions" AS "collisions"
    ON "collisions"."normalized_email" = lower(btrim("identity_source"."email"))
) AS "collision"
WHERE "collision"."id" = "identity"."id";

CREATE UNIQUE INDEX "partner_users_normalized_email_key"
  ON "partner_users" ("normalized_email")
  WHERE "normalized_email" IS NOT NULL;

ALTER TABLE "partner_users"
  ADD CONSTRAINT "partner_users_normalized_email_check"
    CHECK (
      "normalized_email" IS NULL
      OR (
        "normalized_email" = lower(btrim("normalized_email"))
        AND length("normalized_email") BETWEEN 3 AND 254
        AND "normalized_email" !~ '[[:space:]]'
        AND "normalized_email" LIKE '%@%'
      )
    ),
  ADD CONSTRAINT "partner_users_identity_status_check"
    CHECK ("identity_status" IN ('pending_activation', 'active', 'suspended', 'disabled', 'quarantined')),
  ADD CONSTRAINT "partner_users_password_hash_version_check"
    CHECK ("password_hash_version" > 0);

CREATE TABLE "partner_auth_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purpose" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "normalized_email" text NOT NULL,
  "token_hash" varchar(64),
  "generation" integer NOT NULL DEFAULT 1,
  "partner_user_id" uuid REFERENCES "partner_users"("id") ON DELETE CASCADE,
  "partner_account_id" uuid REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE CASCADE,
  "application_id" uuid,
  "security_version_snapshot" integer,
  "requested_ip" text,
  "requested_user_agent" text,
  "consumed_ip" text,
  "consumed_user_agent" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "revoked_at" timestamptz,
  "expired_at" timestamptz,
  "delivery_status" text NOT NULL DEFAULT 'queued',
  "delivery_outbox_event_id" uuid REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "delivery_attempt_id" uuid,
  "delivery_provider" text,
  "delivery_provider_message_id" text,
  "delivery_detail" text,
  "dispatch_started_at" timestamptz,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_auth_challenges_purpose_check"
    CHECK ("purpose" IN ('email_verification', 'account_activation', 'password_reset')),
  CONSTRAINT "partner_auth_challenges_status_check"
    CHECK ("status" IN ('pending', 'consumed', 'revoked', 'expired')),
  CONSTRAINT "partner_auth_challenges_email_check"
    CHECK (
      "normalized_email" = lower(btrim("normalized_email"))
      AND length("normalized_email") BETWEEN 3 AND 254
      AND "normalized_email" !~ '[[:space:]]'
      AND "normalized_email" LIKE '%@%'
    ),
  CONSTRAINT "partner_auth_challenges_token_hash_check"
    CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_auth_challenges_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "partner_auth_challenges_security_version_check"
    CHECK ("security_version_snapshot" IS NULL OR "security_version_snapshot" > 0),
  CONSTRAINT "partner_auth_challenges_delivery_status_check"
    CHECK ("delivery_status" IN ('queued', 'dispatching', 'accepted', 'failed', 'reconciliation_required')),
  CONSTRAINT "partner_auth_challenges_subject_check"
    CHECK (
      (
        "purpose" = 'email_verification'
        AND "partner_user_id" IS NULL
        AND "partner_account_id" IS NULL
        AND "partner_membership_id" IS NULL
        AND "security_version_snapshot" IS NULL
      ) OR (
        "purpose" = 'account_activation'
        AND "partner_user_id" IS NOT NULL
        AND "partner_account_id" IS NOT NULL
        AND "partner_membership_id" IS NOT NULL
        AND "application_id" IS NOT NULL
        AND "security_version_snapshot" IS NOT NULL
      ) OR (
        "purpose" = 'password_reset'
        AND "partner_user_id" IS NOT NULL
        AND "partner_account_id" IS NULL
        AND "partner_membership_id" IS NULL
        AND "application_id" IS NULL
        AND "security_version_snapshot" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_auth_challenges_account_membership_pair_check"
    CHECK (("partner_account_id" IS NULL) = ("partner_membership_id" IS NULL)),
  CONSTRAINT "partner_auth_challenges_lifecycle_check"
    CHECK (
      (
        "status" = 'pending'
        AND "token_hash" IS NOT NULL
        AND "consumed_at" IS NULL
        AND "revoked_at" IS NULL
        AND "expired_at" IS NULL
      ) OR (
        "status" = 'consumed'
        AND "token_hash" IS NULL
        AND "consumed_at" IS NOT NULL
        AND "revoked_at" IS NULL
        AND "expired_at" IS NULL
      ) OR (
        "status" = 'revoked'
        AND "token_hash" IS NULL
        AND "consumed_at" IS NULL
        AND "revoked_at" IS NOT NULL
        AND "expired_at" IS NULL
      ) OR (
        "status" = 'expired'
        AND "token_hash" IS NULL
        AND "consumed_at" IS NULL
        AND "revoked_at" IS NULL
        AND "expired_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "partner_auth_challenges_token_hash_key"
  ON "partner_auth_challenges" ("token_hash")
  WHERE "token_hash" IS NOT NULL;
CREATE UNIQUE INDEX "partner_auth_challenges_active_purpose_email_key"
  ON "partner_auth_challenges" ("purpose", "normalized_email")
  WHERE "status" = 'pending';
CREATE INDEX "partner_auth_challenges_subject_idx"
  ON "partner_auth_challenges" ("partner_user_id", "purpose", "status");
CREATE INDEX "partner_auth_challenges_expiry_idx"
  ON "partner_auth_challenges" ("status", "expires_at");
ALTER TABLE "partner_auth_challenges"
  ADD CONSTRAINT "partner_auth_challenges_membership_account_fk"
  FOREIGN KEY ("partner_membership_id", "partner_account_id")
  REFERENCES "partner_account_memberships"("id", "partner_account_id")
  ON DELETE CASCADE;

CREATE TABLE "partner_applicant_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "verification_challenge_id" uuid NOT NULL REFERENCES "partner_auth_challenges"("id") ON DELETE RESTRICT,
  "normalized_email" text NOT NULL,
  "session_hash" varchar(64) NOT NULL,
  "application_id" uuid,
  "draft_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "draft_version" integer NOT NULL DEFAULT 1,
  "ip" text,
  "user_agent" text,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_applicant_sessions_email_check"
    CHECK (
      "normalized_email" = lower(btrim("normalized_email"))
      AND length("normalized_email") BETWEEN 3 AND 254
      AND "normalized_email" !~ '[[:space:]]'
      AND "normalized_email" LIKE '%@%'
    ),
  CONSTRAINT "partner_applicant_sessions_hash_check"
    CHECK ("session_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_applicant_sessions_draft_version_check"
    CHECK ("draft_version" > 0)
);

CREATE UNIQUE INDEX "partner_applicant_sessions_hash_key"
  ON "partner_applicant_sessions" ("session_hash");
CREATE UNIQUE INDEX "partner_applicant_sessions_challenge_key"
  ON "partner_applicant_sessions" ("verification_challenge_id");
CREATE INDEX "partner_applicant_sessions_email_active_idx"
  ON "partner_applicant_sessions" ("normalized_email", "revoked_at", "expires_at");

ALTER TABLE "partner_access_applications"
  ADD COLUMN "flow_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "email_verification_challenge_id" uuid REFERENCES "partner_auth_challenges"("id") ON DELETE RESTRICT,
  ADD COLUMN "applicant_session_id" uuid REFERENCES "partner_applicant_sessions"("id") ON DELETE RESTRICT,
  ADD COLUMN "company_resolution_choice" text,
  ADD COLUMN "company_candidate_id" varchar(64),
  ADD COLUMN "requested_partner_account_id" uuid REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  ADD COLUMN "applicant_response" text;

ALTER TABLE "partner_auth_challenges"
  ADD CONSTRAINT "partner_auth_challenges_application_fk"
  FOREIGN KEY ("application_id") REFERENCES "partner_access_applications"("id") ON DELETE CASCADE;
ALTER TABLE "partner_applicant_sessions"
  ADD CONSTRAINT "partner_applicant_sessions_application_fk"
  FOREIGN KEY ("application_id") REFERENCES "partner_access_applications"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "partner_access_applications_applicant_session_key"
  ON "partner_access_applications" ("applicant_session_id")
  WHERE "applicant_session_id" IS NOT NULL;
CREATE INDEX "partner_access_applications_requested_account_idx"
  ON "partner_access_applications" ("requested_partner_account_id", "status");

ALTER TABLE "partner_access_applications"
  DROP CONSTRAINT "partner_access_applications_approval_tenant_check",
  ADD CONSTRAINT "partner_access_applications_flow_version_check"
    CHECK ("flow_version" IN (1, 2)),
  ADD CONSTRAINT "partner_access_applications_verification_first_check"
    CHECK (
      "flow_version" <> 2
      OR (
        "email_verified_at" IS NOT NULL
        AND "email_verification_challenge_id" IS NOT NULL
        AND "applicant_session_id" IS NOT NULL
        AND "bootstrap_partner_account_id" IS NULL
      )
    ),
  ADD CONSTRAINT "partner_access_applications_company_resolution_check"
    CHECK (
      (
        "flow_version" = 1
        AND "company_resolution_choice" IS NULL
        AND "company_candidate_id" IS NULL
        AND "requested_partner_account_id" IS NULL
      ) OR (
        "flow_version" = 2
        AND (
          (
            "company_resolution_choice" = 'join_existing'
            AND "company_candidate_id" IS NOT NULL
            AND "company_candidate_id" ~ '^[A-Za-z0-9_-]{43}$'
            AND "requested_partner_account_id" IS NOT NULL
          ) OR (
            "company_resolution_choice" IN ('create_new', 'manual_review')
            AND "company_candidate_id" IS NULL
            AND "requested_partner_account_id" IS NULL
          )
        )
      )
    ),
  ADD CONSTRAINT "partner_access_applications_approval_tenant_check"
    CHECK (
      "status" <> 'approved'
      OR (
        (
          "flow_version" = 1
          AND "bootstrap_partner_account_id" IS NOT NULL
          AND "approved_partner_account_id" = "bootstrap_partner_account_id"
        ) OR (
          "flow_version" = 2
          AND "bootstrap_partner_account_id" IS NULL
        )
      )
    );

-- Existing timestamps were not tied to a verified E.164 value or consent
-- artifact. Fail closed instead of treating those ambiguous rows as evidence.
ALTER TABLE "partner_notification_preferences"
  DROP CONSTRAINT "partner_notification_preferences_sms_consent_check",
  ADD COLUMN "sms_verified_phone_e164" varchar(32),
  ADD COLUMN "sms_opt_in_source" text,
  ADD COLUMN "sms_consent_version" text;

UPDATE "partner_notification_preferences"
SET
  "sms_enabled" = false,
  "sms_verified_opt_in_at" = NULL
WHERE "sms_enabled" = true OR "sms_verified_opt_in_at" IS NOT NULL;

ALTER TABLE "partner_notification_preferences"
  ADD CONSTRAINT "partner_notification_preferences_sms_consent_check"
    CHECK (
      "sms_enabled" = false
      OR (
        "sms_verified_opt_in_at" IS NOT NULL
        AND "sms_verified_phone_e164" IS NOT NULL
        AND "sms_opt_in_source" IS NOT NULL
        AND "sms_consent_version" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "partner_notification_preferences_sms_phone_check"
    CHECK (
      "sms_verified_phone_e164" IS NULL
      OR "sms_verified_phone_e164" ~ '^\\+[1-9][0-9]{7,14}$'
    );
