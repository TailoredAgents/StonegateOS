CREATE TYPE "public"."conversation_state" AS ENUM (
  'new',
  'qualifying',
  'photos_received',
  'estimated',
  'offered_times',
  'booked',
  'reminder',
  'completed',
  'review'
);

ALTER TABLE "conversation_threads"
  ADD COLUMN IF NOT EXISTS "state" "conversation_state" NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS "state_updated_at" timestamp with time zone NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "conversation_threads_state_idx" ON "conversation_threads" ("state");
