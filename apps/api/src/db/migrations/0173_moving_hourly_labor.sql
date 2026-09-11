ALTER TABLE appointment_crew_members
  ADD COLUMN hourly_rate_cents integer,
  ADD COLUMN worked_minutes integer;
--> statement-breakpoint
ALTER TABLE appointment_crew_members
  ADD CONSTRAINT appointment_crew_members_hourly_labor_check CHECK (
    (hourly_rate_cents IS NULL AND worked_minutes IS NULL)
    OR (
      hourly_rate_cents IS NOT NULL AND worked_minutes IS NOT NULL
      AND hourly_rate_cents > 0 AND worked_minutes > 0 AND worked_minutes <= 525600
      AND round(hourly_rate_cents::numeric * worked_minutes / 60) <= 2147483647
      AND split_bps = 0 AND fixed_job_rate_bps IS NULL
    )
  );
--> statement-breakpoint
ALTER TABLE payout_run_lines ADD COLUMN labor_details jsonb;
