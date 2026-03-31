CREATE TABLE "sales_agent_next_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"action_type" text NOT NULL,
	"channel" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"summary" text,
	"reason" text,
	"facts" text[] DEFAULT '{}' NOT NULL,
	"due_at" timestamp with time zone,
	"source" text DEFAULT 'rules_v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_agent_next_actions" ADD CONSTRAINT "sales_agent_next_actions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_agent_next_actions" ADD CONSTRAINT "sales_agent_next_actions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_agent_next_actions_contact_key" ON "sales_agent_next_actions" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "sales_agent_next_actions_lead_idx" ON "sales_agent_next_actions" USING btree ("lead_id");
--> statement-breakpoint
CREATE INDEX "sales_agent_next_actions_due_idx" ON "sales_agent_next_actions" USING btree ("due_at");
--> statement-breakpoint
CREATE INDEX "sales_agent_next_actions_status_idx" ON "sales_agent_next_actions" USING btree ("status");
