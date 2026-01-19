DO $$ BEGIN
 IF NOT EXISTS (select 1 from pg_type where typname = 'call_coaching_rubric') THEN
  CREATE TYPE "public"."call_coaching_rubric" AS ENUM('inbound', 'outbound');
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (select 1 from pg_type where typname = 'partner_status') THEN
  CREATE TYPE "public"."partner_status" AS ENUM('none', 'prospect', 'contacted', 'partner', 'inactive');
 END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_coaching" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_record_id" uuid NOT NULL,
	"member_id" uuid,
	"rubric" "call_coaching_rubric" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"model" text,
	"score_overall" integer NOT NULL,
	"score_breakdown" jsonb,
	"wins" text[] DEFAULT '{}' NOT NULL,
	"improvements" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "note_task_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "company" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_status" "partner_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_last_touch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_next_touch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_referral_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "partner_last_referral_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_coaching" ADD CONSTRAINT "call_coaching_call_record_id_call_records_id_fk" FOREIGN KEY ("call_record_id") REFERENCES "public"."call_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_coaching" ADD CONSTRAINT "call_coaching_member_id_team_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_coaching_unique" ON "call_coaching" USING btree ("call_record_id","rubric","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_coaching_call_idx" ON "call_coaching" USING btree ("call_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_coaching_member_idx" ON "call_coaching" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_coaching_rubric_idx" ON "call_coaching" USING btree ("rubric");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_records" ADD CONSTRAINT "call_records_note_task_id_crm_tasks_id_fk" FOREIGN KEY ("note_task_id") REFERENCES "public"."crm_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_partner_status_idx" ON "contacts" USING btree ("partner_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_partner_owner_idx" ON "contacts" USING btree ("partner_owner_member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_partner_next_touch_idx" ON "contacts" USING btree ("partner_next_touch_at");
