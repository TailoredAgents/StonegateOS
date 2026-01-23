CREATE TABLE IF NOT EXISTS "google_ads_conversion_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL,
  "resource_name" text NOT NULL,
  "action_id" text NOT NULL,
  "name" text NOT NULL,
  "category" text,
  "type" text,
  "status" text,
  "raw" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_conversion_actions_unique_idx"
  ON "google_ads_conversion_actions" ("customer_id", "action_id");

CREATE INDEX IF NOT EXISTS "google_ads_conversion_actions_name_idx"
  ON "google_ads_conversion_actions" ("name");

CREATE TABLE IF NOT EXISTS "google_ads_campaign_conversions_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL,
  "date_start" text NOT NULL,
  "campaign_id" text NOT NULL,
  "conversion_action_id" text NOT NULL,
  "conversion_action_name" text,
  "conversions" numeric(12,2) NOT NULL,
  "conversion_value" numeric(12,2) NOT NULL,
  "raw" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_campaign_conversions_daily_unique_idx"
  ON "google_ads_campaign_conversions_daily" ("customer_id", "date_start", "campaign_id", "conversion_action_id");

CREATE INDEX IF NOT EXISTS "google_ads_campaign_conversions_daily_date_idx"
  ON "google_ads_campaign_conversions_daily" ("date_start");

CREATE INDEX IF NOT EXISTS "google_ads_campaign_conversions_daily_campaign_idx"
  ON "google_ads_campaign_conversions_daily" ("campaign_id");
