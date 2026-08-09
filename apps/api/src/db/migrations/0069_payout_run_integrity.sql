-- Expand-first payout-run integrity.
-- Historical duplicates are preserved for reviewed reconciliation; one
-- canonical row per timezone/period is selected and all future application
-- writes claim the same partial unique key.

ALTER TABLE "payout_runs"
  ADD COLUMN IF NOT EXISTS "period_canonical" boolean DEFAULT false NOT NULL;

WITH ranked_periods AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "timezone", "period_start", "period_end"
      ORDER BY
        CASE "status"
          WHEN 'paid' THEN 0
          WHEN 'locked' THEN 1
          ELSE 2
        END,
        "created_at" ASC,
        "id" ASC
    ) AS "period_rank"
  FROM "payout_runs"
)
UPDATE "payout_runs" AS run
SET "period_canonical" = (ranked."period_rank" = 1)
FROM ranked_periods AS ranked
WHERE run."id" = ranked."id";

CREATE UNIQUE INDEX IF NOT EXISTS "payout_runs_canonical_period_key"
  ON "payout_runs" ("timezone", "period_start", "period_end")
  WHERE "period_canonical" = true;

-- Give payroll expenses an explicit, unique foreign-key identity instead of
-- relying on a mutable source/memo convention.
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "payout_run_id" uuid;

WITH payroll_expense_candidates AS (
  SELECT
    expense."id" AS "expense_id",
    run."id" AS "payout_run_id",
    row_number() OVER (
      PARTITION BY run."id"
      ORDER BY expense."created_at" ASC, expense."id" ASC
    ) AS "expense_rank"
  FROM "expenses" AS expense
  INNER JOIN "payout_runs" AS run
    ON expense."source" = 'payout_run'
   AND expense."memo" = ('payout_run:' || run."id"::text)
)
UPDATE "expenses" AS expense
SET "payout_run_id" = candidate."payout_run_id"
FROM payroll_expense_candidates AS candidate
WHERE expense."id" = candidate."expense_id"
  AND candidate."expense_rank" = 1
  AND expense."payout_run_id" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_payout_run_id_payout_runs_id_fk'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_payout_run_id_payout_runs_id_fk"
      FOREIGN KEY ("payout_run_id") REFERENCES "public"."payout_runs"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_payout_run_id_payout_runs_id_fk";

CREATE UNIQUE INDEX IF NOT EXISTS "expenses_payout_run_key"
  ON "expenses" ("payout_run_id");

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_payout_run_source_check";

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_payout_run_source_check"
  CHECK ("payout_run_id" IS NULL OR "source" = 'payout_run') NOT VALID;

ALTER TABLE "expenses"
  VALIDATE CONSTRAINT "expenses_payout_run_source_check";

-- Normalize legacy timelines before enforcing explicit Draft -> Locked -> Paid
-- state invariants.
UPDATE "payout_runs"
SET "locked_at" = NULL, "paid_at" = NULL
WHERE "status" = 'draft';

UPDATE "payout_runs"
SET "locked_at" = coalesce("locked_at", "updated_at", "created_at"),
    "paid_at" = NULL
WHERE "status" = 'locked';

UPDATE "payout_runs"
SET "locked_at" = coalesce("locked_at", "updated_at", "created_at"),
    "paid_at" = coalesce("paid_at", "updated_at", "created_at")
WHERE "status" = 'paid';

ALTER TABLE "payout_runs"
  DROP CONSTRAINT IF EXISTS "payout_runs_status_timeline_check";

ALTER TABLE "payout_runs"
  ADD CONSTRAINT "payout_runs_status_timeline_check"
  CHECK (
    ("status" = 'draft' AND "locked_at" IS NULL AND "paid_at" IS NULL)
    OR
    ("status" = 'locked' AND "locked_at" IS NOT NULL AND "paid_at" IS NULL)
    OR
    ("status" = 'paid' AND "locked_at" IS NOT NULL AND "paid_at" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "payout_runs"
  VALIDATE CONSTRAINT "payout_runs_status_timeline_check";

CREATE OR REPLACE FUNCTION enforce_payout_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'draft' AND NEW."status" NOT IN ('draft', 'locked') THEN
    RAISE EXCEPTION 'invalid payout run transition: draft -> %', NEW."status"
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'locked' AND NEW."status" NOT IN ('locked', 'paid') THEN
    RAISE EXCEPTION 'invalid payout run transition: locked -> %', NEW."status"
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'paid' AND NEW."status" <> 'paid' THEN
    RAISE EXCEPTION 'paid payout runs are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" <> 'draft' AND (
    NEW."timezone" IS DISTINCT FROM OLD."timezone"
    OR NEW."period_start" IS DISTINCT FROM OLD."period_start"
    OR NEW."period_end" IS DISTINCT FROM OLD."period_end"
    OR NEW."scheduled_payout_at" IS DISTINCT FROM OLD."scheduled_payout_at"
    OR NEW."period_canonical" IS DISTINCT FROM OLD."period_canonical"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."locked_at" IS DISTINCT FROM OLD."locked_at"
  ) THEN
    RAISE EXCEPTION 'locked payout run fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'paid'
     AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at" THEN
    RAISE EXCEPTION 'paid payout run timestamps are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "payout_runs_transition_guard" ON "payout_runs";
CREATE TRIGGER "payout_runs_transition_guard"
  BEFORE UPDATE ON "payout_runs"
  FOR EACH ROW EXECUTE FUNCTION enforce_payout_run_transition();

CREATE OR REPLACE FUNCTION enforce_draft_payout_run_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_ids uuid[];
  expected_run_count integer;
  locked_run record;
  locked_run_count integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    run_ids := ARRAY[NEW."payout_run_id"]::uuid[];
  ELSIF TG_OP = 'DELETE' THEN
    run_ids := ARRAY[OLD."payout_run_id"]::uuid[];
  ELSE
    SELECT array_agg(run_id ORDER BY run_id)
    INTO run_ids
    FROM (
      SELECT DISTINCT unnest(
        ARRAY[OLD."payout_run_id", NEW."payout_run_id"]::uuid[]
      ) AS run_id
    ) AS affected_runs;
  END IF;

  expected_run_count := coalesce(array_length(run_ids, 1), 0);

  -- Always lock both the OLD and NEW parent in UUID order. This prevents a
  -- child from escaping a locked run by being moved to a draft run and keeps
  -- concurrent cross-run edits from deadlocking on opposite lock order.
  FOR locked_run IN
    SELECT "id", "status"
    FROM "payout_runs"
    WHERE "id" = ANY(run_ids)
    ORDER BY "id"
    FOR UPDATE
  LOOP
    locked_run_count := locked_run_count + 1;
    IF locked_run."status" IS DISTINCT FROM 'draft'::"payout_run_status" THEN
      RAISE EXCEPTION 'locked or paid payout run children are immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF locked_run_count <> expected_run_count THEN
    RAISE EXCEPTION 'payout run parent missing during child mutation'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "payout_run_lines_draft_guard" ON "payout_run_lines";
CREATE TRIGGER "payout_run_lines_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payout_run_lines"
  FOR EACH ROW EXECUTE FUNCTION enforce_draft_payout_run_child();

DROP TRIGGER IF EXISTS "payout_run_adjustments_draft_guard" ON "payout_run_adjustments";
CREATE TRIGGER "payout_run_adjustments_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payout_run_adjustments"
  FOR EACH ROW EXECUTE FUNCTION enforce_draft_payout_run_child();

CREATE OR REPLACE FUNCTION enforce_posted_payout_expense_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status "payout_run_status";
BEGIN
  IF OLD."payout_run_id" IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT "status"
  INTO run_status
  FROM "payout_runs"
  WHERE "id" = OLD."payout_run_id"
  FOR UPDATE;

  IF run_status IS DISTINCT FROM 'draft'::"payout_run_status" THEN
    RAISE EXCEPTION 'posted payout payroll expenses are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expenses_posted_payout_guard" ON "expenses";
CREATE TRIGGER "expenses_posted_payout_guard"
  BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION enforce_posted_payout_expense_immutable();

COMMENT ON COLUMN "payout_runs"."period_canonical" IS
  'Expand-phase unique representative for a timezone and payout period; historical duplicate rows remain reviewable.';

COMMENT ON COLUMN "expenses"."payout_run_id" IS
  'Unique immutable link from a payroll expense to its payout run.';
