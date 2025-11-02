CREATE TYPE "public"."appointment_status" AS ENUM('requested', 'confirmed', 'completed', 'no_show', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."crm_pipeline_stage" AS ENUM('new', 'contacted', 'qualified', 'quoted', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."crm_task_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'quoted', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('pending', 'sent', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "appointment_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"lead_id" uuid,
	"type" text DEFAULT 'estimate' NOT NULL,
	"start_at" timestamp with time zone,
	"duration_min" integer DEFAULT 60 NOT NULL,
	"status" "appointment_status" DEFAULT 'requested' NOT NULL,
	"calendar_event_id" text,
	"reschedule_token" varchar(64) NOT NULL,
	"travel_buffer_min" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_state" (
	"calendar_id" text PRIMARY KEY NOT NULL,
	"sync_token" text,
	"channel_id" text,
	"resource_id" text,
	"channel_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_notification_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" varchar(32),
	"phone_e164" varchar(32),
	"preferred_contact_method" text DEFAULT 'phone',
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pipeline" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"stage" "crm_pipeline_stage" DEFAULT 'new' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_to" text,
	"status" "crm_task_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"services_requested" text[] NOT NULL,
	"notes" text,
	"surface_area" numeric,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"source" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"gclid" text,
	"fbclid" text,
	"referrer" text,
	"form_payload" jsonb,
	"quote_estimate" numeric,
	"quote_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_charge_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(10) NOT NULL,
	"status" text NOT NULL,
	"method" text,
	"card_brand" text,
	"last4" varchar(4),
	"receipt_url" text,
	"metadata" jsonb,
	"appointment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" varchar(2) NOT NULL,
	"postal_code" varchar(16) NOT NULL,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"gated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"status" "quote_status" DEFAULT 'pending' NOT NULL,
	"services" jsonb NOT NULL,
	"add_ons" jsonb,
	"surface_area" numeric,
	"zone_id" text NOT NULL,
	"travel_fee" numeric DEFAULT '0' NOT NULL,
	"discounts" numeric DEFAULT '0' NOT NULL,
	"add_ons_total" numeric DEFAULT '0' NOT NULL,
	"subtotal" numeric NOT NULL,
	"total" numeric NOT NULL,
	"deposit_due" numeric NOT NULL,
	"deposit_rate" numeric NOT NULL,
	"balance_due" numeric NOT NULL,
	"line_items" jsonb NOT NULL,
	"availability" jsonb,
	"marketing" jsonb,
	"notes" text,
	"share_token" text,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"decision_at" timestamp with time zone,
	"decision_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_notes" ADD CONSTRAINT "appointment_notes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pipeline" ADD CONSTRAINT "crm_pipeline_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_notes_appointment_idx" ON "appointment_notes" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "appointments_start_idx" ON "appointments" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "appointments_status_idx" ON "appointments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_key" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_key" ON "contacts" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_e164_key" ON "contacts" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "crm_tasks_contact_idx" ON "crm_tasks" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_tasks_due_idx" ON "crm_tasks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_property_idx" ON "leads" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_quote_idx" ON "leads" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_charge_idx" ON "payments" USING btree ("stripe_charge_id");--> statement-breakpoint
CREATE INDEX "payments_appointment_idx" ON "payments" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "properties_contact_idx" ON "properties" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_address_key" ON "properties" USING btree ("address_line1","postal_code","state");--> statement-breakpoint
CREATE INDEX "quotes_contact_idx" ON "quotes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "quotes_property_idx" ON "quotes" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_share_token_key" ON "quotes" USING btree ("share_token");