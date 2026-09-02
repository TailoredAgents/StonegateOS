-- Phone numbers are notification destinations only. Verification and consent
-- are modeled independently from partner authentication and account access.

CREATE TABLE "partner_notification_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_user_id" uuid NOT NULL
    REFERENCES "partner_users"("id") ON DELETE CASCADE,
  "channel" text NOT NULL DEFAULT 'sms',
  "normalized_destination" varchar(32) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "verified_at" timestamptz,
  "consent_at" timestamptz,
  "consent_source" text,
  "consent_version" text,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_notification_endpoints_channel_check"
    CHECK ("channel" = 'sms'),
  CONSTRAINT "partner_notification_endpoints_destination_check"
    CHECK ("normalized_destination" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT "partner_notification_endpoints_status_check"
    CHECK ("status" IN ('pending', 'verified', 'revoked')),
  CONSTRAINT "partner_notification_endpoints_lifecycle_check" CHECK (
    (
      "status" = 'pending'
      AND "verified_at" IS NULL
      AND "consent_at" IS NULL
      AND "consent_source" IS NULL
      AND "consent_version" IS NULL
      AND "revoked_at" IS NULL
    ) OR (
      "status" = 'verified'
      AND "verified_at" IS NOT NULL
      AND "consent_at" IS NOT NULL
      AND "consent_source" IS NOT NULL
      AND "consent_version" IS NOT NULL
      AND "revoked_at" IS NULL
    ) OR (
      "status" = 'revoked'
      AND "revoked_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "partner_notification_endpoints_user_destination_key"
  ON "partner_notification_endpoints" (
    "partner_user_id",
    "channel",
    "normalized_destination"
  );
CREATE UNIQUE INDEX "partner_notification_endpoints_verified_sms_user_key"
  ON "partner_notification_endpoints" ("partner_user_id", "channel")
  WHERE "status" = 'verified';
CREATE INDEX "partner_notification_endpoints_user_status_idx"
  ON "partner_notification_endpoints" (
    "partner_user_id",
    "status",
    "updated_at"
  );

CREATE TABLE "partner_notification_endpoint_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "endpoint_id" uuid NOT NULL
    REFERENCES "partner_notification_endpoints"("id") ON DELETE CASCADE,
  "partner_user_id" uuid NOT NULL
    REFERENCES "partner_users"("id") ON DELETE CASCADE,
  "partner_account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "code_hash" text,
  "generation" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "delivery_status" text NOT NULL DEFAULT 'queued',
  "delivery_outbox_event_id" uuid
    REFERENCES "outbox_events"("id") ON DELETE SET NULL,
  "delivery_attempt_id" uuid,
  "delivery_provider" text,
  "delivery_provider_message_id" text,
  "delivery_detail" text,
  "dispatch_started_at" timestamptz,
  "sent_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "revoked_at" timestamptz,
  "expired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_notification_endpoint_challenges_membership_account_fk"
    FOREIGN KEY ("membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_notification_endpoint_challenges_status_check"
    CHECK ("status" IN ('pending', 'consumed', 'revoked', 'expired')),
  CONSTRAINT "partner_notification_endpoint_challenges_delivery_status_check"
    CHECK (
      "delivery_status" IN (
        'queued',
        'dispatching',
        'accepted',
        'failed',
        'reconciliation_required'
      )
    ),
  CONSTRAINT "partner_notification_endpoint_challenges_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "partner_notification_endpoint_challenges_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 5),
  CONSTRAINT "partner_notification_endpoint_challenges_lifecycle_check" CHECK (
    (
      "status" = 'pending'
      AND "code_hash" IS NOT NULL
      AND "consumed_at" IS NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'consumed'
      AND "code_hash" IS NULL
      AND "consumed_at" IS NOT NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'revoked'
      AND "code_hash" IS NULL
      AND "consumed_at" IS NULL
      AND "revoked_at" IS NOT NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'expired'
      AND "code_hash" IS NULL
      AND "consumed_at" IS NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX
  "partner_notification_endpoint_challenges_endpoint_generation_key"
  ON "partner_notification_endpoint_challenges" (
    "endpoint_id",
    "generation"
  );
CREATE UNIQUE INDEX
  "partner_notification_endpoint_challenges_active_endpoint_key"
  ON "partner_notification_endpoint_challenges" ("endpoint_id")
  WHERE "status" = 'pending';
CREATE UNIQUE INDEX
  "partner_notification_endpoint_challenges_delivery_outbox_key"
  ON "partner_notification_endpoint_challenges" ("delivery_outbox_event_id")
  WHERE "delivery_outbox_event_id" IS NOT NULL;
CREATE INDEX "partner_notification_endpoint_challenges_expiry_idx"
  ON "partner_notification_endpoint_challenges" ("status", "expires_at");

ALTER TABLE "partner_notification_preferences"
  ADD COLUMN "sms_verified_endpoint_id" uuid
    REFERENCES "partner_notification_endpoints"("id") ON DELETE SET NULL;

ALTER TABLE "partner_notification_preferences"
  DROP CONSTRAINT "partner_notification_preferences_sms_consent_check",
  ADD CONSTRAINT "partner_notification_preferences_sms_consent_check" CHECK (
    "sms_enabled" = false OR (
      "sms_verified_opt_in_at" IS NOT NULL
      AND "sms_verified_phone_e164" IS NOT NULL
      AND "sms_verified_endpoint_id" IS NOT NULL
      AND "sms_opt_in_source" IS NOT NULL
      AND "sms_consent_version" IS NOT NULL
    )
  );
