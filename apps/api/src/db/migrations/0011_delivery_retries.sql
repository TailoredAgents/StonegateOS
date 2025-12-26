ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_error" text;

CREATE INDEX IF NOT EXISTS "outbox_events_next_attempt_idx" ON "outbox_events" ("next_attempt_at");

CREATE TABLE IF NOT EXISTS "provider_health" (
  "provider" text PRIMARY KEY,
  "last_success_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_failure_detail" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
