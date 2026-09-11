-- New completions snapshot the crew-size labor pool and equal weights.
-- NULL preserves historical percentage splits and guarantees on recalculation.
ALTER TABLE "appointment_crew_members"
  ADD COLUMN IF NOT EXISTS "pool_rate_bps" integer;

ALTER TABLE "appointment_crew_members"
  ADD CONSTRAINT "appointment_crew_members_dynamic_labor_check"
  CHECK (
    "pool_rate_bps" IS NULL
    OR (
      "pool_rate_bps" IN (2000, 3000)
      AND "split_bps" = 1
      AND "fixed_job_rate_bps" IS NULL
      AND "hourly_rate_cents" IS NULL
      AND "worked_minutes" IS NULL
    )
  );

COMMENT ON COLUMN "appointment_crew_members"."pool_rate_bps" IS
  'Completion-time crew labor pool: 2000 for 1-2 people, 3000 for 3+ people, split equally. NULL retains legacy percentage or hourly compensation.';
