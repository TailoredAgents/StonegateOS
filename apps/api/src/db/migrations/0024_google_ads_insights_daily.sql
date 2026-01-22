CREATE TABLE IF NOT EXISTS "google_ads_insights_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL,
  "date_start" text NOT NULL,
  "campaign_id" text NOT NULL,
  "campaign_name" text,
  "impressions" integer NOT NULL,
  "clicks" integer NOT NULL,
  "cost" numeric(12,2) NOT NULL,
  "conversions" numeric(12,2) NOT NULL,
  "conversion_value" numeric(12,2) NOT NULL,
  "raw" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_insights_daily_unique_idx"
  ON "google_ads_insights_daily" ("customer_id", "date_start", "campaign_id");

CREATE INDEX IF NOT EXISTS "google_ads_insights_daily_date_idx"
  ON "google_ads_insights_daily" ("date_start");

CREATE INDEX IF NOT EXISTS "google_ads_insights_daily_campaign_idx"
  ON "google_ads_insights_daily" ("campaign_id");

CREATE TABLE IF NOT EXISTS "google_ads_search_terms_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" text NOT NULL,
  "date_start" text NOT NULL,
  "campaign_id" text NOT NULL,
  "ad_group_id" text NOT NULL,
  "search_term" text NOT NULL,
  "impressions" integer NOT NULL,
  "clicks" integer NOT NULL,
  "cost" numeric(12,2) NOT NULL,
  "conversions" numeric(12,2) NOT NULL,
  "conversion_value" numeric(12,2) NOT NULL,
  "raw" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_search_terms_daily_unique_idx"
  ON "google_ads_search_terms_daily" ("customer_id", "date_start", "campaign_id", "ad_group_id", "search_term");

CREATE INDEX IF NOT EXISTS "google_ads_search_terms_daily_date_idx"
  ON "google_ads_search_terms_daily" ("date_start");

CREATE INDEX IF NOT EXISTS "google_ads_search_terms_daily_campaign_idx"
  ON "google_ads_search_terms_daily" ("campaign_id");

CREATE INDEX IF NOT EXISTS "google_ads_search_terms_daily_ad_group_idx"
  ON "google_ads_search_terms_daily" ("ad_group_id");

