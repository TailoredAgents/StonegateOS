CREATE TABLE "call_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_sid" text NOT NULL,
	"parent_call_sid" text,
	"direction" text NOT NULL,
	"mode" text,
	"from_number" text,
	"to_number" text,
	"contact_id" uuid REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action,
	"assigned_to" uuid REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action,
	"call_status" text,
	"call_duration_sec" integer,
	"recording_sid" text,
	"recording_url" text,
	"recording_duration_sec" integer,
	"recording_created_at" timestamp with time zone,
	"transcript" text,
	"extracted" jsonb,
	"summary" text,
	"coaching" text,
	"processed_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "call_records_call_sid_key" ON "call_records" USING btree ("call_sid");
--> statement-breakpoint
CREATE INDEX "call_records_contact_idx" ON "call_records" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "call_records_assigned_idx" ON "call_records" USING btree ("assigned_to");
--> statement-breakpoint
CREATE INDEX "call_records_delete_idx" ON "call_records" USING btree ("delete_after");
