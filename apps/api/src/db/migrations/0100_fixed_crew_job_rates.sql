-- A member-level guaranteed labor rate is a percentage of the completed job
-- total, not a relative weight in the shared crew pool. Snapshot that rate on
-- completion so later roster changes never rewrite historical commissions.

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "fixed_crew_job_rate_bps" integer;

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_fixed_crew_job_rate_bps_check";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_fixed_crew_job_rate_bps_check"
  CHECK (
    "fixed_crew_job_rate_bps" IS NULL
    OR "fixed_crew_job_rate_bps" BETWEEN 0 AND 10000
  );

ALTER TABLE "appointment_crew_members"
  ADD COLUMN IF NOT EXISTS "fixed_job_rate_bps" integer;

ALTER TABLE "appointment_crew_members"
  DROP CONSTRAINT IF EXISTS "appointment_crew_members_fixed_job_rate_bps_check";

ALTER TABLE "appointment_crew_members"
  ADD CONSTRAINT "appointment_crew_members_fixed_job_rate_bps_check"
  CHECK (
    "fixed_job_rate_bps" IS NULL
    OR "fixed_job_rate_bps" BETWEEN 0 AND 10000
  );

COMMENT ON COLUMN "team_members"."fixed_crew_job_rate_bps" IS
  'Guaranteed crew commission as basis points of completed job total.';

COMMENT ON COLUMN "appointment_crew_members"."fixed_job_rate_bps" IS
  'Immutable completion-time snapshot of a guaranteed crew job rate.';
