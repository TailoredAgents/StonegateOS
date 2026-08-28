-- Owner-verified recurring fixed costs for Expense Tracking V2.
--
-- Fixed costs are stored as append-only, effective-dated facts. Weekly
-- reporting accrues them virtually by Eastern calendar day; the ledger and
-- History remain free of synthetic daily rows.

CREATE TABLE IF NOT EXISTS "expense_fixed_cost_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_by" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "expense_fixed_cost_series_created_idx"
  ON "expense_fixed_cost_series" ("created_at", "id");

CREATE TABLE IF NOT EXISTS "expense_fixed_cost_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "series_id" uuid NOT NULL REFERENCES "expense_fixed_cost_series"("id")
    ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "category_id" text NOT NULL REFERENCES "expense_categories"("id")
    ON DELETE RESTRICT,
  "monthly_amount_cents" integer NOT NULL,
  "effective_start_date" date NOT NULL,
  "state" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_fixed_cost_versions_version_check"
    CHECK ("version" >= 1),
  CONSTRAINT "expense_fixed_cost_versions_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "expense_fixed_cost_versions_amount_check"
    CHECK ("monthly_amount_cents" BETWEEN 1 AND 100000000),
  CONSTRAINT "expense_fixed_cost_versions_state_check"
    CHECK ("state" IN ('active', 'ended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "expense_fixed_cost_versions_series_version_key"
  ON "expense_fixed_cost_versions" ("series_id", "version");
CREATE INDEX IF NOT EXISTS
  "expense_fixed_cost_versions_effective_lookup_idx"
  ON "expense_fixed_cost_versions"
    ("series_id", "effective_start_date", "version");
CREATE INDEX IF NOT EXISTS
  "expense_fixed_cost_versions_category_effective_idx"
  ON "expense_fixed_cost_versions" ("category_id", "effective_start_date");

CREATE OR REPLACE FUNCTION enforce_expense_fixed_cost_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fixed cost accounting records are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS "expense_fixed_cost_series_append_only_guard"
  ON "expense_fixed_cost_series";
CREATE TRIGGER "expense_fixed_cost_series_append_only_guard"
  BEFORE UPDATE OR DELETE ON "expense_fixed_cost_series"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_fixed_cost_append_only();

DROP TRIGGER IF EXISTS "expense_fixed_cost_versions_append_only_guard"
  ON "expense_fixed_cost_versions";
CREATE TRIGGER "expense_fixed_cost_versions_append_only_guard"
  BEFORE UPDATE OR DELETE ON "expense_fixed_cost_versions"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_fixed_cost_append_only();

CREATE OR REPLACE FUNCTION enforce_expense_fixed_cost_version_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_version integer;
  latest_effective_start date;
  latest_state text;
BEGIN
  SELECT
    version,
    effective_start_date,
    state
  INTO
    latest_version,
    latest_effective_start,
    latest_state
  FROM "expense_fixed_cost_versions"
  WHERE "series_id" = NEW."series_id"
  ORDER BY "version" DESC
  LIMIT 1;

  IF latest_version IS NULL THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'first fixed cost version must be one'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    IF NEW."version" <> latest_version + 1 THEN
      RAISE EXCEPTION 'fixed cost version must increase by exactly one'
        USING ERRCODE = '40001';
    END IF;
    IF NEW."effective_start_date" < latest_effective_start THEN
      RAISE EXCEPTION 'fixed cost effective dates cannot move backward'
        USING ERRCODE = '22007';
    END IF;
    IF latest_state = 'ended' THEN
      RAISE EXCEPTION 'an ended fixed cost cannot be revised'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expense_fixed_cost_versions_sequence_guard"
  ON "expense_fixed_cost_versions";
CREATE TRIGGER "expense_fixed_cost_versions_sequence_guard"
  BEFORE INSERT ON "expense_fixed_cost_versions"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_fixed_cost_version_sequence();

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "covered_by_fixed_cost_series_id" uuid;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_covered_by_fixed_cost_series_id_fkey'
      AND conrelid = 'expenses'::regclass
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_covered_by_fixed_cost_series_id_fkey"
      FOREIGN KEY ("covered_by_fixed_cost_series_id")
      REFERENCES "expense_fixed_cost_series"("id")
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_fixed_cost_coverage_shape_check'
      AND conrelid = 'expenses'::regclass
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_fixed_cost_coverage_shape_check"
      CHECK (
        "covered_by_fixed_cost_series_id" IS NULL
        OR (
          "review_status" = 'approved'
          AND "reversal_of_expense_id" IS NULL
          AND "amount_cents" > 0
        )
      );
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS "expenses_covered_by_fixed_cost_series_idx"
  ON "expenses" ("covered_by_fixed_cost_series_id", "paid_at");

CREATE OR REPLACE FUNCTION enforce_expense_fixed_cost_coverage_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."covered_by_fixed_cost_series_id" IS NOT DISTINCT FROM
     OLD."covered_by_fixed_cost_series_id" THEN
    RETURN NEW;
  END IF;

  -- Review is the only workflow allowed to establish or clear coverage on an
  -- existing row. Once posted, a change requires an immutable correction.
  IF OLD."lifecycle_status" <> 'draft'
     OR NEW."lifecycle_status" = 'draft' THEN
    RAISE EXCEPTION 'fixed cost coverage is immutable outside expense approval'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_fixed_cost_coverage_immutability_guard"
  ON "expenses";
CREATE TRIGGER "expenses_fixed_cost_coverage_immutability_guard"
  BEFORE UPDATE ON "expenses"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_expense_fixed_cost_coverage_immutability();

CREATE OR REPLACE FUNCTION enforce_expense_fixed_cost_coverage_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expense_business_date date;
  schedule_state text;
  schedule_amount integer;
  schedule_category text;
  allocation_count integer;
  matching_allocation_count integer;
  monthly_coverage_count integer;
BEGIN
  IF NEW."covered_by_fixed_cost_series_id" IS NULL THEN
    RETURN NEW;
  END IF;

  expense_business_date :=
    (NEW."paid_at" AT TIME ZONE 'America/New_York')::date;

  SELECT
    "state",
    "monthly_amount_cents",
    "category_id"
  INTO
    schedule_state,
    schedule_amount,
    schedule_category
  FROM "expense_fixed_cost_versions"
  WHERE "series_id" = NEW."covered_by_fixed_cost_series_id"
    AND "effective_start_date" <= expense_business_date
  ORDER BY "effective_start_date" DESC, "version" DESC
  LIMIT 1;

  IF NOT FOUND OR schedule_state <> 'active' THEN
    RAISE EXCEPTION 'linked fixed cost is not active on the expense purchase date'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."amount_cents" <> schedule_amount THEN
    RAISE EXCEPTION 'linked expense amount does not match its fixed cost schedule'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."category_id" IS DISTINCT FROM schedule_category THEN
    RAISE EXCEPTION 'linked expense category does not match its fixed cost schedule'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE "category_id" = schedule_category
        AND "amount_cents" = schedule_amount
    )::integer
  INTO allocation_count, matching_allocation_count
  FROM "expense_allocations"
  WHERE "expense_id" = NEW."id";

  IF allocation_count <> 1 OR matching_allocation_count <> 1 THEN
    RAISE EXCEPTION 'linked expense must have one exact fixed cost allocation'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
  INTO monthly_coverage_count
  FROM "expenses" AS covered_expense
  WHERE covered_expense."covered_by_fixed_cost_series_id" =
      NEW."covered_by_fixed_cost_series_id"
    AND covered_expense."lifecycle_status" = 'posted'
    AND covered_expense."review_status" = 'approved'
    AND covered_expense."reversal_of_expense_id" IS NULL
    AND date_trunc(
      'month',
      covered_expense."paid_at" AT TIME ZONE 'America/New_York'
    ) = date_trunc(
      'month',
      NEW."paid_at" AT TIME ZONE 'America/New_York'
    );

  IF monthly_coverage_count > 1 THEN
    RAISE EXCEPTION 'fixed cost already has linked expense evidence for the month'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_fixed_cost_coverage_guard" ON "expenses";
CREATE CONSTRAINT TRIGGER "expenses_fixed_cost_coverage_guard"
  AFTER INSERT OR UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_fixed_cost_coverage_link();

CREATE OR REPLACE FUNCTION enforce_fixed_cost_revision_coverage_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "expenses" AS expense
    WHERE expense."covered_by_fixed_cost_series_id" = NEW."series_id"
      AND expense."lifecycle_status" = 'posted'
      AND expense."reversal_of_expense_id" IS NULL
      AND (
        expense."paid_at" AT TIME ZONE 'America/New_York'
      )::date >= NEW."effective_start_date"
      AND (
        NEW."state" <> 'active'
        OR expense."amount_cents" <> NEW."monthly_amount_cents"
        OR expense."category_id" IS DISTINCT FROM NEW."category_id"
        OR (
          SELECT count(*)
          FROM "expense_allocations" AS allocation
          WHERE allocation."expense_id" = expense."id"
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM "expense_allocations" AS allocation
          WHERE allocation."expense_id" = expense."id"
            AND allocation."category_id" = NEW."category_id"
            AND allocation."amount_cents" = NEW."monthly_amount_cents"
        )
      )
  ) THEN
    RAISE EXCEPTION 'fixed cost revision would invalidate a linked expense'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expense_fixed_cost_revision_coverage_guard"
  ON "expense_fixed_cost_versions";
CREATE CONSTRAINT TRIGGER "expense_fixed_cost_revision_coverage_guard"
  AFTER INSERT ON "expense_fixed_cost_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_fixed_cost_revision_coverage_links();

COMMENT ON TABLE "expense_fixed_cost_series" IS
  'Stable identities for owner-verified recurring monthly overhead.';
COMMENT ON TABLE "expense_fixed_cost_versions" IS
  'Append-only effective-dated monthly cost facts accrued virtually by Eastern business date.';
COMMENT ON COLUMN "expense_fixed_cost_versions"."effective_start_date" IS
  'Inclusive Eastern business date on which this version becomes authoritative.';
COMMENT ON COLUMN "expenses"."covered_by_fixed_cost_series_id" IS
  'Owner-verified evidence already represented by virtual fixed-cost accrual; excluded from ordinary Overview expenses.';
