CREATE TABLE IF NOT EXISTS "team_call_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mutation_claim_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "agent_member_id" uuid NOT NULL,
  "task_id" uuid,
  "actor_member_id" uuid NOT NULL,
  "actor_label" text,
  "actor_role" text,
  "session_id" uuid NOT NULL,
  "auth_method" text NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "state" text DEFAULT 'requested' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "provider" text DEFAULT 'twilio' NOT NULL,
  "provider_request_key" uuid NOT NULL,
  "provider_operation_id" text,
  "provider_idempotency_supported" boolean DEFAULT false NOT NULL,
  "terminal_audit_event_id" uuid,
  "completed_explicit_task_id" uuid,
  "completed_followup_task_id" uuid,
  "completed_speed_to_lead_count" integer DEFAULT 0 NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "reconciliation_required_at" timestamp with time zone,
  "provider_status" integer,
  "failure_code" text,
  "failure_detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_call_operations_terminal_audit_event_fk"
    FOREIGN KEY ("terminal_audit_event_id")
    REFERENCES "audit_logs"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "team_call_operations_state_check"
    CHECK (
      "state" IN (
        'requested',
        'dispatched',
        'succeeded',
        'failed',
        'reconciliation_required'
      )
    ),
  CONSTRAINT "team_call_operations_version_check"
    CHECK ("version" > 0),
  CONSTRAINT "team_call_operations_auth_method_check"
    CHECK ("auth_method" IN ('team_session', 'break_glass')),
  CONSTRAINT "team_call_operations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_call_operations_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_call_operations_provider_status_check"
    CHECK ("provider_status" IS NULL OR "provider_status" BETWEEN 100 AND 599),
  CONSTRAINT "team_call_operations_provider_check"
    CHECK (
      "provider" = 'twilio'
      AND "provider_idempotency_supported" = false
    ),
  CONSTRAINT "team_call_operations_provider_operation_check"
    CHECK (
      "provider_operation_id" IS NULL
      OR "provider_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "team_call_operations_task_count_check"
    CHECK ("completed_speed_to_lead_count" >= 0),
  CONSTRAINT "team_call_operations_lifecycle_check"
    CHECK (
      (
        "state" = 'requested'
        AND "dispatched_at" IS NULL
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "provider_status" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
        AND "completed_explicit_task_id" IS NULL
        AND "completed_followup_task_id" IS NULL
        AND "completed_speed_to_lead_count" = 0
      ) OR (
        "state" = 'dispatched'
        AND "dispatched_at" IS NOT NULL
        AND "dispatched_at" >= "requested_at"
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "provider_status" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
        AND "completed_explicit_task_id" IS NULL
        AND "completed_followup_task_id" IS NULL
        AND "completed_speed_to_lead_count" = 0
      ) OR (
        "state" = 'succeeded'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "provider_status" BETWEEN 200 AND 299
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
      ) OR (
        "state" = 'failed'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND "completed_explicit_task_id" IS NULL
        AND "completed_followup_task_id" IS NULL
        AND "completed_speed_to_lead_count" = 0
      ) OR (
        "state" = 'reconciliation_required'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NOT NULL
        AND "reconciliation_required_at" >= "dispatched_at"
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND "completed_explicit_task_id" IS NULL
        AND "completed_followup_task_id" IS NULL
        AND "completed_speed_to_lead_count" = 0
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_mutation_claim_key"
  ON "team_call_operations" ("mutation_claim_id");

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_actor_request_key"
  ON "team_call_operations" (
    "actor_member_id",
    "idempotency_key_hash"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_active_contact_key"
  ON "team_call_operations" ("contact_id")
  WHERE "state" IN ('requested', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_provider_request_key"
  ON "team_call_operations" ("provider_request_key");

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_provider_operation_key"
  ON "team_call_operations" ("provider_operation_id")
  WHERE "provider_operation_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_operations_terminal_audit_event_key"
  ON "team_call_operations" ("terminal_audit_event_id")
  WHERE "terminal_audit_event_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "team_call_operations_state_updated_idx"
  ON "team_call_operations" ("state", "updated_at");

CREATE INDEX IF NOT EXISTS "team_call_operations_contact_created_idx"
  ON "team_call_operations" ("contact_id", "created_at", "id");

CREATE OR REPLACE FUNCTION enforce_team_call_operation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested'
       OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'team_call_operation_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."mutation_claim_id" IS DISTINCT FROM OLD."mutation_claim_id"
     OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
     OR NEW."agent_member_id" IS DISTINCT FROM OLD."agent_member_id"
     OR NEW."task_id" IS DISTINCT FROM OLD."task_id"
     OR NEW."actor_member_id" IS DISTINCT FROM OLD."actor_member_id"
     OR NEW."actor_label" IS DISTINCT FROM OLD."actor_label"
     OR NEW."actor_role" IS DISTINCT FROM OLD."actor_role"
     OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
     OR NEW."auth_method" IS DISTINCT FROM OLD."auth_method"
     OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
     OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."provider_request_key" IS DISTINCT FROM OLD."provider_request_key"
     OR NEW."provider_idempotency_supported" IS DISTINCT FROM OLD."provider_idempotency_supported"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'team_call_operation_identity_immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'team_call_operation_version_must_increment';
  END IF;

  IF OLD."state" IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'team_call_operation_terminal_immutable';
  END IF;

  IF OLD."state" = 'requested'
     AND NEW."state" <> 'dispatched' THEN
    RAISE EXCEPTION 'team_call_operation_invalid_requested_transition';
  END IF;

  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'team_call_operation_invalid_dispatched_transition';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "team_call_operation_transition"
  ON "team_call_operations";
CREATE TRIGGER "team_call_operation_transition"
BEFORE INSERT OR UPDATE ON "team_call_operations"
FOR EACH ROW
EXECUTE FUNCTION enforce_team_call_operation_transition();

COMMENT ON TABLE "team_call_operations" IS
  'Immutable per-attempt evidence for manual Team calls. A dispatched attempt is never automatically sent again because Twilio does not consume our caller idempotency key.';
COMMENT ON COLUMN "team_call_operations"."mutation_claim_id" IS
  'Historical link to the durable mutation claim. Deliberately not a foreign key because mutation receipts expire before call evidence.';
COMMENT ON COLUMN "team_call_operations"."contact_id" IS
  'Verified immutable contact snapshot. Deliberately not a mutable foreign key so later CRM retention cannot rewrite call evidence.';
COMMENT ON COLUMN "team_call_operations"."agent_member_id" IS
  'Verified immutable active-agent snapshot; no phone number is retained.';
COMMENT ON COLUMN "team_call_operations"."task_id" IS
  'Optional task identifier verified against the contact before dispatch; retained as an immutable snapshot.';
COMMENT ON COLUMN "team_call_operations"."provider_request_key" IS
  'Stonegate dispatch-evidence identity. Twilio does not provide exactly-once semantics for this request.';
COMMENT ON COLUMN "team_call_operations"."provider_idempotency_supported" IS
  'Always false. A durable dispatched row must be reconciled and must never be automatically redispatched.';
