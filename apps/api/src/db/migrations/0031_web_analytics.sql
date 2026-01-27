CREATE TABLE IF NOT EXISTS "web_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" text NOT NULL,
  "visit_id" text NOT NULL,
  "event" text NOT NULL,
  "path" text NOT NULL,
  "key" text,
  "referrer_domain" text,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_term" text,
  "utm_content" text,
  "device" text,
  "in_area_bucket" text,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "web_events_created_at_idx" ON "web_events" ("created_at");
CREATE INDEX IF NOT EXISTS "web_events_event_idx" ON "web_events" ("event");
CREATE INDEX IF NOT EXISTS "web_events_path_idx" ON "web_events" ("path");
CREATE INDEX IF NOT EXISTS "web_events_session_idx" ON "web_events" ("session_id");

CREATE TABLE IF NOT EXISTS "web_event_counts_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "date_start" text NOT NULL,
  "event" text NOT NULL,
  "path" text NOT NULL,
  "key" text NOT NULL DEFAULT '',
  "device" text NOT NULL DEFAULT '',
  "in_area_bucket" text NOT NULL DEFAULT '',
  "utm_source" text NOT NULL DEFAULT '',
  "utm_medium" text NOT NULL DEFAULT '',
  "utm_campaign" text NOT NULL DEFAULT '',
  "utm_term" text NOT NULL DEFAULT '',
  "utm_content" text NOT NULL DEFAULT '',
  "count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "web_event_counts_daily_unique_idx"
  ON "web_event_counts_daily" (
    "date_start",
    "event",
    "path",
    "key",
    "device",
    "in_area_bucket",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content"
  );

CREATE INDEX IF NOT EXISTS "web_event_counts_daily_date_idx" ON "web_event_counts_daily" ("date_start");
CREATE INDEX IF NOT EXISTS "web_event_counts_daily_event_idx" ON "web_event_counts_daily" ("event");
CREATE INDEX IF NOT EXISTS "web_event_counts_daily_path_idx" ON "web_event_counts_daily" ("path");

CREATE TABLE IF NOT EXISTS "web_vitals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" text NOT NULL,
  "visit_id" text NOT NULL,
  "path" text NOT NULL,
  "metric" text NOT NULL,
  "value" double precision NOT NULL,
  "rating" text,
  "device" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "web_vitals_created_at_idx" ON "web_vitals" ("created_at");
CREATE INDEX IF NOT EXISTS "web_vitals_path_metric_idx" ON "web_vitals" ("path", "metric");
