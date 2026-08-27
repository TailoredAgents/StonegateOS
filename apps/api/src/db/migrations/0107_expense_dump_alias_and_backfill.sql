-- `Dump` is the historical label used by both the desktop and older mobile
-- manual-expense forms. Add it through a forward migration, then repair rows
-- which 0102 deliberately left unverified because no explicit alias existed.
INSERT INTO "expense_category_aliases"
  ("category_id", "alias", "normalized_alias")
VALUES ('dump_fees', 'Dump', 'dump')
ON CONFLICT ("normalized_alias") DO UPDATE SET
  "category_id" = EXCLUDED."category_id",
  "alias" = EXCLUDED."alias";

LOCK TABLE "expenses" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "expense_allocations" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "expenses"
  DISABLE TRIGGER "expenses_lifecycle_transition_guard";
ALTER TABLE "expense_allocations"
  DISABLE TRIGGER "expense_allocations_immutability_guard";

UPDATE "expenses"
SET
  "category_id" = 'dump_fees',
  "category_needs_review" = false
WHERE "category_id" IS NULL
  AND lower(btrim(regexp_replace("category", '[^a-zA-Z0-9]+', ' ', 'g')))
    = 'dump';

INSERT INTO "expense_allocations" ("expense_id", "category_id", "amount_cents")
SELECT "id", 'dump_fees', "amount_cents"
FROM "expenses"
WHERE "category_id" = 'dump_fees'
  AND "amount_cents" <> 0
ON CONFLICT ("expense_id", "category_id") DO NOTHING;

ALTER TABLE "expense_allocations"
  ENABLE TRIGGER "expense_allocations_immutability_guard";
ALTER TABLE "expenses"
  ENABLE TRIGGER "expenses_lifecycle_transition_guard";
