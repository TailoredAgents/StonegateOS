-- Durable, append-only evidence for worker-initiated sales escalation calls.
-- Twilio does not honor a CRM idempotency key, so crossing the provider
-- boundary is recorded before I/O and an uncertain attempt is never redialed.

-- Quarantine is also needed for provider operations that are not attached to
-- a contact (for example, a corrupt recording-delete event). Contact-linked
-- quarantine remains populated whenever a contact exists.
ALTER TABLE "outbox_events"
  DROP CONSTRAINT IF EXISTS "outbox_quarantine_state_check";
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_quarantine_state_check"
  CHECK (
    (
      "quarantined_at" IS NULL
      AND "quarantine_reason" IS NULL
      AND "quarantined_contact_id" IS NULL
    ) OR (
      "quarantined_at" IS NOT NULL
      AND "quarantine_reason" IS NOT NULL
    )
  );

CREATE TABLE "sales_escalation_call_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outbox_event_id" uuid NOT NULL REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "attempt_number" integer NOT NULL,
  "task_id" uuid NOT NULL,
  "task_updated_at" timestamp with time zone NOT NULL,
  "contact_id" uuid NOT NULL,
  "agent_member_id" uuid NOT NULL,
  "agent_phone_e164" text NOT NULL,
  "customer_phone_e164" text NOT NULL,
  "mode" text NOT NULL,
  "state" text DEFAULT 'requested' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "provider" text DEFAULT 'twilio' NOT NULL,
  "provider_request_key" uuid NOT NULL,
  "provider_operation_id" text,
  "provider_customer_operation_id" text,
  "provider_idempotency_supported" boolean DEFAULT false NOT NULL,
  "delivery_certainty" text,
  "provider_status" integer,
  "failure_code" text,
  "failure_detail" text,
  "retryable" boolean,
  "requested_audit_event_id" uuid NOT NULL REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "dispatch_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "provider_result_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "provider_accepted_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "terminal_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "provider_accepted_at" timestamp with time zone,
  "reconciliation_required_at" timestamp with time zone,
  "agent_answered_at" timestamp with time zone,
  "customer_dial_requested_at" timestamp with time zone,
  "customer_answered_at" timestamp with time zone,
  "customer_completed_at" timestamp with time zone,
  "callback_deadline_at" timestamp with time zone,
  "terminal_outcome" text,
  "outcome_reason" text,
  "task_effect" text DEFAULT 'pending' NOT NULL,
  "task_effect_at" timestamp with time zone,
  "terminal_at" timestamp with time zone,
  "guard_released_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_escalation_call_operations_attempt_check"
    CHECK ("attempt_number" >= 1 AND "attempt_number" <= 3),
  CONSTRAINT "sales_escalation_call_operations_version_check"
    CHECK ("version" >= 1),
  CONSTRAINT "sales_escalation_call_operations_phone_check"
    CHECK (
      "agent_phone_e164" ~ '^\\+[1-9][0-9]{7,14}$'
      AND "customer_phone_e164" ~ '^\\+[1-9][0-9]{7,14}$'
    ),
  CONSTRAINT "sales_escalation_call_operations_mode_check"
    CHECK ("mode" IN ('instant', 'scheduled')),
  CONSTRAINT "sales_escalation_call_operations_state_check"
    CHECK ("state" IN (
      'requested', 'dispatched', 'succeeded', 'failed',
      'reconciliation_required'
    )),
  CONSTRAINT "sales_escalation_call_operations_provider_check"
    CHECK ("provider" = 'twilio' AND "provider_idempotency_supported" = false),
  CONSTRAINT "sales_escalation_call_operations_parent_sid_check"
    CHECK (
      "provider_operation_id" IS NULL
      OR "provider_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "sales_escalation_call_operations_customer_sid_check"
    CHECK (
      "provider_customer_operation_id" IS NULL
      OR "provider_customer_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "sales_escalation_call_operations_certainty_check"
    CHECK (
      "delivery_certainty" IS NULL
      OR "delivery_certainty" IN ('not_sent', 'accepted', 'uncertain')
    ),
  CONSTRAINT "sales_escalation_call_operations_terminal_outcome_check"
    CHECK (
      "terminal_outcome" IS NULL
      OR "terminal_outcome" IN ('connected', 'not_connected', 'not_dispatched')
    ),
  CONSTRAINT "sales_escalation_call_operations_task_effect_check"
    CHECK (
      "task_effect" IN ('pending', 'completed', 'stale', 'already_terminal', 'not_connected', 'not_dispatched')
      AND (
        ("task_effect" = 'pending' AND "task_effect_at" IS NULL)
        OR ("task_effect" <> 'pending' AND "task_effect_at" IS NOT NULL)
      )
    ),
  CONSTRAINT "sales_escalation_call_operations_lifecycle_check"
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
        AND (
          ("terminal_outcome" IS NULL AND "terminal_at" IS NULL AND "guard_released_at" IS NULL AND "terminal_audit_event_id" IS NULL AND "task_effect" = 'pending')
          OR
          (
            "terminal_outcome" IN ('connected', 'not_connected')
            AND "terminal_at" IS NOT NULL
            AND "guard_released_at" IS NOT NULL
            AND "terminal_audit_event_id" IS NOT NULL
            AND "outcome_reason" IS NOT NULL
            AND (
              ("terminal_outcome" = 'connected' AND "task_effect" IN ('completed', 'stale', 'already_terminal'))
              OR ("terminal_outcome" = 'not_connected' AND "task_effect" = 'not_connected')
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
        AND "terminal_outcome" IS NULL
        AND "task_effect" = 'pending'
        AND "terminal_at" IS NULL
        AND "guard_released_at" IS NULL
        AND (
          ("delivery_certainty" = 'uncertain' AND "provider_accepted_audit_event_id" IS NULL)
          OR (
            "delivery_certainty" = 'accepted'
            AND "provider_operation_id" IS NOT NULL
            AND "provider_accepted_at" IS NOT NULL
            AND "provider_accepted_audit_event_id" IS NOT NULL
          )
        )
      )
    )
);

CREATE UNIQUE INDEX "sales_escalation_call_operations_event_attempt_key"
  ON "sales_escalation_call_operations" ("outbox_event_id", "attempt_number");
CREATE UNIQUE INDEX "sales_escalation_call_operations_task_attempt_key"
  ON "sales_escalation_call_operations" ("task_id", "attempt_number");
CREATE UNIQUE INDEX "sales_escalation_call_operations_provider_request_key"
  ON "sales_escalation_call_operations" ("provider_request_key");
CREATE UNIQUE INDEX "sales_escalation_call_operations_provider_operation_key"
  ON "sales_escalation_call_operations" ("provider_operation_id")
  WHERE "provider_operation_id" IS NOT NULL;
CREATE UNIQUE INDEX "sales_escalation_call_operations_customer_sid_key"
  ON "sales_escalation_call_operations" ("provider_customer_operation_id")
  WHERE "provider_customer_operation_id" IS NOT NULL;
CREATE UNIQUE INDEX "sales_escalation_call_operations_unresolved_event_key"
  ON "sales_escalation_call_operations" ("outbox_event_id")
  WHERE "guard_released_at" IS NULL;
CREATE UNIQUE INDEX "sales_escalation_call_operations_unresolved_task_key"
  ON "sales_escalation_call_operations" ("task_id")
  WHERE "guard_released_at" IS NULL;
CREATE UNIQUE INDEX "sales_escalation_call_operations_provider_crossed_task_key"
  ON "sales_escalation_call_operations" ("task_id")
  WHERE "delivery_certainty" IN ('accepted', 'uncertain');
CREATE INDEX "sales_escalation_call_operations_task_idx"
  ON "sales_escalation_call_operations" ("task_id", "created_at");
CREATE INDEX "sales_escalation_call_operations_contact_idx"
  ON "sales_escalation_call_operations" ("contact_id", "created_at");

CREATE TABLE "sales_escalation_call_callback_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_id" uuid NOT NULL REFERENCES "sales_escalation_call_operations"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "leg" text NOT NULL,
  "semantic_hash" varchar(64) NOT NULL,
  "parent_call_sid" text NOT NULL,
  "customer_call_sid" text,
  "status" text,
  "duration_sec" integer,
  "bridged" boolean,
  "apply_result" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_escalation_callback_kind_check"
  CHECK ("kind" IN ('agent_connect', 'customer_dial_requested', 'agent_status', 'customer_status', 'dial_action')),
  CONSTRAINT "sales_escalation_callback_leg_check"
    CHECK ("leg" IN ('agent', 'customer')),
  CONSTRAINT "sales_escalation_callback_hash_check"
    CHECK ("semantic_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sales_escalation_callback_parent_sid_check"
    CHECK ("parent_call_sid" ~ '^CA[0-9A-Fa-f]{32}$'),
  CONSTRAINT "sales_escalation_callback_customer_sid_check"
    CHECK (
      "customer_call_sid" IS NULL
      OR "customer_call_sid" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  CONSTRAINT "sales_escalation_callback_status_check"
    CHECK (
      "status" IS NULL OR "status" IN (
        'queued', 'initiated', 'ringing', 'answered', 'in-progress',
        'completed', 'busy', 'no-answer', 'failed', 'canceled'
      )
    ),
  CONSTRAINT "sales_escalation_callback_duration_check"
    CHECK ("duration_sec" IS NULL OR ("duration_sec" >= 0 AND "duration_sec" <= 86400)),
  CONSTRAINT "sales_escalation_callback_apply_result_check"
    CHECK ("apply_result" IN ('applied', 'duplicate', 'late', 'anomaly'))
);
CREATE UNIQUE INDEX "sales_escalation_callback_semantic_key"
  ON "sales_escalation_call_callback_events" ("operation_id", "semantic_hash");
CREATE INDEX "sales_escalation_callback_operation_received_idx"
  ON "sales_escalation_call_callback_events" ("operation_id", "received_at", "id");

CREATE OR REPLACE FUNCTION enforce_sales_escalation_operation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'sales_escalation_operation_invalid_initial_state';
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
  IF OLD."terminal_at" IS NOT NULL THEN
    RAISE EXCEPTION 'sales_escalation_operation_terminal_immutable';
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

CREATE TRIGGER "sales_escalation_operation_transition"
BEFORE INSERT OR UPDATE ON "sales_escalation_call_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_operation_transition();

CREATE OR REPLACE FUNCTION enforce_sales_escalation_evidence_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'sales_escalation_evidence_append_only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "sales_escalation_operation_no_delete"
BEFORE DELETE ON "sales_escalation_call_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_evidence_append_only();
CREATE TRIGGER "sales_escalation_callback_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "sales_escalation_call_callback_events"
FOR EACH ROW EXECUTE FUNCTION enforce_sales_escalation_evidence_append_only();

CREATE OR REPLACE FUNCTION enforce_sales_escalation_no_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales_escalation_evidence_truncate_forbidden';
END;
$$;
CREATE TRIGGER "sales_escalation_operations_no_truncate"
BEFORE TRUNCATE ON "sales_escalation_call_operations"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_sales_escalation_no_truncate();
CREATE TRIGGER "sales_escalation_callbacks_no_truncate"
BEFORE TRUNCATE ON "sales_escalation_call_callback_events"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_sales_escalation_no_truncate();

COMMENT ON TABLE "sales_escalation_call_operations" IS
  'Durable worker-call attempt ledger. Dispatched or uncertain attempts are never automatically sent again.';
COMMENT ON TABLE "sales_escalation_call_callback_events" IS
  'Append-only privacy-safe facts from signature-verified Twilio callbacks; raw bodies, signatures, credentials, and phone numbers are prohibited.';
