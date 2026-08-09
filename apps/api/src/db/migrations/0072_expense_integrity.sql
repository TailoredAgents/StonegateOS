-- Explicit, append-friendly expense lifecycle and correction ledger.
--
-- Existing rows become posted entries without changing their financial
-- values. New manual entries are created as drafts by the API. Provider and
-- payout writers that have not yet adopted lifecycle fields continue to
-- create posted rows through the database defaults.

DO $$
BEGIN
  CREATE TYPE "expense_lifecycle_status" AS ENUM (
    'draft',
    'posted',
    'voided',
    'corrected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "lifecycle_status" "expense_lifecycle_status"
    DEFAULT 'posted' NOT NULL,
  ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "posted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "posted_by" uuid,
  ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "voided_by" uuid,
  ADD COLUMN IF NOT EXISTS "void_reason" text,
  ADD COLUMN IF NOT EXISTS "corrected_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "corrected_by" uuid,
  ADD COLUMN IF NOT EXISTS "correction_reason" text,
  ADD COLUMN IF NOT EXISTS "reversal_of_expense_id" uuid,
  ADD COLUMN IF NOT EXISTS "correction_of_expense_id" uuid,
  ADD COLUMN IF NOT EXISTS "corrected_by_expense_id" uuid;

UPDATE "expenses"
SET
  "version" = greatest(coalesce("version", 1), 1)
WHERE "version" IS NULL OR "version" < 1;

UPDATE "expenses"
SET "posted_at" = coalesce("created_at", "paid_at", now())
WHERE "lifecycle_status" = 'posted' AND "posted_at" IS NULL;

ALTER TABLE "expenses"
  ALTER COLUMN "posted_at" SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_reversal_of_expense_id_expenses_id_fk'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_reversal_of_expense_id_expenses_id_fk"
      FOREIGN KEY ("reversal_of_expense_id") REFERENCES "public"."expenses"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_correction_of_expense_id_expenses_id_fk'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_correction_of_expense_id_expenses_id_fk"
      FOREIGN KEY ("correction_of_expense_id") REFERENCES "public"."expenses"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_corrected_by_expense_id_expenses_id_fk'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_corrected_by_expense_id_expenses_id_fk"
      FOREIGN KEY ("corrected_by_expense_id") REFERENCES "public"."expenses"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_reversal_of_expense_id_expenses_id_fk";
ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_correction_of_expense_id_expenses_id_fk";
ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_corrected_by_expense_id_expenses_id_fk";

CREATE INDEX IF NOT EXISTS "expenses_lifecycle_status_idx"
  ON "expenses" ("lifecycle_status");
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_reversal_of_key"
  ON "expenses" ("reversal_of_expense_id");
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_correction_of_key"
  ON "expenses" ("correction_of_expense_id");
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_corrected_by_key"
  ON "expenses" ("corrected_by_expense_id");

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_version_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_version_check"
  CHECK ("version" >= 1) NOT VALID;

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_currency_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_currency_check"
  CHECK ("currency" = 'USD') NOT VALID;

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_coverage_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_coverage_check"
  CHECK (
    "coverage_start_at" IS NULL
    OR "coverage_end_at" IS NULL
    OR "coverage_end_at" >= "coverage_start_at"
  ) NOT VALID;

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_amount_direction_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_direction_check"
  CHECK (
    ("reversal_of_expense_id" IS NULL AND "amount_cents" > 0)
    OR
    ("reversal_of_expense_id" IS NOT NULL AND "amount_cents" < 0)
  ) NOT VALID;

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_relationship_shape_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_relationship_shape_check"
  CHECK (
    "reversal_of_expense_id" IS DISTINCT FROM "id"
    AND "correction_of_expense_id" IS DISTINCT FROM "id"
    AND "corrected_by_expense_id" IS DISTINCT FROM "id"
    AND NOT (
      "reversal_of_expense_id" IS NOT NULL
      AND "correction_of_expense_id" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_lifecycle_timeline_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_lifecycle_timeline_check"
  CHECK (
    (
      "lifecycle_status" = 'draft'
      AND "posted_at" IS NULL
      AND "posted_by" IS NULL
      AND "voided_at" IS NULL
      AND "voided_by" IS NULL
      AND "void_reason" IS NULL
      AND "corrected_at" IS NULL
      AND "corrected_by" IS NULL
      AND "correction_reason" IS NULL
      AND "reversal_of_expense_id" IS NULL
      AND "correction_of_expense_id" IS NULL
      AND "corrected_by_expense_id" IS NULL
    )
    OR
    (
      "lifecycle_status" = 'posted'
      AND "posted_at" IS NOT NULL
      AND "voided_at" IS NULL
      AND "voided_by" IS NULL
      AND "void_reason" IS NULL
      AND "corrected_at" IS NULL
      AND "corrected_by" IS NULL
      AND "correction_reason" IS NULL
      AND "corrected_by_expense_id" IS NULL
    )
    OR
    (
      "lifecycle_status" = 'voided'
      AND "posted_at" IS NOT NULL
      AND "voided_at" IS NOT NULL
      AND nullif(btrim("void_reason"), '') IS NOT NULL
      AND "corrected_at" IS NULL
      AND "corrected_by" IS NULL
      AND "correction_reason" IS NULL
      AND "reversal_of_expense_id" IS NULL
      AND "corrected_by_expense_id" IS NULL
    )
    OR
    (
      "lifecycle_status" = 'corrected'
      AND "posted_at" IS NOT NULL
      AND "voided_at" IS NULL
      AND "voided_by" IS NULL
      AND "void_reason" IS NULL
      AND "corrected_at" IS NOT NULL
      AND nullif(btrim("correction_reason"), '') IS NOT NULL
      AND "reversal_of_expense_id" IS NULL
      AND "corrected_by_expense_id" IS NOT NULL
    )
  ) NOT VALID;

-- These backfilled invariants are safe to validate immediately. Amount,
-- currency, and coverage constraints remain NOT VALID so a historical anomaly
-- cannot block deployment; PostgreSQL still enforces them for every new or
-- changed row until reconciliation validates the old rows.
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_version_check";
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_relationship_shape_check";
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_lifecycle_timeline_check";

CREATE OR REPLACE FUNCTION enforce_expense_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payout_link_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."source" IN ('manual', 'manual_correction') THEN
      RAISE EXCEPTION 'manual expense ledger entries cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  payout_link_only :=
    OLD."source" = 'payout_run'
    AND OLD."payout_run_id" IS NULL
    AND NEW."payout_run_id" IS NOT NULL
    AND NEW."lifecycle_status" = OLD."lifecycle_status"
    AND NEW."version" = OLD."version"
    AND NEW."amount_cents" IS NOT DISTINCT FROM OLD."amount_cents"
    AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
    AND NEW."category" IS NOT DISTINCT FROM OLD."category"
    AND NEW."vendor" IS NOT DISTINCT FROM OLD."vendor"
    AND NEW."memo" IS NOT DISTINCT FROM OLD."memo"
    AND NEW."method" IS NOT DISTINCT FROM OLD."method"
    AND NEW."source" IS NOT DISTINCT FROM OLD."source"
    AND NEW."paid_at" IS NOT DISTINCT FROM OLD."paid_at"
    AND NEW."coverage_start_at" IS NOT DISTINCT FROM OLD."coverage_start_at"
    AND NEW."coverage_end_at" IS NOT DISTINCT FROM OLD."coverage_end_at"
    AND NEW."receipt_filename" IS NOT DISTINCT FROM OLD."receipt_filename"
    AND NEW."receipt_url" IS NOT DISTINCT FROM OLD."receipt_url"
    AND NEW."receipt_content_type" IS NOT DISTINCT FROM OLD."receipt_content_type"
    AND NEW."bank_transaction_id" IS NOT DISTINCT FROM OLD."bank_transaction_id"
    AND NEW."posted_at" IS NOT DISTINCT FROM OLD."posted_at"
    AND NEW."posted_by" IS NOT DISTINCT FROM OLD."posted_by"
    AND NEW."voided_at" IS NOT DISTINCT FROM OLD."voided_at"
    AND NEW."voided_by" IS NOT DISTINCT FROM OLD."voided_by"
    AND NEW."void_reason" IS NOT DISTINCT FROM OLD."void_reason"
    AND NEW."corrected_at" IS NOT DISTINCT FROM OLD."corrected_at"
    AND NEW."corrected_by" IS NOT DISTINCT FROM OLD."corrected_by"
    AND NEW."correction_reason" IS NOT DISTINCT FROM OLD."correction_reason"
    AND NEW."reversal_of_expense_id" IS NOT DISTINCT FROM OLD."reversal_of_expense_id"
    AND NEW."correction_of_expense_id" IS NOT DISTINCT FROM OLD."correction_of_expense_id"
    AND NEW."corrected_by_expense_id" IS NOT DISTINCT FROM OLD."corrected_by_expense_id";

  IF payout_link_only THEN
    RETURN NEW;
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'expense version must increase by exactly one'
      USING ERRCODE = '40001';
  END IF;

  IF OLD."lifecycle_status" = 'draft'
     AND NEW."lifecycle_status" NOT IN ('draft', 'posted') THEN
    RAISE EXCEPTION 'invalid expense transition from draft'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."lifecycle_status" = 'posted'
     AND NEW."lifecycle_status" NOT IN ('posted', 'voided', 'corrected') THEN
    RAISE EXCEPTION 'invalid expense transition from posted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."lifecycle_status" IN ('voided', 'corrected') THEN
    RAISE EXCEPTION 'terminal expense is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."lifecycle_status" <> 'draft' AND (
    NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."vendor" IS DISTINCT FROM OLD."vendor"
    OR NEW."memo" IS DISTINCT FROM OLD."memo"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."paid_at" IS DISTINCT FROM OLD."paid_at"
    OR NEW."coverage_start_at" IS DISTINCT FROM OLD."coverage_start_at"
    OR NEW."coverage_end_at" IS DISTINCT FROM OLD."coverage_end_at"
    OR NEW."receipt_filename" IS DISTINCT FROM OLD."receipt_filename"
    OR NEW."receipt_url" IS DISTINCT FROM OLD."receipt_url"
    OR NEW."receipt_content_type" IS DISTINCT FROM OLD."receipt_content_type"
    OR NEW."bank_transaction_id" IS DISTINCT FROM OLD."bank_transaction_id"
    OR NEW."payout_run_id" IS DISTINCT FROM OLD."payout_run_id"
    OR NEW."posted_at" IS DISTINCT FROM OLD."posted_at"
    OR NEW."posted_by" IS DISTINCT FROM OLD."posted_by"
    OR NEW."reversal_of_expense_id" IS DISTINCT FROM OLD."reversal_of_expense_id"
    OR NEW."correction_of_expense_id" IS DISTINCT FROM OLD."correction_of_expense_id"
  ) THEN
    RAISE EXCEPTION 'posted expense financial evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."lifecycle_status" = 'draft' AND (
    NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."bank_transaction_id" IS DISTINCT FROM OLD."bank_transaction_id"
    OR NEW."payout_run_id" IS DISTINCT FROM OLD."payout_run_id"
    OR NEW."reversal_of_expense_id" IS DISTINCT FROM OLD."reversal_of_expense_id"
    OR NEW."correction_of_expense_id" IS DISTINCT FROM OLD."correction_of_expense_id"
    OR NEW."corrected_by_expense_id" IS DISTINCT FROM OLD."corrected_by_expense_id"
  ) THEN
    RAISE EXCEPTION 'draft expense ownership and ledger links are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_lifecycle_transition_guard" ON "expenses";
CREATE TRIGGER "expenses_lifecycle_transition_guard"
  BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_lifecycle_transition();

COMMENT ON COLUMN "expenses"."lifecycle_status" IS
  'Draft entries are editable and excluded from totals; posted entries change only through linked reversal/correction records.';
COMMENT ON COLUMN "expenses"."version" IS
  'Optimistic concurrency version. User-visible mutations must provide the expected value.';
COMMENT ON COLUMN "expenses"."posted_by" IS
  'Immutable verified actor snapshot; intentionally not a mutable foreign key.';
COMMENT ON COLUMN "expenses"."voided_by" IS
  'Immutable verified actor snapshot; intentionally not a mutable foreign key.';
COMMENT ON COLUMN "expenses"."corrected_by" IS
  'Immutable verified actor snapshot; intentionally not a mutable foreign key.';
COMMENT ON COLUMN "expenses"."reversal_of_expense_id" IS
  'Negative posted ledger entry reversing exactly one prior posted expense.';
COMMENT ON COLUMN "expenses"."correction_of_expense_id" IS
  'Positive posted replacement linked to the expense it corrects.';
COMMENT ON COLUMN "expenses"."corrected_by_expense_id" IS
  'Replacement entry selected atomically when this expense becomes corrected.';
