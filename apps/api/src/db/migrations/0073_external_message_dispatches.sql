-- Durable contact-message dispatch attempts. A provider call is never made
-- until the requested row and its dispatched transition have committed.
-- A stale dispatched attempt is evidence of an uncertain provider effect and
-- must be reconciled by a human; it is never automatically redispatched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'external_message_dispatch_state'
  ) THEN
    CREATE TYPE "external_message_dispatch_state" AS ENUM (
      'requested',
      'dispatched',
      'succeeded',
      'failed',
      'reconciliation_required'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "external_message_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "channel" "conversation_channel" NOT NULL,
  "attempt_number" integer NOT NULL,
  "state" "external_message_dispatch_state" DEFAULT 'requested' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "provider_request_key" text NOT NULL,
  "provider" text,
  "provider_operation_id" text,
  "provider_operation_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "provider_idempotency_supported" boolean DEFAULT false NOT NULL,
  "dispatched_at" timestamp with time zone,
  "uncertainty_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "reconciliation_required_at" timestamp with time zone,
  "failure_detail" text,
  "retryable" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_outbox_event_fk'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_outbox_event_fk"
      FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_message_fk'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_message_fk"
      FOREIGN KEY ("message_id") REFERENCES "conversation_messages"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_contact_fk'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_contact_fk"
      FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_attempt_check'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_attempt_check"
      CHECK ("attempt_number" >= 1) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_version_check'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_version_check"
      CHECK ("version" >= 1) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_channel_check'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_channel_check"
      CHECK ("channel" IN ('sms', 'email', 'dm')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_message_dispatches_state_check'
  ) THEN
    ALTER TABLE "external_message_dispatches"
      ADD CONSTRAINT "external_message_dispatches_state_check"
      CHECK (
        (
          "state" = 'requested'
          AND "dispatched_at" IS NULL
          AND "completed_at" IS NULL
          AND "reconciliation_required_at" IS NULL
        )
        OR (
          "state" = 'dispatched'
          AND "dispatched_at" IS NOT NULL
          AND "uncertainty_at" IS NOT NULL
          AND "completed_at" IS NULL
          AND "reconciliation_required_at" IS NULL
        )
        OR (
          "state" = 'succeeded'
          AND "dispatched_at" IS NOT NULL
          AND "completed_at" IS NOT NULL
          AND "reconciliation_required_at" IS NULL
          AND "failure_detail" IS NULL
          AND "retryable" IS NULL
        )
        OR (
          "state" = 'failed'
          AND "completed_at" IS NOT NULL
          AND "reconciliation_required_at" IS NULL
          AND "failure_detail" IS NOT NULL
          AND "retryable" IS NOT NULL
        )
        OR (
          "state" = 'reconciliation_required'
          AND "dispatched_at" IS NOT NULL
          AND "completed_at" IS NOT NULL
          AND "reconciliation_required_at" IS NOT NULL
          AND "failure_detail" IS NOT NULL
          AND "retryable" = false
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_outbox_event_fk";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_message_fk";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_contact_fk";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_attempt_check";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_version_check";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_channel_check";
ALTER TABLE "external_message_dispatches"
  VALIDATE CONSTRAINT "external_message_dispatches_state_check";

CREATE UNIQUE INDEX IF NOT EXISTS "external_message_dispatches_event_attempt_key"
  ON "external_message_dispatches" ("outbox_event_id", "attempt_number");
CREATE UNIQUE INDEX IF NOT EXISTS "external_message_dispatches_provider_request_key"
  ON "external_message_dispatches" ("provider_request_key");
CREATE INDEX IF NOT EXISTS "external_message_dispatches_message_idx"
  ON "external_message_dispatches" ("message_id", "created_at");
CREATE INDEX IF NOT EXISTS "external_message_dispatches_contact_state_idx"
  ON "external_message_dispatches" ("contact_id", "state", "updated_at");
CREATE INDEX IF NOT EXISTS "external_message_dispatches_reconciliation_idx"
  ON "external_message_dispatches" ("reconciliation_required_at")
  WHERE "state" = 'reconciliation_required';

CREATE OR REPLACE FUNCTION enforce_external_message_dispatch_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."outbox_event_id" IS DISTINCT FROM OLD."outbox_event_id"
     OR NEW."message_id" IS DISTINCT FROM OLD."message_id"
     OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
     OR NEW."provider_request_key" IS DISTINCT FROM OLD."provider_request_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'external_message_dispatch_identity_immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'external_message_dispatch_version_must_increment';
  END IF;

  IF OLD."state" IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'external_message_dispatch_terminal_immutable';
  END IF;

  IF OLD."state" = 'requested'
     AND NEW."state" NOT IN ('dispatched', 'failed') THEN
    RAISE EXCEPTION 'external_message_dispatch_invalid_requested_transition';
  END IF;

  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'external_message_dispatch_invalid_dispatched_transition';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "external_message_dispatch_transition"
  ON "external_message_dispatches";
CREATE TRIGGER "external_message_dispatch_transition"
BEFORE UPDATE ON "external_message_dispatches"
FOR EACH ROW
EXECUTE FUNCTION enforce_external_message_dispatch_transition();

COMMENT ON COLUMN "external_message_dispatches"."provider_request_key" IS
  'Stable Stonegate request key. It is correlation evidence, not a claim that the provider enforces exactly-once delivery.';
COMMENT ON COLUMN "external_message_dispatches"."provider_idempotency_supported" IS
  'True only when the configured provider contract explicitly promises idempotent handling of provider_request_key.';
COMMENT ON COLUMN "external_message_dispatches"."uncertainty_at" IS
  'After this time a still-dispatched attempt becomes reconciliation_required; it must never be automatically sent again.';
