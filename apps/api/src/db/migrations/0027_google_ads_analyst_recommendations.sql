CREATE TABLE IF NOT EXISTS "google_ads_analyst_recommendations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "report_id" uuid NOT NULL REFERENCES "google_ads_analyst_reports" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "payload" jsonb NOT NULL,
  "decided_by" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "google_ads_analyst_recs_report_idx"
  ON "google_ads_analyst_recommendations" ("report_id", "created_at");

CREATE INDEX IF NOT EXISTS "google_ads_analyst_recs_status_idx"
  ON "google_ads_analyst_recommendations" ("status", "created_at");
