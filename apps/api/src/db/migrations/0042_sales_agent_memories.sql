CREATE TABLE IF NOT EXISTS "sales_agent_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contact_id" uuid NOT NULL,
  "lead_id" uuid,
  "summary" text,
  "customer_intent" text,
  "job_type" text,
  "pricing_context" text,
  "objections" text[] DEFAULT '{}'::text[] NOT NULL,
  "channel_preference" text,
  "last_promised_next_step" text,
  "last_human_summary" text,
  "booking_readiness" text,
  "quote_confidence" text,
  "missing_fields" text[] DEFAULT '{}'::text[] NOT NULL,
  "facts_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_agent_memories" ADD CONSTRAINT "sales_agent_memories_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_agent_memories" ADD CONSTRAINT "sales_agent_memories_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_agent_memories_contact_key" ON "sales_agent_memories" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_agent_memories_lead_idx" ON "sales_agent_memories" USING btree ("lead_id");
