CREATE TABLE IF NOT EXISTS "appointment_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instant_quote_id" uuid REFERENCES "instant_quotes"("id") ON DELETE set null,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE set null,
  "property_id" uuid REFERENCES "properties"("id") ON DELETE set null,
  "start_at" timestamp with time zone NOT NULL,
  "duration_min" integer DEFAULT 60 NOT NULL,
  "travel_buffer_min" integer DEFAULT 30 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "appointment_holds_start_idx" ON "appointment_holds" ("start_at");
CREATE INDEX IF NOT EXISTS "appointment_holds_status_idx" ON "appointment_holds" ("status");
CREATE INDEX IF NOT EXISTS "appointment_holds_expires_idx" ON "appointment_holds" ("expires_at");
CREATE INDEX IF NOT EXISTS "appointment_holds_quote_idx" ON "appointment_holds" ("instant_quote_id");
