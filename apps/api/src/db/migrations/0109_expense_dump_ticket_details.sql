-- Human-confirmed operational facts from dump/scale-ticket receipts.
--
-- Receipt-model output remains immutable capture evidence. Only values a team
-- member reviews are attached to the financial ledger through this table.
-- Existing dump expenses are deliberately not guessed or backfilled.

CREATE TABLE IF NOT EXISTS "expense_dump_details" (
  "expense_id" uuid PRIMARY KEY REFERENCES "expenses"("id")
    ON DELETE RESTRICT,
  "weight_status" text NOT NULL,
  "facility_name" text,
  "ticket_number" text,
  "material" text,
  "gross_weight_pounds" integer,
  "tare_weight_pounds" integer,
  "net_weight_pounds" integer,
  "billed_weight_milli_tons" integer,
  "unit_rate_cents_per_ton" integer,
  "confirmed_by" uuid NOT NULL REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_dump_details_weight_status_check"
    CHECK ("weight_status" IN ('confirmed', 'unreadable')),
  CONSTRAINT "expense_dump_details_weight_shape_check" CHECK (
    (
      "weight_status" = 'confirmed'
      AND "net_weight_pounds" BETWEEN 1 AND 10000000
    )
    OR (
      "weight_status" = 'unreadable'
      AND "net_weight_pounds" IS NULL
    )
  ),
  CONSTRAINT "expense_dump_details_gross_weight_check" CHECK (
    "gross_weight_pounds" IS NULL
    OR "gross_weight_pounds" BETWEEN 1 AND 10000000
  ),
  CONSTRAINT "expense_dump_details_tare_weight_check" CHECK (
    "tare_weight_pounds" IS NULL
    OR "tare_weight_pounds" BETWEEN 0 AND 10000000
  ),
  CONSTRAINT "expense_dump_details_gross_tare_check" CHECK (
    "gross_weight_pounds" IS NULL
    OR "tare_weight_pounds" IS NULL
    OR "gross_weight_pounds" >= "tare_weight_pounds"
  ),
  CONSTRAINT "expense_dump_details_billed_weight_check" CHECK (
    "billed_weight_milli_tons" IS NULL
    OR "billed_weight_milli_tons" BETWEEN 0 AND 10000000
  ),
  CONSTRAINT "expense_dump_details_unit_rate_check" CHECK (
    "unit_rate_cents_per_ton" IS NULL
    OR "unit_rate_cents_per_ton" BETWEEN 0 AND 100000000
  ),
  CONSTRAINT "expense_dump_details_facility_name_check" CHECK (
    "facility_name" IS NULL
    OR char_length(btrim("facility_name")) BETWEEN 1 AND 240
  ),
  CONSTRAINT "expense_dump_details_ticket_number_check" CHECK (
    "ticket_number" IS NULL
    OR char_length(btrim("ticket_number")) BETWEEN 1 AND 120
  ),
  CONSTRAINT "expense_dump_details_material_check" CHECK (
    "material" IS NULL
    OR char_length(btrim("material")) BETWEEN 1 AND 240
  )
);

CREATE INDEX IF NOT EXISTS "expense_dump_details_ticket_lookup_idx"
  ON "expense_dump_details" ("facility_name", "ticket_number");
CREATE INDEX IF NOT EXISTS "expense_dump_details_confirmed_at_idx"
  ON "expense_dump_details" ("confirmed_at");

-- Confirmed facts can be installed or adjusted while a submission is still a
-- draft. Once the owning expense posts, corrections must create a replacement
-- ledger row and a new one-to-one detail row rather than rewriting evidence.
CREATE OR REPLACE FUNCTION enforce_expense_dump_details_draft_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_expense_id uuid;
  target_lifecycle_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."expense_id" IS DISTINCT FROM OLD."expense_id" THEN
    RAISE EXCEPTION 'dump-ticket fact identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  target_expense_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."expense_id"
    ELSE NEW."expense_id"
  END;

  SELECT "lifecycle_status"::text
  INTO target_lifecycle_status
  FROM "expenses"
  WHERE "id" = target_expense_id
  FOR UPDATE;

  IF target_lifecycle_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'posted dump-ticket facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "expense_dump_details_draft_guard"
  ON "expense_dump_details";
CREATE TRIGGER "expense_dump_details_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "expense_dump_details"
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_dump_details_draft_only();

-- A dump-ticket fact must remain attached to an explicit positive Dump Fees
-- allocation. Deferral lets submission/correction code install the expense,
-- its allocations, and its detail row in whichever safe order it needs.
CREATE OR REPLACE FUNCTION enforce_expense_dump_allocation_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_expense_id uuid;
  candidate_expense_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'expense_dump_details' THEN
    candidate_expense_ids := ARRAY[NEW."expense_id"];
  ELSIF TG_OP = 'INSERT' THEN
    candidate_expense_ids := ARRAY[NEW."expense_id"];
  ELSIF TG_OP = 'DELETE' THEN
    candidate_expense_ids := ARRAY[OLD."expense_id"];
  ELSE
    candidate_expense_ids := ARRAY[OLD."expense_id", NEW."expense_id"];
  END IF;

  FOREACH candidate_expense_id IN ARRAY candidate_expense_ids
  LOOP
    CONTINUE WHEN candidate_expense_id IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1
      FROM "expense_dump_details"
      WHERE "expense_id" = candidate_expense_id
    );

    IF NOT EXISTS (
      SELECT 1
      FROM "expense_allocations"
      WHERE "expense_id" = candidate_expense_id
        AND "category_id" = 'dump_fees'
        AND "amount_cents" > 0
    ) THEN
      RAISE EXCEPTION 'dump-ticket facts require a positive Dump Fees allocation'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "expense_dump_details_allocation_guard"
  ON "expense_dump_details";
CREATE CONSTRAINT TRIGGER "expense_dump_details_allocation_guard"
  AFTER INSERT OR UPDATE ON "expense_dump_details"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_dump_allocation_link();

DROP TRIGGER IF EXISTS "expense_dump_allocations_link_guard"
  ON "expense_allocations";
CREATE CONSTRAINT TRIGGER "expense_dump_allocations_link_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "expense_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_dump_allocation_link();
