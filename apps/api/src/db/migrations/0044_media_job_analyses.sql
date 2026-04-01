CREATE TABLE "media_job_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"instant_quote_id" uuid,
	"source_channel" text,
	"media_count" integer DEFAULT 0 NOT NULL,
	"video_count" integer DEFAULT 0 NOT NULL,
	"visible_volume_bucket" text,
	"visible_volume_range" text,
	"merged_volume_bucket" text,
	"merged_volume_range" text,
	"visible_mattress_count" integer DEFAULT 0 NOT NULL,
	"visible_paint_can_count" integer DEFAULT 0 NOT NULL,
	"visible_tire_count" integer DEFAULT 0 NOT NULL,
	"scene_groups_json" jsonb,
	"stated_scope_json" jsonb,
	"risk_flags" text[] DEFAULT '{}' NOT NULL,
	"missing_views" text[] DEFAULT '{}' NOT NULL,
	"confidence" text,
	"summary" text,
	"raw_model_output_json" jsonb,
	"source" text DEFAULT 'scaffold_v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_job_analyses" ADD CONSTRAINT "media_job_analyses_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "media_job_analyses" ADD CONSTRAINT "media_job_analyses_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "media_job_analyses" ADD CONSTRAINT "media_job_analyses_instant_quote_id_instant_quotes_id_fk" FOREIGN KEY ("instant_quote_id") REFERENCES "public"."instant_quotes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "media_job_analyses_contact_key" ON "media_job_analyses" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "media_job_analyses_lead_idx" ON "media_job_analyses" USING btree ("lead_id");
--> statement-breakpoint
CREATE INDEX "media_job_analyses_instant_quote_idx" ON "media_job_analyses" USING btree ("instant_quote_id");
