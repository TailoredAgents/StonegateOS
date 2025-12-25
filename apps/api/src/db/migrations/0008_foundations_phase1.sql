CREATE TYPE "public"."audit_actor_type" AS ENUM('human', 'ai', 'system', 'worker');
CREATE TYPE "public"."conversation_channel" AS ENUM('sms', 'email', 'dm', 'call', 'web');
CREATE TYPE "public"."conversation_thread_status" AS ENUM('open', 'pending', 'closed');
CREATE TYPE "public"."conversation_participant_type" AS ENUM('contact', 'team', 'system');
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'internal');
CREATE TYPE "public"."message_delivery_status" AS ENUM('queued', 'sent', 'delivered', 'failed');
CREATE TYPE "public"."automation_channel" AS ENUM('sms', 'email', 'dm', 'call', 'web');
CREATE TYPE "public"."automation_mode" AS ENUM('draft', 'assist', 'auto');

CREATE TABLE IF NOT EXISTS "team_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "permissions" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_roles_slug_key" ON "team_roles" ("slug");

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text,
  "role_id" uuid REFERENCES "team_roles"("id") ON DELETE set null,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "team_members_email_idx" ON "team_members" ("email");
CREATE INDEX IF NOT EXISTS "team_members_role_idx" ON "team_members" ("role_id");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_type" "audit_actor_type" DEFAULT 'system' NOT NULL,
  "actor_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "actor_label" text,
  "actor_role" text,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "meta" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" ("actor_id");
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" ("created_at");

CREATE TABLE IF NOT EXISTS "policy_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "automation_settings" (
  "channel" "automation_channel" PRIMARY KEY NOT NULL,
  "mode" "automation_mode" DEFAULT 'draft' NOT NULL,
  "updated_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "lead_automation_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE cascade,
  "channel" "automation_channel" NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "dnc" boolean DEFAULT false NOT NULL,
  "human_takeover" boolean DEFAULT false NOT NULL,
  "followup_state" text,
  "followup_step" integer DEFAULT 0 NOT NULL,
  "next_followup_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "paused_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "lead_automation_lead_idx" ON "lead_automation_state" ("lead_id");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_automation_lead_channel_key" ON "lead_automation_state" ("lead_id", "channel");

CREATE TABLE IF NOT EXISTS "conversation_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE set null,
  "property_id" uuid REFERENCES "properties"("id") ON DELETE set null,
  "status" "conversation_thread_status" DEFAULT 'open' NOT NULL,
  "channel" "conversation_channel" DEFAULT 'sms' NOT NULL,
  "subject" text,
  "last_message_preview" text,
  "last_message_at" timestamp with time zone,
  "assigned_to" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "conversation_threads_lead_idx" ON "conversation_threads" ("lead_id");
CREATE INDEX IF NOT EXISTS "conversation_threads_contact_idx" ON "conversation_threads" ("contact_id");
CREATE INDEX IF NOT EXISTS "conversation_threads_status_idx" ON "conversation_threads" ("status");
CREATE INDEX IF NOT EXISTS "conversation_threads_last_message_idx" ON "conversation_threads" ("last_message_at");

CREATE TABLE IF NOT EXISTS "conversation_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "conversation_threads"("id") ON DELETE cascade,
  "participant_type" "conversation_participant_type" NOT NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE set null,
  "team_member_id" uuid REFERENCES "team_members"("id") ON DELETE set null,
  "external_address" text,
  "display_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "conversation_participants_thread_idx" ON "conversation_participants" ("thread_id");

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "conversation_threads"("id") ON DELETE cascade,
  "participant_id" uuid REFERENCES "conversation_participants"("id") ON DELETE set null,
  "direction" "message_direction" NOT NULL,
  "channel" "conversation_channel" NOT NULL,
  "subject" text,
  "body" text NOT NULL,
  "media_urls" text[] NOT NULL DEFAULT '{}',
  "to_address" text,
  "from_address" text,
  "delivery_status" "message_delivery_status" DEFAULT 'queued' NOT NULL,
  "provider" text,
  "provider_message_id" text,
  "sent_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "conversation_messages_thread_idx" ON "conversation_messages" ("thread_id");
CREATE INDEX IF NOT EXISTS "conversation_messages_status_idx" ON "conversation_messages" ("delivery_status");
CREATE INDEX IF NOT EXISTS "conversation_messages_sent_idx" ON "conversation_messages" ("sent_at");

CREATE TABLE IF NOT EXISTS "message_delivery_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL REFERENCES "conversation_messages"("id") ON DELETE cascade,
  "status" "message_delivery_status" NOT NULL,
  "detail" text,
  "provider" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "message_delivery_message_idx" ON "message_delivery_events" ("message_id");
CREATE INDEX IF NOT EXISTS "message_delivery_status_idx" ON "message_delivery_events" ("status");
CREATE INDEX IF NOT EXISTS "message_delivery_occurred_idx" ON "message_delivery_events" ("occurred_at");
