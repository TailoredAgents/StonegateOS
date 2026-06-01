CREATE TABLE "facebook_sales_autopilot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"lead_id" uuid,
	"thread_id" uuid NOT NULL,
	"channel" text DEFAULT 'dm' NOT NULL,
	"stage" text DEFAULT 'new_inquiry' NOT NULL,
	"autonomy_mode" text DEFAULT 'shadow' NOT NULL,
	"last_decision" text,
	"last_decision_reason" text,
	"last_human_review_reason" text,
	"last_evaluated_message_id" uuid,
	"last_meaningful_inbound_at" timestamp with time zone,
	"quote_low_cents" integer,
	"quote_high_cents" integer,
	"offered_slots_json" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facebook_sales_autopilot_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"contact_id" uuid,
	"lead_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"proposed_action" text NOT NULL,
	"executed_action" text,
	"autonomy_mode" text DEFAULT 'shadow' NOT NULL,
	"stage" text DEFAULT 'new_inquiry' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"decision_reason" text,
	"human_review_reason" text,
	"input_snapshot" jsonb,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_sessions" ADD CONSTRAINT "facebook_sales_autopilot_sessions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_sessions" ADD CONSTRAINT "facebook_sales_autopilot_sessions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_sessions" ADD CONSTRAINT "facebook_sales_autopilot_sessions_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_sessions" ADD CONSTRAINT "facebook_sales_autopilot_sessions_last_evaluated_message_id_conversation_messages_id_fk" FOREIGN KEY ("last_evaluated_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_actions" ADD CONSTRAINT "facebook_sales_autopilot_actions_session_id_facebook_sales_autopilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."facebook_sales_autopilot_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_actions" ADD CONSTRAINT "facebook_sales_autopilot_actions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_actions" ADD CONSTRAINT "facebook_sales_autopilot_actions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_actions" ADD CONSTRAINT "facebook_sales_autopilot_actions_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "facebook_sales_autopilot_actions" ADD CONSTRAINT "facebook_sales_autopilot_actions_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "facebook_sales_autopilot_sessions_thread_key" ON "facebook_sales_autopilot_sessions" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "facebook_sales_autopilot_sessions_contact_idx" ON "facebook_sales_autopilot_sessions" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "facebook_sales_autopilot_sessions_stage_idx" ON "facebook_sales_autopilot_sessions" USING btree ("stage");
--> statement-breakpoint
CREATE INDEX "facebook_sales_autopilot_actions_session_idx" ON "facebook_sales_autopilot_actions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "facebook_sales_autopilot_actions_thread_idx" ON "facebook_sales_autopilot_actions" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "facebook_sales_autopilot_actions_created_idx" ON "facebook_sales_autopilot_actions" USING btree ("created_at");
