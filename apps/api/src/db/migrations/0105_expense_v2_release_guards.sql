-- Forward-only release guards added after the initial Expense V2 expansion.
-- Keeping these out of 0102 ensures already-migrated environments receive the
-- same constraints without rewriting applied migration history.

ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_review_lifecycle_check";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_review_lifecycle_check" CHECK (
    "lifecycle_status" = 'draft' OR "review_status" = 'approved'
  ) NOT VALID;
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_review_lifecycle_check";

-- These deferred link checks let the daily-ad correction transaction move the
-- registry pointer and correct the prior ledger row in either statement order,
-- while rejecting any final state where a current pointer is stale or voided.
CREATE OR REPLACE FUNCTION enforce_daily_ad_spend_expense_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A row can be updated more than once while one ad-save transaction replaces
  -- and then clears its pointer. Deferred row triggers retain the NEW snapshot
  -- from each statement, so always validate the registry's committed candidate
  -- state instead of that stale snapshot.
  IF EXISTS (
    SELECT 1
    FROM "daily_ad_spend" AS entry
    WHERE entry."id" = NEW."id"
      AND entry."current_expense_id" IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1
    FROM "daily_ad_spend" AS entry
    JOIN "expenses" AS expense
      ON expense."id" = entry."current_expense_id"
    WHERE entry."id" = NEW."id"
      AND expense."lifecycle_status" = 'posted'
      AND expense."review_status" = 'approved'
      AND expense."reversal_of_expense_id" IS NULL
      AND expense."source" IN ('daily_ad_spend', 'manual_correction')
      AND expense."category_id" = 'advertising'
      AND expense."payer_type" = 'company'
      AND expense."vendor" = CASE entry."platform"
        WHEN 'facebook' THEN 'Meta Ads'
        WHEN 'google' THEN 'Google Ads'
      END
      AND expense."amount_cents" = entry."amount_cents"
      AND (expense."paid_at" AT TIME ZONE 'America/New_York')::date
        = entry."business_date"
  ) THEN
    RAISE EXCEPTION 'daily ad spend pointer must reference its current posted expense'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "daily_ad_spend_expense_link_guard" ON "daily_ad_spend";
CREATE CONSTRAINT TRIGGER "daily_ad_spend_expense_link_guard"
  AFTER INSERT OR UPDATE ON "daily_ad_spend"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_daily_ad_spend_expense_link();

CREATE OR REPLACE FUNCTION enforce_current_daily_ad_expense_posted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lifecycle_status" <> 'posted' AND EXISTS (
    SELECT 1
    FROM "daily_ad_spend" AS entry
    WHERE entry."current_expense_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'current daily ad expense must remain posted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "current_daily_ad_expense_posted_guard" ON "expenses";
CREATE CONSTRAINT TRIGGER "current_daily_ad_expense_posted_guard"
  AFTER UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_current_daily_ad_expense_posted();

-- Crew can use only the submitter-scoped V2 routes. Remove the legacy global
-- ledger and direct mutation capabilities installed by the old baseline.
UPDATE "team_roles"
SET "permissions" = array_remove(
      array_remove(coalesce("permissions", ARRAY[]::text[]), 'expenses.read'),
      'expenses.write'
    ),
    "updated_at" = now()
WHERE lower(trim("slug")) = 'crew';
