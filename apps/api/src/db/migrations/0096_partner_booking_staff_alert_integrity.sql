-- Make partner booking writes replay-safe and move internal staff alerts to a
-- durable provider operation. Internal alerts must not masquerade as customer
-- conversation messages and provider ambiguity must never trigger a blind
-- resend.

ALTER TABLE "partner_bookings"
  ADD COLUMN IF NOT EXISTS "create_operation_key_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "create_request_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "cancel_operation_key_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "canceled_at" timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS
  "partner_bookings_create_operation_key_hash_key"
  ON "partner_bookings" ("create_operation_key_hash")
  WHERE "create_operation_key_hash" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "partner_bookings"
    ADD CONSTRAINT "partner_bookings_create_operation_key_hash_check"
    CHECK (
      "create_operation_key_hash" IS NULL OR
      "create_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "partner_bookings"
    ADD CONSTRAINT "partner_bookings_create_request_hash_check"
    CHECK (
      "create_request_hash" IS NULL OR
      "create_request_hash" ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "partner_bookings"
    ADD CONSTRAINT "partner_bookings_cancel_operation_key_hash_check"
    CHECK (
      "cancel_operation_key_hash" IS NULL OR
      "cancel_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "partner_bookings"
    ADD CONSTRAINT "partner_bookings_version_check"
    CHECK ("version" > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "partner_bookings"
  VALIDATE CONSTRAINT "partner_bookings_create_operation_key_hash_check";
ALTER TABLE "partner_bookings"
  VALIDATE CONSTRAINT "partner_bookings_create_request_hash_check";
ALTER TABLE "partner_bookings"
  VALIDATE CONSTRAINT "partner_bookings_cancel_operation_key_hash_check";
ALTER TABLE "partner_bookings"
  VALIDATE CONSTRAINT "partner_bookings_version_check";

CREATE TABLE IF NOT EXISTS "staff_notification_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Snapshot identifier: evidence survives a later CRM retention purge.
  "appointment_id" uuid NOT NULL,
  "contact_id" uuid
    REFERENCES "contacts"("id") ON DELETE set null,
  "recipient_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE set null,
  "kind" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'sms',
  "recipient_address" text NOT NULL,
  "body" text NOT NULL,
  "state" text NOT NULL DEFAULT 'requested',
  "provider_request_key" varchar(160) NOT NULL,
  "provider" text,
  "provider_operation_id" text,
  "delivery_certainty" text,
  "failure_code" text,
  "retryable" boolean NOT NULL DEFAULT false,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "dispatched_at" timestamp with time zone,
  "uncertainty_at" timestamp with time zone,
  "succeeded_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "staff_notification_operations_state_check"
    CHECK ("state" IN (
      'requested',
      'dispatched',
      'succeeded',
      'failed',
      'reconciliation_required'
    )),
  CONSTRAINT "staff_notification_operations_channel_check"
    CHECK ("channel" = 'sms'),
  CONSTRAINT "staff_notification_operations_kind_check"
    CHECK ("kind" IN (
      'partner_booking_created',
      'partner_booking_canceled'
    )),
  CONSTRAINT "staff_notification_operations_recipient_check"
    CHECK ("recipient_address" ~ '^\+[1-9][0-9]{9,14}$'),
  CONSTRAINT "staff_notification_operations_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 20),
  CONSTRAINT "staff_notification_operations_lifecycle_check"
    CHECK (
      ("state" = 'requested' AND "succeeded_at" IS NULL AND "failed_at" IS NULL)
      OR
      ("state" = 'dispatched' AND "dispatched_at" IS NOT NULL AND "uncertainty_at" IS NOT NULL AND "succeeded_at" IS NULL AND "failed_at" IS NULL)
      OR
      ("state" = 'succeeded' AND "succeeded_at" IS NOT NULL AND "failed_at" IS NULL)
      OR
      ("state" IN ('failed', 'reconciliation_required') AND "failed_at" IS NOT NULL AND "succeeded_at" IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "staff_notification_operations_appointment_kind_recipient_key"
  ON "staff_notification_operations" (
    "appointment_id",
    "kind",
    "recipient_team_member_id"
  );

-- A recipient may later be deleted. Keep the operation itself unique and
-- replay-safe even after the nullable relationship has been cleared.
CREATE UNIQUE INDEX IF NOT EXISTS
  "staff_notification_operations_appointment_kind_address_key"
  ON "staff_notification_operations" (
    "appointment_id",
    "kind",
    "recipient_address"
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  "staff_notification_operations_provider_request_key_key"
  ON "staff_notification_operations" ("provider_request_key");

CREATE INDEX IF NOT EXISTS "staff_notification_operations_state_idx"
  ON "staff_notification_operations" ("state", "created_at");

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_auth_method_check";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_auth_method_check"
  CHECK (
    "auth_method" IS NULL OR
    "auth_method" IN (
      'team_session',
      'break_glass',
      'partner_session',
      'service'
    )
  ) NOT VALID;
ALTER TABLE "audit_logs"
  VALIDATE CONSTRAINT "audit_logs_auth_method_check";
