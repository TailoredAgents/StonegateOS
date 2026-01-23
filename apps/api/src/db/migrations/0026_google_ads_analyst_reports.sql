CREATE TABLE IF NOT EXISTS "google_ads_analyst_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "range_days" integer NOT NULL,
  "since" text NOT NULL,
  "until" text NOT NULL,
  "call_weight" numeric(4,3) NOT NULL,
  "booking_weight" numeric(4,3) NOT NULL,
  "report" jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "google_ads_analyst_reports_created_at_idx"
  ON "google_ads_analyst_reports" ("created_at");

CREATE INDEX IF NOT EXISTS "google_ads_analyst_reports_range_idx"
  ON "google_ads_analyst_reports" ("since", "until");

