-- Expand-first durable idempotency ledger for authenticated /team mutations.
-- Raw client keys are never stored. The application persists a SHA-256 key
-- fingerprint and separately fingerprints the verified principal, entity
-- scope, and canonical request so key reuse cannot cross those boundaries.
CREATE TABLE IF NOT EXISTS "team_mutation_idempotency" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_hash" varchar(64) NOT NULL,
  "action" text NOT NULL,
  "key_hash" varchar(64) NOT NULL,
  "scope_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "status" text DEFAULT 'in_progress' NOT NULL,
  "operation_id" uuid NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claim_expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "response_status" integer,
  "response_body" jsonb,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_mutation_idempotency_status_check"
    CHECK ("status" IN ('in_progress', 'succeeded', 'failed')),
  CONSTRAINT "team_mutation_idempotency_principal_hash_check"
    CHECK ("principal_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_mutation_idempotency_key_hash_check"
    CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_mutation_idempotency_scope_hash_check"
    CHECK ("scope_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_mutation_idempotency_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_mutation_idempotency_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 1 AND 3),
  CONSTRAINT "team_mutation_idempotency_response_status_check"
    CHECK ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599),
  CONSTRAINT "team_mutation_idempotency_terminal_check"
    CHECK (
      (
        "status" = 'in_progress'
        AND "completed_at" IS NULL
        AND "response_status" IS NULL
        AND "response_body" IS NULL
      )
      OR
      (
        "status" IN ('succeeded', 'failed')
        AND "completed_at" IS NOT NULL
        AND "response_status" IS NOT NULL
        AND "response_body" IS NOT NULL
      )
    ),
  CONSTRAINT "team_mutation_idempotency_expiry_check"
    CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_mutation_idempotency_principal_action_key"
  ON "team_mutation_idempotency" ("principal_hash", "action", "key_hash");

CREATE INDEX IF NOT EXISTS "team_mutation_idempotency_expires_idx"
  ON "team_mutation_idempotency" ("expires_at");

CREATE INDEX IF NOT EXISTS "team_mutation_idempotency_active_claim_idx"
  ON "team_mutation_idempotency" ("claim_expires_at")
  WHERE "status" = 'in_progress';

COMMENT ON TABLE "team_mutation_idempotency" IS
  'Hashed, principal-scoped replay ledger for high-risk authenticated team mutations.';

COMMENT ON COLUMN "team_mutation_idempotency"."key_hash" IS
  'SHA-256 fingerprint of the normalized client Idempotency-Key; the raw key is never persisted.';

COMMENT ON COLUMN "team_mutation_idempotency"."request_hash" IS
  'Canonical request fingerprint including entity scope, payload, and expected version.';
