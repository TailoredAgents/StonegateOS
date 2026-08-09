CREATE TABLE IF NOT EXISTS "team_auth_rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bucket" text NOT NULL,
  "key_hash" text NOT NULL,
  "count" integer DEFAULT 1 NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_auth_rate_limits_count_positive" CHECK ("count" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_auth_rate_limits_bucket_key"
  ON "team_auth_rate_limits" ("bucket", "key_hash");

CREATE INDEX IF NOT EXISTS "team_auth_rate_limits_reset_idx"
  ON "team_auth_rate_limits" ("reset_at");
