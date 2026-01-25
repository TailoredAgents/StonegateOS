ALTER TABLE "team_members"
ADD COLUMN IF NOT EXISTS "password_hash" text;

ALTER TABLE "team_members"
ADD COLUMN IF NOT EXISTS "password_set_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "team_login_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL REFERENCES "team_members" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "requested_ip" text,
  "user_agent" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_login_tokens_hash_key" ON "team_login_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "team_login_tokens_member_idx" ON "team_login_tokens" ("team_member_id");
CREATE INDEX IF NOT EXISTS "team_login_tokens_expires_idx" ON "team_login_tokens" ("expires_at");

CREATE TABLE IF NOT EXISTS "team_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL REFERENCES "team_members" ("id") ON DELETE CASCADE,
  "session_hash" text NOT NULL,
  "ip" text,
  "user_agent" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_sessions_hash_key" ON "team_sessions" ("session_hash");
CREATE INDEX IF NOT EXISTS "team_sessions_member_idx" ON "team_sessions" ("team_member_id");
CREATE INDEX IF NOT EXISTS "team_sessions_expires_idx" ON "team_sessions" ("expires_at");

