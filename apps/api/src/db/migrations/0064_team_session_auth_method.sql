-- Expand-first migration: persist how each opaque team session was issued so
-- authorization and audit attribution do not have to infer it from cookies or
-- caller-supplied headers.
ALTER TABLE "team_sessions"
  ADD COLUMN IF NOT EXISTS "auth_method" text;

UPDATE "team_sessions"
SET "auth_method" = 'team_session'
WHERE "auth_method" IS NULL;

ALTER TABLE "team_sessions"
  ALTER COLUMN "auth_method" SET DEFAULT 'team_session',
  ALTER COLUMN "auth_method" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'team_sessions_auth_method_check'
  ) THEN
    ALTER TABLE "team_sessions"
      ADD CONSTRAINT "team_sessions_auth_method_check"
      CHECK ("auth_method" IN ('team_session', 'break_glass')) NOT VALID;
  END IF;
END $$;

ALTER TABLE "team_sessions"
  VALIDATE CONSTRAINT "team_sessions_auth_method_check";

COMMENT ON COLUMN "team_sessions"."auth_method" IS
  'Verified issuance method: normal team authentication or audited break-glass exchange.';
