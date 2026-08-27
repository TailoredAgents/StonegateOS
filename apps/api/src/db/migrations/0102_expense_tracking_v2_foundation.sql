-- Expense Tracking V2 expand-phase foundation.
--
-- This migration is additive. Existing ledger fields and legacy receipt data
-- URLs remain readable while new receipts use private object storage. Known
-- categories are mapped deterministically; unknown labels are preserved and
-- explicitly flagged for review.

DO $$
BEGIN
  CREATE TYPE "expense_review_status" AS ENUM (
    'draft', 'pending', 'approved', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "expense_payer_type" AS ENUM ('company', 'personal');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "expense_receipt_capture_status" AS ENUM (
    'pending_upload', 'uploaded', 'queued', 'analyzing', 'ready', 'failed',
    'confirmed', 'discarded'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "expense_reimbursement_status" AS ENUM (
    'pending', 'approved', 'attached', 'paid', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "daily_ad_platform" AS ENUM ('facebook', 'google');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_legacy" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_categories_id_check"
    CHECK ("id" ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_name_key"
  ON "expense_categories" ("name");
CREATE INDEX IF NOT EXISTS "expense_categories_active_sort_idx"
  ON "expense_categories" ("is_active", "sort_order");

INSERT INTO "expense_categories"
  ("id", "name", "sort_order", "is_active", "is_legacy")
VALUES
  ('dump_fees', 'Dump Fees', 10, true, false),
  ('fuel', 'Fuel', 20, true, false),
  ('meals', 'Meals', 30, true, false),
  ('equipment', 'Equipment', 40, true, false),
  ('vehicle', 'Vehicle', 50, true, false),
  ('insurance', 'Insurance', 60, true, false),
  ('software', 'Software', 70, true, false),
  ('advertising', 'Advertising', 80, true, false),
  ('supplies', 'Supplies', 90, true, false),
  ('tolls_parking', 'Tolls/Parking', 100, true, false),
  ('subcontractors', 'Subcontractors', 110, true, false),
  ('office_admin', 'Office/Admin', 120, true, false),
  ('other', 'Other', 130, true, false),
  ('reimbursements', 'Reimbursements', 140, false, true)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "sort_order" = EXCLUDED."sort_order",
  "is_active" = EXCLUDED."is_active",
  "is_legacy" = EXCLUDED."is_legacy",
  "updated_at" = now();

CREATE TABLE IF NOT EXISTS "expense_category_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "category_id" text NOT NULL REFERENCES "expense_categories"("id")
    ON DELETE RESTRICT,
  "alias" text NOT NULL,
  "normalized_alias" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_category_aliases_normalized_check" CHECK (
    "normalized_alias" = lower(btrim("normalized_alias"))
    AND length("normalized_alias") > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_category_aliases_normalized_key"
  ON "expense_category_aliases" ("normalized_alias");
CREATE INDEX IF NOT EXISTS "expense_category_aliases_category_idx"
  ON "expense_category_aliases" ("category_id");

INSERT INTO "expense_category_aliases"
  ("category_id", "alias", "normalized_alias")
VALUES
  ('dump_fees', 'Dump Fees', 'dump fees'),
  ('dump_fees', 'Dump Fee', 'dump fee'),
  ('dump_fees', 'Disposal', 'disposal'),
  ('dump_fees', 'Disposal Fees', 'disposal fees'),
  ('dump_fees', 'Landfill', 'landfill'),
  ('fuel', 'Fuel', 'fuel'),
  ('fuel', 'Gas', 'gas'),
  ('fuel', 'Gasoline', 'gasoline'),
  ('fuel', 'Diesel', 'diesel'),
  ('meals', 'Meals', 'meals'),
  ('meals', 'Meal', 'meal'),
  ('meals', 'Food', 'food'),
  ('equipment', 'Equipment', 'equipment'),
  ('vehicle', 'Vehicle', 'vehicle'),
  ('vehicle', 'Auto', 'auto'),
  ('vehicle', 'Vehicle Maintenance', 'vehicle maintenance'),
  ('insurance', 'Insurance', 'insurance'),
  ('software', 'Software', 'software'),
  ('software', 'Subscriptions', 'subscriptions'),
  ('advertising', 'Advertising', 'advertising'),
  ('advertising', 'Marketing', 'marketing'),
  ('advertising', 'Facebook Ads', 'facebook ads'),
  ('advertising', 'Meta Ads', 'meta ads'),
  ('advertising', 'Google Ads', 'google ads'),
  ('supplies', 'Supplies', 'supplies'),
  ('supplies', 'Materials', 'materials'),
  ('tolls_parking', 'Tolls/Parking', 'tolls parking'),
  ('tolls_parking', 'Tolls', 'tolls'),
  ('tolls_parking', 'Parking', 'parking'),
  ('subcontractors', 'Subcontractors', 'subcontractors'),
  ('subcontractors', 'Subcontractor', 'subcontractor'),
  ('office_admin', 'Office/Admin', 'office admin'),
  ('office_admin', 'Office', 'office'),
  ('office_admin', 'Admin', 'admin'),
  ('other', 'Other', 'other'),
  ('other', 'Miscellaneous', 'miscellaneous'),
  ('other', 'Misc', 'misc'),
  ('reimbursements', 'Reimbursements', 'reimbursements'),
  ('reimbursements', 'Reimbursement', 'reimbursement')
ON CONFLICT ("normalized_alias") DO UPDATE SET
  "category_id" = EXCLUDED."category_id",
  "alias" = EXCLUDED."alias";

CREATE TABLE IF NOT EXISTS "expense_receipt_captures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submitted_by" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  "status" "expense_receipt_capture_status"
    DEFAULT 'pending_upload' NOT NULL,
  "storage_provider" text DEFAULT 'r2' NOT NULL,
  "original_object_key" text NOT NULL,
  "normalized_object_key" text,
  "filename" text NOT NULL,
  "declared_content_type" text NOT NULL,
  "verified_content_type" text,
  "byte_length" integer,
  "sha256" varchar(64),
  "upload_expires_at" timestamp with time zone NOT NULL,
  "uploaded_at" timestamp with time zone,
  "analysis_queued_at" timestamp with time zone,
  "analysis_started_at" timestamp with time zone,
  "analysis_completed_at" timestamp with time zone,
  "analysis_model" text,
  "extraction" jsonb,
  "analysis_warnings" jsonb,
  "failure_code" text,
  "failure_message" text,
  "exact_duplicate_of_capture_id" uuid,
  "duplicate_override_reason" text,
  "duplicate_override_by" uuid REFERENCES "team_members"("id")
    ON DELETE SET NULL,
  "duplicate_override_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "discarded_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_receipt_captures_sha256_check"
    CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "expense_receipt_captures_byte_length_check"
    CHECK ("byte_length" IS NULL OR "byte_length" BETWEEN 1 AND 10485760),
  CONSTRAINT "expense_receipt_captures_version_check" CHECK ("version" >= 1)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expense_receipt_captures_duplicate_capture_fk'
  ) THEN
    ALTER TABLE "expense_receipt_captures"
      ADD CONSTRAINT "expense_receipt_captures_duplicate_capture_fk"
      FOREIGN KEY ("exact_duplicate_of_capture_id")
      REFERENCES "expense_receipt_captures"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE "expense_receipt_captures"
  VALIDATE CONSTRAINT "expense_receipt_captures_duplicate_capture_fk";

CREATE UNIQUE INDEX IF NOT EXISTS "expense_receipt_captures_object_key"
  ON "expense_receipt_captures" ("original_object_key");
CREATE INDEX IF NOT EXISTS "expense_receipt_captures_submitter_created_idx"
  ON "expense_receipt_captures" ("submitted_by", "created_at");
CREATE INDEX IF NOT EXISTS "expense_receipt_captures_status_updated_idx"
  ON "expense_receipt_captures" ("status", "updated_at");
CREATE INDEX IF NOT EXISTS "expense_receipt_captures_sha256_idx"
  ON "expense_receipt_captures" ("sha256");

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "category_id" text
    REFERENCES "expense_categories"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "category_needs_review" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "submitted_by" uuid
    REFERENCES "team_members"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "payer_type" "expense_payer_type"
    DEFAULT 'company' NOT NULL,
  ADD COLUMN IF NOT EXISTS "paid_by_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "review_status" "expense_review_status"
    DEFAULT 'approved' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_by" uuid
    REFERENCES "team_members"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "review_reason" text,
  ADD COLUMN IF NOT EXISTS "receipt_capture_id" uuid
    REFERENCES "expense_receipt_captures"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "appointment_id" uuid
    REFERENCES "appointments"("id") ON DELETE SET NULL;

-- Migration 0072 intentionally guards every expense UPDATE. This migration's
-- deterministic metadata backfill runs while the table is locked, then the
-- lifecycle guard is restored before application traffic can observe it.
ALTER TABLE "expenses"
  DISABLE TRIGGER "expenses_lifecycle_transition_guard";

UPDATE "expenses" AS expense
SET "category_id" = alias."category_id"
FROM "expense_category_aliases" AS alias
WHERE expense."category_id" IS NULL
  AND expense."category" IS NOT NULL
  AND alias."normalized_alias" = lower(
    btrim(regexp_replace(expense."category", '[^a-zA-Z0-9]+', ' ', 'g'))
  );

UPDATE "expenses"
SET
  "category_needs_review" = (
    nullif(btrim("category"), '') IS NOT NULL AND "category_id" IS NULL
  ),
  "submitted_by" = coalesce("submitted_by", "posted_by"),
  "review_status" = CASE
    WHEN "lifecycle_status" = 'draft' THEN 'draft'::"expense_review_status"
    ELSE 'approved'::"expense_review_status"
  END,
  "reviewed_by" = CASE
    WHEN "lifecycle_status" = 'draft' THEN NULL
    ELSE coalesce("reviewed_by", "posted_by")
  END,
  "reviewed_at" = CASE
    WHEN "lifecycle_status" = 'draft' THEN NULL
    ELSE coalesce("posted_at", "created_at", now())
  END,
  "review_reason" = CASE
    WHEN "lifecycle_status" = 'draft' THEN NULL
    ELSE "review_reason"
  END;

ALTER TABLE "expenses"
  ENABLE TRIGGER "expenses_lifecycle_transition_guard";

CREATE INDEX IF NOT EXISTS "expenses_category_id_idx"
  ON "expenses" ("category_id");
CREATE INDEX IF NOT EXISTS "expenses_submitter_paid_at_idx"
  ON "expenses" ("submitted_by", "paid_at");
CREATE INDEX IF NOT EXISTS "expenses_review_status_created_idx"
  ON "expenses" ("review_status", "created_at");
CREATE INDEX IF NOT EXISTS "expenses_paid_by_member_idx"
  ON "expenses" ("paid_by_member_id");
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_receipt_capture_key"
  ON "expenses" ("receipt_capture_id");
CREATE INDEX IF NOT EXISTS "expenses_appointment_idx"
  ON "expenses" ("appointment_id");

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_payer_shape_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_payer_shape_check" CHECK (
    ("payer_type" = 'company' AND "paid_by_member_id" IS NULL)
    OR ("payer_type" = 'personal' AND "paid_by_member_id" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_payer_shape_check";

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_review_shape_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_review_shape_check" CHECK (
    (
      "review_status" IN ('draft', 'pending')
      AND "reviewed_at" IS NULL
      AND "reviewed_by" IS NULL
      AND "review_reason" IS NULL
    )
    OR (
      "review_status" = 'approved'
      AND "reviewed_at" IS NOT NULL
    )
    OR (
      "review_status" = 'rejected'
      AND "reviewed_at" IS NOT NULL
      AND nullif(btrim("review_reason"), '') IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_review_shape_check";

-- Generated reversals and replacements may be assembled as drafts inside one
-- transaction so their allocation evidence exists before they post. Linked
-- drafts are restricted to the manual-correction source and never escape a
-- successful transaction.
ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_lifecycle_timeline_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_lifecycle_timeline_check" CHECK (
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
      AND "corrected_by_expense_id" IS NULL
      AND (
        ("reversal_of_expense_id" IS NULL AND "correction_of_expense_id" IS NULL)
        OR "source" = 'manual_correction'
      )
    )
    OR (
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
    OR (
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
    OR (
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
ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_lifecycle_timeline_check";

CREATE TABLE IF NOT EXISTS "expense_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "expense_id" uuid NOT NULL REFERENCES "expenses"("id") ON DELETE RESTRICT,
  "category_id" text NOT NULL REFERENCES "expense_categories"("id")
    ON DELETE RESTRICT,
  "amount_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_allocations_amount_check" CHECK ("amount_cents" <> 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_allocations_expense_category_key"
  ON "expense_allocations" ("expense_id", "category_id");
CREATE INDEX IF NOT EXISTS "expense_allocations_category_expense_idx"
  ON "expense_allocations" ("category_id", "expense_id");

INSERT INTO "expense_allocations" ("expense_id", "category_id", "amount_cents")
SELECT expense."id", expense."category_id", expense."amount_cents"
FROM "expenses" AS expense
WHERE expense."category_id" IS NOT NULL
  AND expense."amount_cents" <> 0
ON CONFLICT ("expense_id", "category_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "expense_vendor_category_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "normalized_vendor" text NOT NULL,
  "category_id" text NOT NULL REFERENCES "expense_categories"("id")
    ON DELETE RESTRICT,
  "confirmation_count" integer DEFAULT 0 NOT NULL,
  "disagreement_count" integer DEFAULT 0 NOT NULL,
  "owner_locked" boolean DEFAULT false NOT NULL,
  "locked_by" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "locked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_vendor_category_rules_counts_check" CHECK (
    "confirmation_count" >= 0 AND "disagreement_count" >= 0
  ),
  CONSTRAINT "expense_vendor_category_rules_lock_shape_check" CHECK (
    ("owner_locked" = false AND "locked_at" IS NULL)
    OR ("owner_locked" = true AND "locked_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "expense_vendor_category_rules_vendor_category_key"
  ON "expense_vendor_category_rules" ("normalized_vendor", "category_id");
CREATE INDEX IF NOT EXISTS "expense_vendor_category_rules_vendor_idx"
  ON "expense_vendor_category_rules" ("normalized_vendor");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_vendor_category_rules_owner_lock_key"
  ON "expense_vendor_category_rules" ("normalized_vendor")
  WHERE "owner_locked" = true;

CREATE TABLE IF NOT EXISTS "daily_ad_spend" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platform" "daily_ad_platform" NOT NULL,
  "business_date" date NOT NULL,
  "amount_cents" integer NOT NULL,
  "current_expense_id" uuid REFERENCES "expenses"("id") ON DELETE RESTRICT,
  "entered_by" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "daily_ad_spend_amount_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "daily_ad_spend_pointer_check" CHECK (
    ("amount_cents" = 0 AND "current_expense_id" IS NULL)
    OR ("amount_cents" > 0 AND "current_expense_id" IS NOT NULL)
  ),
  CONSTRAINT "daily_ad_spend_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_ad_spend_platform_date_key"
  ON "daily_ad_spend" ("platform", "business_date");
CREATE INDEX IF NOT EXISTS "daily_ad_spend_date_idx"
  ON "daily_ad_spend" ("business_date");
CREATE UNIQUE INDEX IF NOT EXISTS "daily_ad_spend_current_expense_key"
  ON "daily_ad_spend" ("current_expense_id");

CREATE TABLE IF NOT EXISTS "expense_reimbursement_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "expense_id" uuid NOT NULL REFERENCES "expenses"("id") ON DELETE RESTRICT,
  "member_id" uuid NOT NULL REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "amount_cents" integer NOT NULL,
  "status" "expense_reimbursement_status" DEFAULT 'pending' NOT NULL,
  "reviewed_by" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "review_reason" text,
  "payout_run_id" uuid REFERENCES "payout_runs"("id") ON DELETE RESTRICT,
  "payout_adjustment_id" uuid REFERENCES "payout_run_adjustments"("id")
    ON DELETE RESTRICT,
  "attached_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_reimbursement_claims_amount_check"
    CHECK ("amount_cents" > 0),
  CONSTRAINT "expense_reimbursement_claims_version_check" CHECK ("version" >= 1),
  CONSTRAINT "expense_reimbursement_claims_attachment_shape_check" CHECK (
    (
      "status" IN ('pending', 'approved', 'rejected')
      AND "payout_run_id" IS NULL
      AND "payout_adjustment_id" IS NULL
      AND "attached_at" IS NULL
      AND "paid_at" IS NULL
    )
    OR (
      "status" = 'attached'
      AND "payout_run_id" IS NOT NULL
      AND "payout_adjustment_id" IS NOT NULL
      AND "attached_at" IS NOT NULL
      AND "paid_at" IS NULL
    )
    OR (
      "status" = 'paid'
      AND "payout_run_id" IS NOT NULL
      AND "payout_adjustment_id" IS NOT NULL
      AND "attached_at" IS NOT NULL
      AND "paid_at" IS NOT NULL
    )
  ),
  CONSTRAINT "expense_reimbursement_claims_review_shape_check" CHECK (
    (
      "status" = 'pending'
      AND "reviewed_at" IS NULL
      AND "reviewed_by" IS NULL
      AND "review_reason" IS NULL
    )
    OR ("status" IN ('approved', 'attached', 'paid') AND "reviewed_at" IS NOT NULL)
    OR (
      "status" = 'rejected'
      AND "reviewed_at" IS NOT NULL
      AND nullif(btrim("review_reason"), '') IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_reimbursement_claims_expense_key"
  ON "expense_reimbursement_claims" ("expense_id");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_reimbursement_claims_adjustment_key"
  ON "expense_reimbursement_claims" ("payout_adjustment_id");
CREATE INDEX IF NOT EXISTS "expense_reimbursement_claims_member_status_idx"
  ON "expense_reimbursement_claims" ("member_id", "status");
CREATE INDEX IF NOT EXISTS "expense_reimbursement_claims_status_created_idx"
  ON "expense_reimbursement_claims" ("status", "created_at");

-- Every V2-categorized expense has at least one signed allocation, every line
-- has the same sign as the expense, and the deferred total equals the ledger
-- amount exactly. Deferral allows an expense and its allocations to be written
-- atomically in either statement order.
CREATE OR REPLACE FUNCTION enforce_expense_allocation_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_expense_id uuid;
  expense_amount integer;
  stable_category_id text;
  allocation_count integer;
  allocation_total bigint;
  wrong_sign_count integer;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    target_expense_id := NEW."id";
  ELSE
    target_expense_id := coalesce(NEW."expense_id", OLD."expense_id");
  END IF;

  SELECT expense."amount_cents", expense."category_id"
  INTO expense_amount, stable_category_id
  FROM "expenses" AS expense
  WHERE expense."id" = target_expense_id;

  IF NOT FOUND THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  SELECT
    count(*)::integer,
    coalesce(sum(allocation."amount_cents"), 0),
    count(*) FILTER (
      WHERE (expense_amount > 0 AND allocation."amount_cents" <= 0)
         OR (expense_amount < 0 AND allocation."amount_cents" >= 0)
    )::integer
  INTO allocation_count, allocation_total, wrong_sign_count
  FROM "expense_allocations" AS allocation
  WHERE allocation."expense_id" = target_expense_id;

  IF stable_category_id IS NOT NULL AND allocation_count = 0 THEN
    RAISE EXCEPTION 'categorized expense requires an allocation'
      USING ERRCODE = '23514';
  END IF;

  IF allocation_count > 0 AND allocation_total <> expense_amount THEN
    RAISE EXCEPTION 'expense allocations must exactly equal expense total'
      USING ERRCODE = '23514';
  END IF;

  IF wrong_sign_count > 0 THEN
    RAISE EXCEPTION 'expense allocations must follow expense amount direction'
      USING ERRCODE = '23514';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "expense_allocation_total_on_expense"
  ON "expenses";
CREATE CONSTRAINT TRIGGER "expense_allocation_total_on_expense"
  AFTER INSERT OR UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_allocation_total();

DROP TRIGGER IF EXISTS "expense_allocation_total_on_allocation"
  ON "expense_allocations";
CREATE CONSTRAINT TRIGGER "expense_allocation_total_on_allocation"
  AFTER INSERT OR UPDATE OR DELETE ON "expense_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_allocation_total();

CREATE OR REPLACE FUNCTION enforce_expense_v2_evidence_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."submitted_by" IS NOT NULL OR OLD."receipt_capture_id" IS NOT NULL THEN
      RAISE EXCEPTION 'expense v2 ledger entries cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."lifecycle_status" <> 'draft' AND (
    NEW."category_id" IS DISTINCT FROM OLD."category_id"
    OR NEW."category_needs_review" IS DISTINCT FROM OLD."category_needs_review"
    OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
    OR NEW."payer_type" IS DISTINCT FROM OLD."payer_type"
    OR NEW."paid_by_member_id" IS DISTINCT FROM OLD."paid_by_member_id"
    OR NEW."review_status" IS DISTINCT FROM OLD."review_status"
    OR NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
    OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
    OR NEW."review_reason" IS DISTINCT FROM OLD."review_reason"
    OR NEW."receipt_capture_id" IS DISTINCT FROM OLD."receipt_capture_id"
    OR NEW."appointment_id" IS DISTINCT FROM OLD."appointment_id"
  ) THEN
    RAISE EXCEPTION 'posted expense v2 evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_v2_evidence_guard" ON "expenses";
CREATE TRIGGER "expenses_v2_evidence_guard"
  BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_v2_evidence_immutability();

CREATE OR REPLACE FUNCTION enforce_expense_allocation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_expense_id uuid;
  target_status "expense_lifecycle_status";
BEGIN
  target_expense_id := coalesce(OLD."expense_id", NEW."expense_id");
  IF TG_OP = 'UPDATE' AND NEW."expense_id" IS DISTINCT FROM OLD."expense_id" THEN
    RAISE EXCEPTION 'expense allocation ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  SELECT "lifecycle_status" INTO target_status
  FROM "expenses" WHERE "id" = target_expense_id;
  IF target_status IS DISTINCT FROM 'draft'::"expense_lifecycle_status" THEN
    RAISE EXCEPTION 'posted expense allocations are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "expense_allocations_immutability_guard"
  ON "expense_allocations";
CREATE TRIGGER "expense_allocations_immutability_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "expense_allocations"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_allocation_immutability();

CREATE OR REPLACE FUNCTION enforce_expense_capture_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt capture evidence cannot be deleted'
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
    OR (OLD."status" = 'analyzing' AND NEW."status" IN ('ready', 'failed'))
    OR (OLD."status" = 'ready' AND NEW."status" IN ('confirmed', 'discarded'))
    OR (OLD."status" = 'failed' AND NEW."status" IN ('queued', 'discarded'))
  ) THEN
    RAISE EXCEPTION 'invalid receipt capture status transition'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expense_receipt_capture_transition_guard"
  ON "expense_receipt_captures";
CREATE TRIGGER "expense_receipt_capture_transition_guard"
  BEFORE UPDATE OR DELETE ON "expense_receipt_captures"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_capture_transition();

CREATE OR REPLACE FUNCTION enforce_reimbursement_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reimbursement claims cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'reimbursement claim version must increase by exactly one'
      USING ERRCODE = '40001';
  END IF;
  IF NEW."expense_id" IS DISTINCT FROM OLD."expense_id"
     OR NEW."member_id" IS DISTINCT FROM OLD."member_id"
     OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" THEN
    RAISE EXCEPTION 'reimbursement claim financial evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'attached')
    OR (OLD."status" = 'attached' AND NEW."status" = 'paid')
  ) THEN
    RAISE EXCEPTION 'invalid reimbursement claim transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expense_reimbursement_claim_transition_guard"
  ON "expense_reimbursement_claims";
CREATE TRIGGER "expense_reimbursement_claim_transition_guard"
  BEFORE UPDATE OR DELETE ON "expense_reimbursement_claims"
  FOR EACH ROW EXECUTE FUNCTION enforce_reimbursement_claim_transition();

CREATE OR REPLACE FUNCTION enforce_daily_ad_spend_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'daily ad spend confirmations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."platform" IS DISTINCT FROM OLD."platform"
     OR NEW."business_date" IS DISTINCT FROM OLD."business_date" THEN
    RAISE EXCEPTION 'daily ad spend identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'daily ad spend version must increase by exactly one'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "daily_ad_spend_version_guard" ON "daily_ad_spend";
CREATE TRIGGER "daily_ad_spend_version_guard"
  BEFORE UPDATE OR DELETE ON "daily_ad_spend"
  FOR EACH ROW EXECUTE FUNCTION enforce_daily_ad_spend_version();

COMMENT ON TABLE "expense_categories" IS
  'Stable accounting category registry; labels may change without changing IDs.';
COMMENT ON COLUMN "expenses"."category" IS
  'Original display label retained for legacy compatibility and unknown-label review.';
COMMENT ON COLUMN "expenses"."category_needs_review" IS
  'True when a historical label was preserved because no deterministic alias matched.';
COMMENT ON COLUMN "expense_receipt_captures"."original_object_key" IS
  'Private immutable receipt evidence key; never a public or data URL.';
COMMENT ON TABLE "daily_ad_spend" IS
  'Manual authoritative ad-spend registry; absent row means missing, zero means confirmed zero.';
COMMENT ON TABLE "expense_reimbursement_claims" IS
  'Workflow for reimbursing one existing personal-paid expense without creating another expense.';
