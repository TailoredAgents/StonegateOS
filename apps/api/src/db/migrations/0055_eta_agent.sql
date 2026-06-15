CREATE TABLE IF NOT EXISTS "crew_tracking_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_member_id" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "crew_label" text,
  "provider" text NOT NULL DEFAULT 'traccar',
  "provider_device_id" text NOT NULL,
  "display_name" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "crew_tracking_devices_provider_device_key"
  ON "crew_tracking_devices" ("provider", "provider_device_id");
CREATE INDEX IF NOT EXISTS "crew_tracking_devices_member_idx"
  ON "crew_tracking_devices" ("team_member_id");
CREATE INDEX IF NOT EXISTS "crew_tracking_devices_active_idx"
  ON "crew_tracking_devices" ("active");

CREATE TABLE IF NOT EXISTS "crew_location_pings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tracking_device_id" uuid NOT NULL REFERENCES "crew_tracking_devices" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL DEFAULT 'traccar',
  "provider_position_id" text,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy_meters" double precision,
  "speed_kph" double precision,
  "fix_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "freshness" text NOT NULL DEFAULT 'fresh',
  "raw" jsonb
);

CREATE INDEX IF NOT EXISTS "crew_location_pings_device_fix_idx"
  ON "crew_location_pings" ("tracking_device_id", "fix_at" DESC);
CREATE INDEX IF NOT EXISTS "crew_location_pings_freshness_idx"
  ON "crew_location_pings" ("freshness");

CREATE TABLE IF NOT EXISTS "crew_route_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_member_id" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "crew_label" text,
  "service_date" text NOT NULL,
  "current_appointment_id" uuid REFERENCES "appointments" ("id") ON DELETE SET NULL,
  "next_appointment_id" uuid REFERENCES "appointments" ("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'unknown',
  "dump_status" text NOT NULL DEFAULT 'not_needed',
  "location_freshness" text NOT NULL DEFAULT 'missing',
  "last_location_ping_id" uuid REFERENCES "crew_location_pings" ("id") ON DELETE SET NULL,
  "status_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "crew_route_states_member_date_idx"
  ON "crew_route_states" ("team_member_id", "service_date");
CREATE INDEX IF NOT EXISTS "crew_route_states_crew_date_idx"
  ON "crew_route_states" ("crew_label", "service_date");
CREATE INDEX IF NOT EXISTS "crew_route_states_current_idx"
  ON "crew_route_states" ("current_appointment_id");

CREATE TABLE IF NOT EXISTS "appointment_eta_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointment_id" uuid NOT NULL REFERENCES "appointments" ("id") ON DELETE CASCADE,
  "team_member_id" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "crew_label" text,
  "event_type" text NOT NULL,
  "source" text NOT NULL DEFAULT 'crm',
  "note" text,
  "meta" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "appointment_eta_events_appt_created_idx"
  ON "appointment_eta_events" ("appointment_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "appointment_eta_events_type_idx"
  ON "appointment_eta_events" ("event_type");

CREATE TABLE IF NOT EXISTS "eta_message_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointment_id" uuid NOT NULL REFERENCES "appointments" ("id") ON DELETE CASCADE,
  "contact_id" uuid REFERENCES "contacts" ("id") ON DELETE SET NULL,
  "thread_id" uuid REFERENCES "conversation_threads" ("id") ON DELETE SET NULL,
  "channel" text NOT NULL DEFAULT 'sms',
  "status" text NOT NULL DEFAULT 'draft',
  "reason" text NOT NULL,
  "body" text NOT NULL,
  "eta_start_at" timestamp with time zone,
  "eta_end_at" timestamp with time zone,
  "confidence" text NOT NULL DEFAULT 'low',
  "location_freshness" text NOT NULL DEFAULT 'missing',
  "created_by" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "sent_by" uuid REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "sent_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "eta_message_drafts_status_created_idx"
  ON "eta_message_drafts" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "eta_message_drafts_appt_idx"
  ON "eta_message_drafts" ("appointment_id", "created_at" DESC);
