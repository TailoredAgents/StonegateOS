ALTER TABLE "payout_run_adjustments"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "expense_id" uuid;

DO $$
BEGIN
  ALTER TABLE "payout_run_adjustments"
    ADD CONSTRAINT "payout_run_adjustments_expense_id_expenses_id_fk"
    FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "payout_run_adjustments_expense_idx"
  ON "payout_run_adjustments" USING btree ("expense_id");
