-- Keep transient receipt-analysis failures pollable while the durable outbox
-- waits for its next attempt. Only terminal/exhausted analysis uses `failed`.

ALTER TABLE "expense_receipt_captures"
  ADD COLUMN IF NOT EXISTS "analysis_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "analysis_next_attempt_at" timestamp with time zone;

UPDATE "expense_receipt_captures"
SET "analysis_attempt_count" = 1
WHERE "analysis_attempt_count" = 0
  AND "analysis_started_at" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expense_receipt_captures_analysis_attempt_count_check'
      AND conrelid = 'expense_receipt_captures'::regclass
  ) THEN
    ALTER TABLE "expense_receipt_captures"
      ADD CONSTRAINT "expense_receipt_captures_analysis_attempt_count_check"
      CHECK ("analysis_attempt_count" >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE "expense_receipt_captures"
  VALIDATE CONSTRAINT "expense_receipt_captures_analysis_attempt_count_check";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expense_receipt_captures_retry_state_check'
      AND conrelid = 'expense_receipt_captures'::regclass
  ) THEN
    ALTER TABLE "expense_receipt_captures"
      ADD CONSTRAINT "expense_receipt_captures_retry_state_check"
      CHECK (
        "analysis_next_attempt_at" IS NULL
        OR (
          "status" = 'queued'
          AND "failure_code" IS NOT NULL
          AND "analysis_started_at" IS NULL
          AND "analysis_completed_at" IS NULL
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "expense_receipt_captures"
  VALIDATE CONSTRAINT "expense_receipt_captures_retry_state_check";

CREATE OR REPLACE FUNCTION enforce_expense_capture_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt captures cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'receipt capture version must increase by exactly one'
      USING ERRCODE = '40001';
  END IF;

  IF NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
     OR NEW."storage_provider" IS DISTINCT FROM OLD."storage_provider"
     OR NEW."original_object_key" IS DISTINCT FROM OLD."original_object_key"
     OR NEW."filename" IS DISTINCT FROM OLD."filename"
     OR NEW."declared_content_type" IS DISTINCT FROM OLD."declared_content_type"
     OR NEW."upload_expires_at" IS DISTINCT FROM OLD."upload_expires_at" THEN
    RAISE EXCEPTION 'receipt capture upload intent is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."uploaded_at" IS NOT NULL AND (
    NEW."verified_content_type" IS DISTINCT FROM OLD."verified_content_type"
    OR NEW."byte_length" IS DISTINCT FROM OLD."byte_length"
    OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."uploaded_at" IS DISTINCT FROM OLD."uploaded_at"
  ) THEN
    RAISE EXCEPTION 'uploaded receipt evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" IN ('confirmed', 'discarded') THEN
    RAISE EXCEPTION 'terminal receipt capture is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD."status" = 'pending_upload' AND NEW."status" IN ('uploaded', 'discarded'))
    OR (OLD."status" = 'uploaded' AND NEW."status" IN ('queued', 'discarded'))
    OR (OLD."status" = 'queued' AND NEW."status" IN ('analyzing', 'failed', 'discarded'))
    OR (OLD."status" = 'analyzing' AND NEW."status" IN ('queued', 'ready', 'failed'))
    OR (OLD."status" = 'ready' AND NEW."status" IN ('confirmed', 'discarded'))
    OR (OLD."status" = 'failed' AND NEW."status" = 'discarded')
  ) THEN
    RAISE EXCEPTION 'invalid receipt capture status transition'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "expense_receipt_captures"."analysis_attempt_count" IS
  'Durable count of analysis attempts that acquired the capture lease.';
COMMENT ON COLUMN "expense_receipt_captures"."analysis_next_attempt_at" IS
  'Next scheduled durable retry; only set while a retryable failure remains queued.';
