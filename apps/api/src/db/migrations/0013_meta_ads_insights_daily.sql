CREATE TABLE IF NOT EXISTS "meta_ads_insights_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" text NOT NULL,
  "level" text NOT NULL,
  "entity_id" text NOT NULL,
  "date_start" text NOT NULL,
  "date_stop" text,
  "currency" varchar(10),
  "campaign_id" text,
  "campaign_name" text,
  "adset_id" text,
  "adset_name" text,
  "ad_id" text,
  "ad_name" text,
  "impressions" integer NOT NULL,
  "clicks" integer NOT NULL,
  "reach" integer NOT NULL,
  "spend" numeric(12,2) NOT NULL,
  "raw" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_ads_insights_unique_idx"
  ON "meta_ads_insights_daily" ("account_id", "level", "entity_id", "date_start");

CREATE INDEX IF NOT EXISTS "meta_ads_insights_date_idx" ON "meta_ads_insights_daily" ("date_start");
CREATE INDEX IF NOT EXISTS "meta_ads_insights_campaign_idx" ON "meta_ads_insights_daily" ("campaign_id");
CREATE INDEX IF NOT EXISTS "meta_ads_insights_adset_idx" ON "meta_ads_insights_daily" ("adset_id");
CREATE INDEX IF NOT EXISTS "meta_ads_insights_ad_idx" ON "meta_ads_insights_daily" ("ad_id");

