-- Make the public lead -> quote -> booking handoff replay-safe and preserve
-- explicit relationship evidence all the way into the CRM appointment.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "intake_operation_key_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "intake_request_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "intake_response" jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "leads_intake_operation_key_hash_key"
  ON "leads" ("intake_operation_key_hash")
  WHERE "intake_operation_key_hash" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "leads"
    ADD CONSTRAINT "leads_intake_operation_key_hash_check"
    CHECK (
      "intake_operation_key_hash" IS NULL OR
      "intake_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "leads"
    ADD CONSTRAINT "leads_intake_request_hash_check"
    CHECK (
      "intake_request_hash" IS NULL OR
      "intake_request_hash" ~ '^[0-9a-f]{64}$'
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "leads"
  VALIDATE CONSTRAINT "leads_intake_operation_key_hash_check";
ALTER TABLE "leads"
  VALIDATE CONSTRAINT "leads_intake_request_hash_check";

ALTER TABLE "appointment_holds"
  ADD COLUMN IF NOT EXISTS "full_quote_id" uuid;

DO $$ BEGIN
  ALTER TABLE "appointment_holds"
    ADD CONSTRAINT "appointment_holds_full_quote_id_quotes_id_fk"
    FOREIGN KEY ("full_quote_id") REFERENCES "public"."quotes"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "appointment_holds_full_quote_idx"
  ON "appointment_holds" ("full_quote_id");

ALTER TABLE "public_quote_mutation_receipts"
  DROP CONSTRAINT IF EXISTS "public_quote_mutation_receipts_action_check";
ALTER TABLE "public_quote_mutation_receipts"
  ADD CONSTRAINT "public_quote_mutation_receipts_action_check"
  CHECK ("action" IN ('decision', 'refresh', 'hold', 'book'));

COMMENT ON TABLE "public_quote_mutation_receipts" IS
  'Token-free exact-replay receipts for customer quote decisions, refresh requests, scheduling holds, and bookings.';
