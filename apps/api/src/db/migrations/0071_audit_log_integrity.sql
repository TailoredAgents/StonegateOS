-- Expand the audit ledger into a queryable, append-only record.
--
-- Actor/session values are immutable snapshots. The actor FK is deliberately
-- removed before the write guard is enabled: deleting an old member must not
-- rewrite historical evidence through ON DELETE SET NULL.

ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "session_id" uuid,
  ADD COLUMN IF NOT EXISTS "auth_method" text,
  ADD COLUMN IF NOT EXISTS "correlation_id" text,
  ADD COLUMN IF NOT EXISTS "required_permissions" text[],
  ADD COLUMN IF NOT EXISTS "outcome" text,
  ADD COLUMN IF NOT EXISTS "surface" text,
  ADD COLUMN IF NOT EXISTS "provider_operation_id" text,
  ADD COLUMN IF NOT EXISTS "idempotency_key_hash" varchar(64);

-- Promote fields already written by the shared mutation boundary. Cast UUIDs
-- and hashes only after validation so malformed historical metadata remains
-- reviewable without blocking the migration.
UPDATE "audit_logs"
SET
  "session_id" = CASE
    WHEN coalesce("meta" ->> 'sessionId', '') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN ("meta" ->> 'sessionId')::uuid
    ELSE NULL
  END,
  "auth_method" = CASE
    WHEN "meta" ->> 'authMethod' IN ('team_session', 'break_glass', 'service')
      THEN "meta" ->> 'authMethod'
    ELSE NULL
  END,
  "correlation_id" = nullif("meta" ->> 'correlationId', ''),
  "required_permissions" = CASE
    WHEN jsonb_typeof("meta" -> 'requiredPermissions') = 'array'
      THEN ARRAY(
        SELECT jsonb_array_elements_text("meta" -> 'requiredPermissions')
      )
    ELSE NULL
  END,
  "outcome" = CASE
    WHEN "meta" ->> 'outcome' IN ('attempted', 'succeeded', 'denied', 'failed')
      THEN "meta" ->> 'outcome'
    WHEN "action" LIKE '%.denied' THEN 'denied'
    WHEN "action" LIKE '%.failed' OR "action" LIKE '%.blocked' THEN 'failed'
    ELSE 'succeeded'
  END,
  "surface" = nullif("meta" ->> 'surface', ''),
  "provider_operation_id" = nullif("meta" ->> 'providerOperationId', ''),
  "idempotency_key_hash" = CASE
    WHEN coalesce("meta" ->> 'idempotencyKeyHash', '') ~ '^[0-9a-f]{64}$'
      THEN "meta" ->> 'idempotencyKeyHash'
    ELSE NULL
  END
WHERE "meta" IS NOT NULL;

UPDATE "audit_logs"
SET "outcome" = CASE
  WHEN "action" LIKE '%.denied' THEN 'denied'
  WHEN "action" LIKE '%.failed' OR "action" LIKE '%.blocked' THEN 'failed'
  ELSE 'succeeded'
END
WHERE "outcome" IS NULL;

ALTER TABLE "audit_logs"
  ALTER COLUMN "outcome" SET DEFAULT 'succeeded',
  ALTER COLUMN "outcome" SET NOT NULL;

-- Remove common top-level secrets and unnecessary customer content once,
-- before the ledger becomes immutable. Application writers also recursively
-- redact metadata and the read API repeats that defense.
UPDATE "audit_logs"
SET "meta" = "meta" - ARRAY[
  'accessToken', 'access_token', 'apiKey', 'api_key', 'authorization',
  'body', 'contactName', 'cookie', 'dataUrl', 'email', 'firstName',
  'lastName', 'message', 'messageBody', 'notes', 'password', 'phone',
  'phoneE164', 'receiptUrl', 'refreshToken', 'refresh_token', 'secret',
  'sessionHash', 'subject', 'text', 'token'
]::text[]
WHERE "meta" IS NOT NULL;

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_fkey";
ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_team_members_id_fk";

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_auth_method_check";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_auth_method_check"
  CHECK (
    "auth_method" IS NULL
    OR "auth_method" IN ('team_session', 'break_glass', 'service')
  ) NOT VALID;

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_outcome_check";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_outcome_check"
  CHECK ("outcome" IN ('attempted', 'succeeded', 'denied', 'failed')) NOT VALID;

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_idempotency_hash_check";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_idempotency_hash_check"
  CHECK (
    "idempotency_key_hash" IS NULL
    OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
  ) NOT VALID;

ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_auth_method_check";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_outcome_check";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_idempotency_hash_check";

CREATE INDEX IF NOT EXISTS "audit_logs_action_idx"
  ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS "audit_logs_outcome_idx"
  ON "audit_logs" ("outcome");
CREATE INDEX IF NOT EXISTS "audit_logs_correlation_idx"
  ON "audit_logs" ("correlation_id");
CREATE INDEX IF NOT EXISTS "audit_logs_cursor_idx"
  ON "audit_logs" ("created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "audit_logs_append_only_guard" ON "audit_logs";
CREATE TRIGGER "audit_logs_append_only_guard"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_mutation();

COMMENT ON COLUMN "audit_logs"."actor_id" IS
  'Immutable verified actor snapshot; intentionally not a mutable foreign key.';
COMMENT ON TABLE "audit_logs" IS
  'Append-only security and business event ledger; UPDATE, DELETE, and TRUNCATE are blocked.';
