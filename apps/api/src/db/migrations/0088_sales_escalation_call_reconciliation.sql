-- Human review for worker-initiated Twilio calls that are quarantined after
-- crossing the provider boundary. Reviews are append-only, version-checked,
-- and never send or replay a provider request.

ALTER TABLE "sales_escalation_call_operations"
  ADD COLUMN "reconciliation_resolution_id" uuid,
  ADD COLUMN "reconciliation_resolved_at" timestamp with time zone;

CREATE TABLE "sales_escalation_call_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_id" uuid NOT NULL REFERENCES "sales_escalation_call_operations"("id") ON DELETE RESTRICT,
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
  "provider_customer_operation_id" text,
  "provider_call_status" text,
  "provider_customer_status" text,
  "connected_duration_sec" integer,
  "reason" text NOT NULL,
  "audit_event_id" uuid NOT NULL REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_escalation_call_reconciliations_outcome_check"
    CHECK ("outcome" IN (
      'confirmed_dispatched', 'confirmed_connected',
      'confirmed_not_dispatched'
    )),
  CONSTRAINT "sales_escalation_call_reconciliations_evidence_type_check"
    CHECK ("evidence_type" IN (
      'provider_call_record', 'provider_no_matching_call',
      'provider_support_response'
    )),
  CONSTRAINT "sales_escalation_call_reconciliations_auth_method_check"
    CHECK ("reviewer_auth_method" IN ('team_session', 'break_glass')),
  CONSTRAINT "sales_escalation_call_reconciliations_version_check"
    CHECK ("expected_operation_version" > 0),
  CONSTRAINT "sales_escalation_call_reconciliations_correlation_check"
    CHECK (length("correlation_id") BETWEEN 8 AND 128),
  CONSTRAINT "sales_escalation_call_reconciliations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sales_escalation_call_reconciliations_parent_sid_check"
    CHECK (
      "provider_operation_id" IS NULL
      OR "provider_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "sales_escalation_call_reconciliations_customer_sid_check"
    CHECK (
      "provider_customer_operation_id" IS NULL
      OR "provider_customer_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "sales_escalation_call_reconciliations_parent_status_check"
    CHECK (
      "provider_call_status" IS NULL OR "provider_call_status" IN (
        'queued', 'initiated', 'ringing', 'answered', 'in-progress',
        'completed', 'busy', 'no-answer', 'failed', 'canceled'
      )
    ),
  CONSTRAINT "sales_escalation_call_reconciliations_customer_status_check"
    CHECK (
      "provider_customer_status" IS NULL OR "provider_customer_status" IN (
        'queued', 'initiated', 'ringing', 'answered', 'in-progress',
        'completed', 'busy', 'no-answer', 'failed', 'canceled'
      )
    ),
  CONSTRAINT "sales_escalation_call_reconciliations_duration_check"
    CHECK (
      "connected_duration_sec" IS NULL
      OR "connected_duration_sec" BETWEEN 1 AND 86400
    ),
  CONSTRAINT "sales_escalation_call_reconciliations_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 1000),
  CONSTRAINT "sales_escalation_call_reconciliations_evidence_outcome_check"
    CHECK (
      (
        "outcome" = 'confirmed_dispatched'
        AND "evidence_type" IN ('provider_call_record', 'provider_support_response')
        AND "provider_operation_id" IS NOT NULL
        AND "provider_call_status" IS NOT NULL
        AND "provider_customer_operation_id" IS NULL
        AND "provider_customer_status" IS NULL
        AND "connected_duration_sec" IS NULL
      ) OR (
        "outcome" = 'confirmed_connected'
        AND "evidence_type" IN ('provider_call_record', 'provider_support_response')
        AND "provider_operation_id" IS NOT NULL
        AND "provider_customer_operation_id" IS NOT NULL
        AND "provider_call_status" = 'completed'
        AND "provider_customer_status" = 'completed'
        AND "connected_duration_sec" BETWEEN 1 AND 86400
      ) OR (
        "outcome" = 'confirmed_not_dispatched'
        AND "evidence_type" IN ('provider_no_matching_call', 'provider_support_response')
        AND "provider_operation_id" IS NULL
        AND "provider_customer_operation_id" IS NULL
        AND "provider_call_status" IS NULL
        AND "provider_customer_status" IS NULL
        AND "connected_duration_sec" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "sales_escalation_call_reconciliations_mutation_claim_key"
  ON "sales_escalation_call_reconciliations" ("mutation_claim_id");
CREATE UNIQUE INDEX "sales_escalation_call_reconciliations_reviewer_request_key"
  ON "sales_escalation_call_reconciliations" (
    "reviewer_member_id", "idempotency_key_hash"
  );
CREATE UNIQUE INDEX "sales_escalation_call_reconciliations_audit_event_key"
  ON "sales_escalation_call_reconciliations" ("audit_event_id");
CREATE UNIQUE INDEX "sales_escalation_call_reconciliations_decisive_operation_key"
  ON "sales_escalation_call_reconciliations" ("operation_id")
  WHERE "outcome" IN ('confirmed_connected', 'confirmed_not_dispatched');
CREATE INDEX "sales_escalation_call_reconciliations_operation_created_idx"
  ON "sales_escalation_call_reconciliations" (
    "operation_id", "created_at", "id"
  );

-- A ledger can contain repeated reviews for one operation, so a unique index
-- directly on its parent SID would reject a valid dispatched -> connected
-- progression. This ownership table instead enforces SID -> operation/leg.
CREATE TABLE "sales_escalation_call_reconciliation_sid_claims" (
  "sid" text PRIMARY KEY NOT NULL,
  "operation_id" uuid NOT NULL REFERENCES "sales_escalation_call_operations"("id") ON DELETE RESTRICT,
  "leg" text NOT NULL,
  "first_reconciliation_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_escalation_call_reconciliation_sid_claims_first_review_fk"
    FOREIGN KEY ("first_reconciliation_id")
    REFERENCES "sales_escalation_call_reconciliations"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "sales_escalation_call_reconciliation_sid_claims_sid_check"
    CHECK ("sid" ~ '^CA[0-9A-Fa-f]{32}$'),
  CONSTRAINT "sales_escalation_call_reconciliation_sid_claims_leg_check"
    CHECK ("leg" IN ('parent', 'customer'))
);
CREATE UNIQUE INDEX "sales_escalation_call_reconciliation_sid_claims_operation_leg_key"
  ON "sales_escalation_call_reconciliation_sid_claims" (
    "operation_id", "leg"
  );
CREATE INDEX "sales_escalation_call_reconciliation_sid_claims_operation_idx"
  ON "sales_escalation_call_reconciliation_sid_claims" (
    "operation_id", "created_at"
  );

ALTER TABLE "sales_escalation_call_operations"
  ADD CONSTRAINT "sales_escalation_call_operations_resolution_fk"
  FOREIGN KEY ("reconciliation_resolution_id")
  REFERENCES "sales_escalation_call_reconciliations"("id")
  ON DELETE RESTRICT;

ALTER TABLE "sales_escalation_call_operations"
  DROP CONSTRAINT "sales_escalation_call_operations_lifecycle_check";
ALTER TABLE "sales_escalation_call_operations"
  ADD CONSTRAINT "sales_escalation_call_operations_lifecycle_check"
  CHECK (
    (
      "state" = 'requested'
      AND "dispatched_at" IS NULL
      AND "dispatch_audit_event_id" IS NULL
      AND "provider_result_audit_event_id" IS NULL
      AND "provider_accepted_audit_event_id" IS NULL
      AND "retryable" IS NULL
      AND "delivery_certainty" IS NULL
      AND "provider_operation_id" IS NULL
      AND "provider_accepted_at" IS NULL
      AND "reconciliation_required_at" IS NULL
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
      AND "terminal_at" IS NULL
      AND "guard_released_at" IS NULL
    ) OR (
      "state" = 'dispatched'
      AND "dispatched_at" IS NOT NULL
      AND "dispatch_audit_event_id" IS NOT NULL
      AND "provider_result_audit_event_id" IS NULL
      AND "provider_accepted_audit_event_id" IS NULL
      AND "retryable" IS NULL
      AND "delivery_certainty" IS NULL
      AND "provider_operation_id" IS NULL
      AND "provider_accepted_at" IS NULL
      AND "reconciliation_required_at" IS NULL
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
      AND "terminal_at" IS NULL
      AND "guard_released_at" IS NULL
    ) OR (
      "state" = 'succeeded'
      AND "dispatched_at" IS NOT NULL
      AND "dispatch_audit_event_id" IS NOT NULL
      AND "provider_result_audit_event_id" IS NOT NULL
      AND "provider_accepted_audit_event_id" IS NOT NULL
      AND "retryable" = false
      AND "delivery_certainty" = 'accepted'
      AND "provider_operation_id" IS NOT NULL
      AND "provider_accepted_at" IS NOT NULL
      AND "reconciliation_required_at" IS NULL
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
      AND (
        (
          "terminal_outcome" IS NULL
          AND "terminal_at" IS NULL
          AND "guard_released_at" IS NULL
          AND "terminal_audit_event_id" IS NULL
          AND "task_effect" = 'pending'
        ) OR (
          "terminal_outcome" IN ('connected', 'not_connected')
          AND "terminal_at" IS NOT NULL
          AND "guard_released_at" IS NOT NULL
          AND "terminal_audit_event_id" IS NOT NULL
          AND "outcome_reason" IS NOT NULL
          AND (
            (
              "terminal_outcome" = 'connected'
              AND "task_effect" IN ('completed', 'stale', 'already_terminal')
            ) OR (
              "terminal_outcome" = 'not_connected'
              AND "task_effect" = 'not_connected'
            )
          )
        )
      )
    ) OR (
      "state" = 'failed'
      AND "dispatched_at" IS NOT NULL
      AND "dispatch_audit_event_id" IS NOT NULL
      AND "provider_result_audit_event_id" IS NOT NULL
      AND "provider_accepted_audit_event_id" IS NULL
      AND "retryable" IS NOT NULL
      AND "delivery_certainty" = 'not_sent'
      AND "provider_operation_id" IS NULL
      AND "provider_accepted_at" IS NULL
      AND "reconciliation_required_at" IS NULL
      AND "reconciliation_resolution_id" IS NULL
      AND "reconciliation_resolved_at" IS NULL
      AND "failure_code" IS NOT NULL
      AND "failure_detail" IS NOT NULL
      AND "task_effect" = 'not_dispatched'
      AND "terminal_outcome" = 'not_dispatched'
      AND "terminal_at" IS NOT NULL
      AND "guard_released_at" IS NOT NULL
    ) OR (
      "state" = 'reconciliation_required'
      AND "dispatched_at" IS NOT NULL
      AND "dispatch_audit_event_id" IS NOT NULL
      AND "provider_result_audit_event_id" IS NOT NULL
      AND "retryable" = false
      AND "delivery_certainty" IN ('uncertain', 'accepted')
      AND "reconciliation_required_at" IS NOT NULL
      AND "failure_code" IS NOT NULL
      AND "failure_detail" IS NOT NULL
      AND (
        (
          "delivery_certainty" = 'uncertain'
          AND "provider_accepted_audit_event_id" IS NULL
        ) OR (
          "delivery_certainty" = 'accepted'
          AND "provider_operation_id" IS NOT NULL
          AND "provider_accepted_at" IS NOT NULL
          AND "provider_accepted_audit_event_id" IS NOT NULL
        )
      )
      AND (
        (
          "reconciliation_resolution_id" IS NULL
          AND "reconciliation_resolved_at" IS NULL
          AND "terminal_outcome" IS NULL
          AND "outcome_reason" IS NULL
          AND "task_effect" = 'pending'
          AND "terminal_audit_event_id" IS NULL
          AND "terminal_at" IS NULL
          AND "guard_released_at" IS NULL
        ) OR (
          "reconciliation_resolution_id" IS NOT NULL
          AND "reconciliation_resolved_at" IS NOT NULL
          AND "reconciliation_resolved_at" >= "reconciliation_required_at"
          AND "terminal_audit_event_id" IS NOT NULL
          AND "terminal_at" IS NOT NULL
          AND "guard_released_at" IS NOT NULL
          AND (
            (
              "terminal_outcome" = 'connected'
              AND "outcome_reason" = 'operator_confirmed_connected'
              AND "provider_operation_id" IS NOT NULL
              AND "provider_customer_operation_id" IS NOT NULL
              AND "task_effect" IN ('completed', 'stale', 'already_terminal')
            ) OR (
              "terminal_outcome" = 'not_dispatched'
              AND "outcome_reason" = 'operator_confirmed_not_dispatched'
              AND "delivery_certainty" = 'uncertain'
              AND "provider_operation_id" IS NULL
              AND "provider_customer_operation_id" IS NULL
              AND "provider_accepted_at" IS NULL
              AND "provider_accepted_audit_event_id" IS NULL
              AND "task_effect" = 'not_dispatched'
            )
          )
        )
      )
    )
  );

-- Keep the original provider/callback facts immutable. The special resolution
-- branch verifies the linked append-only row and permits only the fields that
-- a decisive human review is allowed to settle.
CREATE OR REPLACE FUNCTION enforce_sales_escalation_operation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolution_operation_id uuid;
  resolution_outcome text;
  resolution_parent_sid text;
  resolution_customer_sid text;
  resolution_audit_event_id uuid;
  resolution_created_at timestamp with time zone;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'sales_escalation_operation_invalid_initial_state';
    END IF;
    IF NEW."reconciliation_resolution_id" IS NOT NULL
       OR NEW."reconciliation_resolved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'sales_escalation_operation_invalid_resolution';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."outbox_event_id" IS DISTINCT FROM OLD."outbox_event_id"
     OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
     OR NEW."task_id" IS DISTINCT FROM OLD."task_id"
     OR NEW."task_updated_at" IS DISTINCT FROM OLD."task_updated_at"
     OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
     OR NEW."agent_member_id" IS DISTINCT FROM OLD."agent_member_id"
     OR NEW."agent_phone_e164" IS DISTINCT FROM OLD."agent_phone_e164"
     OR NEW."customer_phone_e164" IS DISTINCT FROM OLD."customer_phone_e164"
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."provider_request_key" IS DISTINCT FROM OLD."provider_request_key"
     OR NEW."provider_idempotency_supported" IS DISTINCT FROM OLD."provider_idempotency_supported"
     OR NEW."requested_audit_event_id" IS DISTINCT FROM OLD."requested_audit_event_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_identity_immutable';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'sales_escalation_operation_version_must_increment';
  END IF;
  IF OLD."provider_operation_id" IS NOT NULL
     AND NEW."provider_operation_id" IS DISTINCT FROM OLD."provider_operation_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_parent_sid_immutable';
  END IF;
  IF OLD."provider_customer_operation_id" IS NOT NULL
     AND NEW."provider_customer_operation_id" IS DISTINCT FROM OLD."provider_customer_operation_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_customer_sid_immutable';
  END IF;
  IF OLD."dispatch_audit_event_id" IS NOT NULL
     AND NEW."dispatch_audit_event_id" IS DISTINCT FROM OLD."dispatch_audit_event_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_dispatch_audit_immutable';
  END IF;
  IF OLD."provider_result_audit_event_id" IS NOT NULL
     AND NEW."provider_result_audit_event_id" IS DISTINCT FROM OLD."provider_result_audit_event_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_provider_audit_immutable';
  END IF;
  IF OLD."provider_accepted_audit_event_id" IS NOT NULL
     AND NEW."provider_accepted_audit_event_id" IS DISTINCT FROM OLD."provider_accepted_audit_event_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_provider_accepted_audit_immutable';
  END IF;
  IF OLD."terminal_audit_event_id" IS NOT NULL
     AND NEW."terminal_audit_event_id" IS DISTINCT FROM OLD."terminal_audit_event_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_terminal_audit_immutable';
  END IF;
  IF OLD."agent_answered_at" IS NOT NULL
     AND NEW."agent_answered_at" IS DISTINCT FROM OLD."agent_answered_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_callback_evidence_immutable';
  END IF;
  IF OLD."customer_dial_requested_at" IS NOT NULL
     AND NEW."customer_dial_requested_at" IS DISTINCT FROM OLD."customer_dial_requested_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_callback_evidence_immutable';
  END IF;
  IF OLD."customer_answered_at" IS NOT NULL
     AND NEW."customer_answered_at" IS DISTINCT FROM OLD."customer_answered_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_callback_evidence_immutable';
  END IF;
  IF OLD."customer_completed_at" IS NOT NULL
     AND NEW."customer_completed_at" IS DISTINCT FROM OLD."customer_completed_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_callback_evidence_immutable';
  END IF;
  IF OLD."reconciliation_resolution_id" IS NOT NULL
     AND NEW."reconciliation_resolution_id" IS DISTINCT FROM OLD."reconciliation_resolution_id" THEN
    RAISE EXCEPTION 'sales_escalation_operation_resolution_immutable';
  END IF;
  IF OLD."reconciliation_resolved_at" IS NOT NULL
     AND NEW."reconciliation_resolved_at" IS DISTINCT FROM OLD."reconciliation_resolved_at" THEN
    RAISE EXCEPTION 'sales_escalation_operation_resolution_immutable';
  END IF;
  IF OLD."terminal_at" IS NOT NULL THEN
    RAISE EXCEPTION 'sales_escalation_operation_terminal_immutable';
  END IF;

  IF OLD."state" = 'reconciliation_required'
     AND OLD."reconciliation_resolution_id" IS NULL
     AND NEW."state" = 'reconciliation_required'
     AND NEW."reconciliation_resolution_id" IS NOT NULL THEN
    SELECT
      "operation_id", "outcome", "provider_operation_id",
      "provider_customer_operation_id", "audit_event_id", "created_at"
    INTO
      resolution_operation_id, resolution_outcome, resolution_parent_sid,
      resolution_customer_sid, resolution_audit_event_id,
      resolution_created_at
    FROM "sales_escalation_call_reconciliations"
    WHERE "id" = NEW."reconciliation_resolution_id";

    IF resolution_operation_id IS DISTINCT FROM OLD."id"
       OR resolution_outcome NOT IN (
         'confirmed_connected', 'confirmed_not_dispatched'
       )
       OR NEW."terminal_audit_event_id" IS DISTINCT FROM resolution_audit_event_id THEN
      RAISE EXCEPTION 'sales_escalation_operation_invalid_resolution';
    END IF;

    IF (
      to_jsonb(NEW) - ARRAY[
        'version', 'reconciliation_resolution_id',
        'reconciliation_resolved_at', 'provider_operation_id',
        'provider_customer_operation_id', 'terminal_audit_event_id',
        'terminal_outcome', 'outcome_reason', 'task_effect',
        'task_effect_at', 'terminal_at', 'guard_released_at', 'updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'version', 'reconciliation_resolution_id',
        'reconciliation_resolved_at', 'provider_operation_id',
        'provider_customer_operation_id', 'terminal_audit_event_id',
        'terminal_outcome', 'outcome_reason', 'task_effect',
        'task_effect_at', 'terminal_at', 'guard_released_at', 'updated_at'
      ]::text[]
    ) THEN
      RAISE EXCEPTION 'sales_escalation_operation_resolution_scope_invalid';
    END IF;

    IF resolution_outcome = 'confirmed_connected' AND NOT (
      NEW."provider_operation_id" = resolution_parent_sid
      AND NEW."provider_customer_operation_id" = resolution_customer_sid
      AND NEW."terminal_outcome" = 'connected'
      AND NEW."outcome_reason" = 'operator_confirmed_connected'
      AND NEW."task_effect" IN ('completed', 'stale', 'already_terminal')
      AND NEW."task_effect_at" IS NOT NULL
      AND NEW."terminal_at" IS NOT NULL
      AND NEW."guard_released_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'sales_escalation_operation_connected_resolution_invalid';
    END IF;

    IF resolution_outcome = 'confirmed_not_dispatched' AND NOT (
      resolution_parent_sid IS NULL
      AND resolution_customer_sid IS NULL
      AND NEW."delivery_certainty" = 'uncertain'
      AND NEW."provider_operation_id" IS NULL
      AND NEW."provider_customer_operation_id" IS NULL
      AND NEW."terminal_outcome" = 'not_dispatched'
      AND NEW."outcome_reason" = 'operator_confirmed_not_dispatched'
      AND NEW."task_effect" = 'not_dispatched'
      AND NEW."task_effect_at" IS NOT NULL
      AND NEW."terminal_at" IS NOT NULL
      AND NEW."guard_released_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'sales_escalation_operation_not_dispatched_resolution_invalid';
    END IF;

    NEW."reconciliation_resolved_at" := resolution_created_at;
    NEW."updated_at" := now();
    RETURN NEW;
  END IF;

  IF NEW."reconciliation_resolution_id" IS NOT NULL
     OR NEW."reconciliation_resolved_at" IS NOT NULL THEN
    RAISE EXCEPTION 'sales_escalation_operation_invalid_resolution';
  END IF;
  IF OLD."state" = 'requested' AND NEW."state" <> 'dispatched' THEN
    RAISE EXCEPTION 'sales_escalation_operation_invalid_requested_transition';
  END IF;
  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'sales_escalation_operation_invalid_dispatched_transition';
  END IF;
  IF OLD."state" = 'succeeded'
     AND NEW."state" NOT IN ('succeeded', 'reconciliation_required') THEN
    RAISE EXCEPTION 'sales_escalation_operation_invalid_succeeded_transition';
  END IF;
  IF OLD."state" = 'reconciliation_required'
     AND NEW."state" NOT IN ('reconciliation_required', 'succeeded') THEN
    RAISE EXCEPTION 'sales_escalation_operation_invalid_reconciliation_transition';
  END IF;
  IF OLD."state" = 'failed' THEN
    RAISE EXCEPTION 'sales_escalation_operation_terminal_immutable';
  END IF;
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "sales_escalation_reconciliation_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "sales_escalation_call_reconciliations"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_evidence_append_only();
CREATE TRIGGER "sales_escalation_reconciliation_sid_claim_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "sales_escalation_call_reconciliation_sid_claims"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_evidence_append_only();
CREATE TRIGGER "sales_escalation_reconciliations_no_truncate"
BEFORE TRUNCATE ON "sales_escalation_call_reconciliations"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_sales_escalation_no_truncate();
CREATE TRIGGER "sales_escalation_reconciliation_sid_claims_no_truncate"
BEFORE TRUNCATE ON "sales_escalation_call_reconciliation_sid_claims"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_sales_escalation_no_truncate();

-- Ledger inserts must be backed by immutable SID ownership. The deferred
-- first-review FK lets a transaction claim a SID immediately before inserting
-- the ledger row that introduced it, while still forbidding orphan claims at
-- commit.
CREATE OR REPLACE FUNCTION enforce_sales_escalation_reconciliation_sid_claims()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."outcome" = 'confirmed_not_dispatched' THEN
    IF EXISTS (
      SELECT 1
      FROM "sales_escalation_call_reconciliation_sid_claims" c
      WHERE c."operation_id" = NEW."operation_id"
    ) THEN
      RAISE EXCEPTION 'sales_escalation_reconciliation_prior_sid_conflict';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "sales_escalation_call_reconciliation_sid_claims" c
    WHERE c."sid" = NEW."provider_operation_id"
      AND c."operation_id" = NEW."operation_id"
      AND c."leg" = 'parent'
  ) THEN
    RAISE EXCEPTION 'sales_escalation_reconciliation_parent_sid_unclaimed';
  END IF;

  IF NEW."outcome" = 'confirmed_connected' AND NOT EXISTS (
    SELECT 1
    FROM "sales_escalation_call_reconciliation_sid_claims" c
    WHERE c."sid" = NEW."provider_customer_operation_id"
      AND c."operation_id" = NEW."operation_id"
      AND c."leg" = 'customer'
  ) THEN
    RAISE EXCEPTION 'sales_escalation_reconciliation_customer_sid_unclaimed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_escalation_reconciliation_sid_claim_guard"
BEFORE INSERT ON "sales_escalation_call_reconciliations"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_reconciliation_sid_claims();

COMMENT ON TABLE "sales_escalation_call_reconciliations" IS
  'Append-only human review evidence for quarantined sales escalation calls. Raw bodies, signatures, credentials, phone numbers, and provider replay are prohibited.';
COMMENT ON COLUMN "sales_escalation_call_operations"."reconciliation_resolution_id" IS
  'One decisive append-only human review that releases the call guard without changing the original provider certainty or failure evidence.';
COMMENT ON TABLE "sales_escalation_call_reconciliation_sid_claims" IS
  'Append-only ownership of operator-supplied Twilio SIDs. One SID and one operation leg can have only one immutable owner.';
