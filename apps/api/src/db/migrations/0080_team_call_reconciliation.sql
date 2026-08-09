-- Replace the borrowed sales.write authority with explicit call capabilities.
-- Existing custom roles/grants that could place calls retain that capability;
-- existing sales-wide member denies continue to deny it. Built-in office can
-- reconcile, sales and crew can place calls, and read-only receives neither.
UPDATE team_roles
SET permissions = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(permissions, ARRAY[]::text[]) || ARRAY['calls.place']
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
WHERE lower(trim(slug)) IN ('office', 'sales', 'crew')
   OR 'sales.write' = ANY(coalesce(permissions, ARRAY[]::text[]));

UPDATE team_roles
SET permissions = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(permissions, ARRAY[]::text[]) || ARRAY['calls.reconcile']
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
WHERE lower(trim(slug)) = 'office';

UPDATE team_members
SET permissions_grant = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(permissions_grant, ARRAY[]::text[]) || ARRAY['calls.place']
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
WHERE 'sales.write' = ANY(coalesce(permissions_grant, ARRAY[]::text[]));

UPDATE team_members
SET permissions_deny = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(permissions_deny, ARRAY[]::text[]) || ARRAY['calls.place']
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
WHERE 'sales.write' = ANY(coalesce(permissions_deny, ARRAY[]::text[]))
   OR 'sales.*' = ANY(coalesce(permissions_deny, ARRAY[]::text[]));

-- Append-only operator evidence. These records describe what a verified
-- reviewer supplied after checking Twilio; they do not rewrite the original
-- provider result stored on team_call_operations.
CREATE TABLE IF NOT EXISTS "team_call_operation_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_operation_id" uuid NOT NULL,
  "mutation_claim_id" uuid NOT NULL,
  "reviewer_member_id" uuid NOT NULL,
  "reviewer_label" text,
  "reviewer_role" text,
  "reviewer_session_id" uuid NOT NULL,
  "reviewer_auth_method" text NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "expected_operation_version" integer NOT NULL,
  "outcome" text NOT NULL,
  "evidence_type" text NOT NULL,
  "provider_operation_id" text,
  "provider_status" integer,
  "reason" text NOT NULL,
  "audit_event_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_call_reconciliations_operation_fk"
    FOREIGN KEY ("call_operation_id")
    REFERENCES "team_call_operations"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "team_call_reconciliations_audit_event_fk"
    FOREIGN KEY ("audit_event_id")
    REFERENCES "audit_logs"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "team_call_reconciliations_outcome_check"
    CHECK ("outcome" IN ('confirmed_sent', 'confirmed_not_sent', 'still_uncertain')),
  CONSTRAINT "team_call_reconciliations_evidence_type_check"
    CHECK (
      "evidence_type" IN (
        'provider_call_record',
        'provider_no_matching_call',
        'provider_support_response',
        'operator_investigation'
      )
    ),
  CONSTRAINT "team_call_reconciliations_auth_method_check"
    CHECK ("reviewer_auth_method" IN ('team_session', 'break_glass')),
  CONSTRAINT "team_call_reconciliations_version_check"
    CHECK ("expected_operation_version" > 0),
  CONSTRAINT "team_call_reconciliations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_call_reconciliations_provider_operation_check"
    CHECK (
      "provider_operation_id" IS NULL
      OR "provider_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "team_call_reconciliations_provider_status_check"
    CHECK ("provider_status" IS NULL OR "provider_status" BETWEEN 100 AND 599),
  CONSTRAINT "team_call_reconciliations_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 1000),
  CONSTRAINT "team_call_reconciliations_evidence_outcome_check"
    CHECK (
      (
        "outcome" = 'confirmed_sent'
        AND "provider_operation_id" IS NOT NULL
        AND "evidence_type" IN ('provider_call_record', 'provider_support_response')
      ) OR (
        "outcome" = 'confirmed_not_sent'
        AND "provider_operation_id" IS NULL
        AND "evidence_type" IN ('provider_no_matching_call', 'provider_support_response')
      ) OR "outcome" = 'still_uncertain'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_reconciliations_mutation_claim_key"
  ON "team_call_operation_reconciliations" ("mutation_claim_id");

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_reconciliations_reviewer_request_key"
  ON "team_call_operation_reconciliations" (
    "reviewer_member_id",
    "idempotency_key_hash"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "team_call_reconciliations_decisive_operation_key"
  ON "team_call_operation_reconciliations" ("call_operation_id")
  WHERE "outcome" IN ('confirmed_sent', 'confirmed_not_sent');

CREATE INDEX IF NOT EXISTS "team_call_reconciliations_operation_created_idx"
  ON "team_call_operation_reconciliations" (
    "call_operation_id",
    "created_at",
    "id"
  );

ALTER TABLE "team_call_operations"
  ADD COLUMN IF NOT EXISTS "reconciliation_resolution_id" uuid,
  ADD COLUMN IF NOT EXISTS "reconciliation_resolved_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'team_call_operations_resolution_fk'
  ) THEN
    ALTER TABLE "team_call_operations"
      ADD CONSTRAINT "team_call_operations_resolution_fk"
      FOREIGN KEY ("reconciliation_resolution_id")
      REFERENCES "team_call_operation_reconciliations"("id")
      ON DELETE RESTRICT;
  END IF;
END;
$$;

DROP INDEX IF EXISTS "team_call_operations_active_contact_key";
CREATE UNIQUE INDEX "team_call_operations_active_contact_key"
  ON "team_call_operations" ("contact_id")
  WHERE "state" IN ('requested', 'dispatched')
     OR (
       "state" = 'reconciliation_required'
       AND "reconciliation_resolution_id" IS NULL
     );

ALTER TABLE "team_call_operations"
  DROP CONSTRAINT IF EXISTS "team_call_operations_lifecycle_check";
ALTER TABLE "team_call_operations"
  ADD CONSTRAINT "team_call_operations_lifecycle_check"
  CHECK (
    (
      "state" = 'requested'
      AND "dispatched_at" IS NULL
      AND "completed_at" IS NULL
      AND "reconciliation_required_at" IS NULL
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
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
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
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
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
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
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
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
      AND (
        (
          "reconciliation_resolution_id" IS NULL
          AND "reconciliation_resolved_at" IS NULL
        ) OR (
          "reconciliation_resolution_id" IS NOT NULL
          AND "reconciliation_resolved_at" IS NOT NULL
          AND "reconciliation_resolved_at" >= "reconciliation_required_at"
        )
      )
      AND "terminal_audit_event_id" IS NOT NULL
      AND "failure_code" IS NOT NULL
      AND "failure_detail" IS NOT NULL
      AND "completed_explicit_task_id" IS NULL
      AND "completed_followup_task_id" IS NULL
      AND "completed_speed_to_lead_count" = 0
    )
  );

CREATE OR REPLACE FUNCTION enforce_team_call_reconciliation_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'team_call_reconciliation_append_only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "team_call_reconciliation_append_only"
  ON "team_call_operation_reconciliations";
CREATE TRIGGER "team_call_reconciliation_append_only"
BEFORE UPDATE OR DELETE ON "team_call_operation_reconciliations"
FOR EACH ROW
EXECUTE FUNCTION enforce_team_call_reconciliation_append_only();

-- Terminal provider evidence remains immutable. The sole allowed terminal
-- update links one decisive append-only review and records its timestamp.
CREATE OR REPLACE FUNCTION enforce_team_call_operation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolution_operation_id uuid;
  resolution_outcome text;
  resolution_created_at timestamp with time zone;
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

  IF OLD."state" IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'team_call_operation_terminal_immutable';
  END IF;

  IF OLD."state" = 'reconciliation_required' THEN
    IF OLD."reconciliation_resolution_id" IS NOT NULL
       OR NEW."state" <> OLD."state"
       OR NEW."reconciliation_resolution_id" IS NULL
       OR NEW."reconciliation_resolved_at" IS NULL
       OR NEW."provider_operation_id" IS DISTINCT FROM OLD."provider_operation_id"
       OR NEW."terminal_audit_event_id" IS DISTINCT FROM OLD."terminal_audit_event_id"
       OR NEW."completed_explicit_task_id" IS DISTINCT FROM OLD."completed_explicit_task_id"
       OR NEW."completed_followup_task_id" IS DISTINCT FROM OLD."completed_followup_task_id"
       OR NEW."completed_speed_to_lead_count" IS DISTINCT FROM OLD."completed_speed_to_lead_count"
       OR NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at"
       OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
       OR NEW."reconciliation_required_at" IS DISTINCT FROM OLD."reconciliation_required_at"
       OR NEW."provider_status" IS DISTINCT FROM OLD."provider_status"
       OR NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
       OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail" THEN
      RAISE EXCEPTION 'team_call_operation_terminal_immutable';
    END IF;

    SELECT "call_operation_id", "outcome", "created_at"
      INTO resolution_operation_id, resolution_outcome, resolution_created_at
    FROM "team_call_operation_reconciliations"
    WHERE "id" = NEW."reconciliation_resolution_id";

    IF resolution_operation_id IS DISTINCT FROM OLD."id"
       OR resolution_outcome NOT IN ('confirmed_sent', 'confirmed_not_sent') THEN
      RAISE EXCEPTION 'team_call_operation_invalid_resolution';
    END IF;

    NEW."reconciliation_resolved_at" := resolution_created_at;
    NEW."updated_at" := now();
    RETURN NEW;
  END IF;

  IF OLD."state" = 'requested'
     AND NEW."state" <> 'dispatched' THEN
    RAISE EXCEPTION 'team_call_operation_invalid_requested_transition';
  END IF;

  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'team_call_operation_invalid_dispatched_transition';
  END IF;

  IF NEW."reconciliation_resolution_id" IS NOT NULL
     OR NEW."reconciliation_resolved_at" IS NOT NULL THEN
    RAISE EXCEPTION 'team_call_operation_invalid_resolution';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

COMMENT ON TABLE "team_call_operation_reconciliations" IS
  'Append-only operator-supplied evidence for quarantined manual calls. Records never rewrite the original provider outcome.';
COMMENT ON COLUMN "team_call_operation_reconciliations"."provider_operation_id" IS
  'Optional Twilio SID copied from reviewer-supplied evidence; it is not an independent Stonegate verification claim.';
COMMENT ON COLUMN "team_call_operations"."reconciliation_resolution_id" IS
  'One decisive append-only review that releases the per-contact call block without rewriting provider outcome evidence.';
