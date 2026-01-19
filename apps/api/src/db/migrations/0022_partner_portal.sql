CREATE TABLE IF NOT EXISTS "partner_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_contact_id" uuid NOT NULL REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "password_hash" text,
  "password_set_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_users_email_key" ON "partner_users" ("email");
CREATE INDEX IF NOT EXISTS "partner_users_org_contact_idx" ON "partner_users" ("org_contact_id");

CREATE TABLE IF NOT EXISTS "partner_login_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "requested_ip" text,
  "user_agent" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_login_tokens_hash_key" ON "partner_login_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "partner_login_tokens_user_idx" ON "partner_login_tokens" ("partner_user_id");
CREATE INDEX IF NOT EXISTS "partner_login_tokens_expires_idx" ON "partner_login_tokens" ("expires_at");

CREATE TABLE IF NOT EXISTS "partner_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users" ("id") ON DELETE CASCADE,
  "session_hash" text NOT NULL,
  "ip" text,
  "user_agent" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_sessions_hash_key" ON "partner_sessions" ("session_hash");
CREATE INDEX IF NOT EXISTS "partner_sessions_user_idx" ON "partner_sessions" ("partner_user_id");
CREATE INDEX IF NOT EXISTS "partner_sessions_expires_idx" ON "partner_sessions" ("expires_at");

CREATE TABLE IF NOT EXISTS "partner_rate_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_contact_id" uuid NOT NULL REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "currency" text DEFAULT 'USD' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_rate_cards_org_key" ON "partner_rate_cards" ("org_contact_id");

CREATE TABLE IF NOT EXISTS "partner_rate_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rate_card_id" uuid NOT NULL REFERENCES "partner_rate_cards" ("id") ON DELETE CASCADE,
  "service_key" text NOT NULL,
  "tier_key" text NOT NULL,
  "label" text,
  "amount_cents" integer NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "partner_rate_items_card_idx" ON "partner_rate_items" ("rate_card_id");
CREATE INDEX IF NOT EXISTS "partner_rate_items_service_idx" ON "partner_rate_items" ("service_key");

CREATE TABLE IF NOT EXISTS "partner_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_contact_id" uuid NOT NULL REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "partner_user_id" uuid REFERENCES "partner_users" ("id") ON DELETE SET NULL,
  "property_id" uuid REFERENCES "properties" ("id") ON DELETE SET NULL,
  "appointment_id" uuid NOT NULL REFERENCES "appointments" ("id") ON DELETE CASCADE,
  "service_key" text,
  "tier_key" text,
  "amount_cents" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "partner_bookings_org_idx" ON "partner_bookings" ("org_contact_id");
CREATE INDEX IF NOT EXISTS "partner_bookings_appointment_idx" ON "partner_bookings" ("appointment_id");
