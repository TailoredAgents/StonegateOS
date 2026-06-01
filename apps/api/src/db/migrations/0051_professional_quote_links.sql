ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "quote_number" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "job_duration_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "client_scope" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "refresh_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "accepted_appointment_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_accepted_appointment_id_appointments_id_fk"
    FOREIGN KEY ("accepted_appointment_id") REFERENCES "public"."appointments"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_quote_number_idx" ON "quotes" ("quote_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_accepted_appointment_idx" ON "quotes" ("accepted_appointment_id");
