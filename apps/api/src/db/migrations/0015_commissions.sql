-- Commission tracking + payout runs

ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "default_crew_split_bps" integer;

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "salesperson_member_id" uuid REFERENCES "team_members"("id") ON DELETE set null;
CREATE INDEX IF NOT EXISTS "contacts_salesperson_idx" ON "contacts" ("salesperson_member_id");

ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "sold_by_member_id" uuid REFERENCES "team_members"("id") ON DELETE set null;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "marketing_member_id" uuid REFERENCES "team_members"("id") ON DELETE set null;

DO $$ BEGIN
  CREATE TYPE "commission_role" AS ENUM ('sales', 'marketing', 'crew');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "payout_run_status" AS ENUM ('draft', 'locked', 'paid');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "commission_settings" (
  "key" text PRIMARY KEY,
  "timezone" text NOT NULL DEFAULT 'America/New_York',
  "payout_weekday" integer NOT NULL DEFAULT 5,
  "payout_hour" integer NOT NULL DEFAULT 12,
  "payout_minute" integer NOT NULL DEFAULT 0,
  "sales_rate_bps" integer NOT NULL DEFAULT 750,
  "marketing_rate_bps" integer NOT NULL DEFAULT 1000,
  "crew_pool_rate_bps" integer NOT NULL DEFAULT 2500,
  "marketing_member_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "updated_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "appointment_crew_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE cascade,
  "member_id" uuid NOT NULL REFERENCES "team_members"("id") ON DELETE restrict,
  "split_bps" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "appointment_crew_members_appt_idx" ON "appointment_crew_members" ("appointment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_crew_members_unique" ON "appointment_crew_members" ("appointment_id", "member_id");

CREATE TABLE IF NOT EXISTS "appointment_commissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE cascade,
  "member_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "role" "commission_role" NOT NULL,
  "base_cents" integer NOT NULL,
  "amount_cents" integer NOT NULL,
  "meta" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "appointment_commissions_appt_idx" ON "appointment_commissions" ("appointment_id");
CREATE INDEX IF NOT EXISTS "appointment_commissions_member_idx" ON "appointment_commissions" ("member_id");
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_commissions_unique" ON "appointment_commissions" ("appointment_id", "role", "member_id");

CREATE TABLE IF NOT EXISTS "payout_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "timezone" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "scheduled_payout_at" timestamp with time zone NOT NULL,
  "status" "payout_run_status" NOT NULL DEFAULT 'draft',
  "created_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "locked_at" timestamp with time zone,
  "paid_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "payout_runs_period_idx" ON "payout_runs" ("period_start", "period_end");
CREATE INDEX IF NOT EXISTS "payout_runs_status_idx" ON "payout_runs" ("status");

CREATE TABLE IF NOT EXISTS "payout_run_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "payout_run_id" uuid NOT NULL REFERENCES "payout_runs"("id") ON DELETE cascade,
  "member_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "sales_cents" integer NOT NULL DEFAULT 0,
  "marketing_cents" integer NOT NULL DEFAULT 0,
  "crew_cents" integer NOT NULL DEFAULT 0,
  "adjustments_cents" integer NOT NULL DEFAULT 0,
  "total_cents" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_run_lines_run_idx" ON "payout_run_lines" ("payout_run_id");
CREATE INDEX IF NOT EXISTS "payout_run_lines_member_idx" ON "payout_run_lines" ("member_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_run_lines_unique" ON "payout_run_lines" ("payout_run_id", "member_id");

CREATE TABLE IF NOT EXISTS "payout_run_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "payout_run_id" uuid NOT NULL REFERENCES "payout_runs"("id") ON DELETE cascade,
  "member_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "amount_cents" integer NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_run_adjustments_run_idx" ON "payout_run_adjustments" ("payout_run_id");
