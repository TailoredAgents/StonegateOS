CREATE TABLE IF NOT EXISTS "commission_crew_pool_override_days" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "local_date" text NOT NULL,
  "timezone" text DEFAULT 'America/New_York' NOT NULL,
  "crew_pool_rate_bps" integer NOT NULL,
  "note" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_crew_pool_override_days" ADD CONSTRAINT "commission_crew_pool_override_days_created_by_team_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_crew_pool_override_days_local_date_unique" ON "commission_crew_pool_override_days" USING btree ("local_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_crew_pool_override_days_local_date_idx" ON "commission_crew_pool_override_days" USING btree ("local_date");
