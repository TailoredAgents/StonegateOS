CREATE TYPE "public"."partner_account_status" AS ENUM(
	'imported',
	'ready_for_first_touch',
	'attempting_contact',
	'conversation_active',
	'qualified_partner',
	'trial_partner',
	'active_partner',
	'portal_partner',
	'managed_partner',
	'dormant',
	'not_a_fit'
);
--> statement-breakpoint
CREATE TABLE "partner_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"website" text,
	"segment" text,
	"subsegment" text,
	"status" "partner_account_status" DEFAULT 'imported' NOT NULL,
	"source" text,
	"source_campaign" text,
	"source_list_name" text,
	"city" text,
	"state" character varying(32),
	"owner_member_id" uuid,
	"portal_fit" text,
	"fit_score" integer,
	"last_touch_at" timestamp with time zone,
	"next_touch_at" timestamp with time zone,
	"last_disposition" text,
	"notes" text,
	"ai_account_brief" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "partner_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD COLUMN "partner_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_partner_account_id_partner_accounts_id_fk" FOREIGN KEY ("partner_account_id") REFERENCES "public"."partner_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_partner_account_id_partner_accounts_id_fk" FOREIGN KEY ("partner_account_id") REFERENCES "public"."partner_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "partner_accounts_status_idx" ON "partner_accounts" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "partner_accounts_owner_idx" ON "partner_accounts" USING btree ("owner_member_id");
--> statement-breakpoint
CREATE INDEX "partner_accounts_next_touch_idx" ON "partner_accounts" USING btree ("next_touch_at");
--> statement-breakpoint
CREATE INDEX "partner_accounts_domain_idx" ON "partner_accounts" USING btree ("domain");
--> statement-breakpoint
CREATE INDEX "partner_accounts_normalized_name_idx" ON "partner_accounts" USING btree ("normalized_name");
--> statement-breakpoint
CREATE INDEX "contacts_partner_account_idx" ON "contacts" USING btree ("partner_account_id");
--> statement-breakpoint
CREATE INDEX "crm_tasks_partner_account_idx" ON "crm_tasks" USING btree ("partner_account_id");
