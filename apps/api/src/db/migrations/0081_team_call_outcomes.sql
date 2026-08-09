-- Manual-call outcome integrity. Provider API acceptance starts an active
-- operation; only authenticated Twilio callbacks can automatically settle a
-- customer outcome and complete the exact task snapshots captured at dispatch.

ALTER TABLE "team_call_operations"
  ADD COLUMN IF NOT EXISTS "provider_customer_operation_id" text,
  ADD COLUMN IF NOT EXISTS "attempt_audit_event_id" uuid,
  ADD COLUMN IF NOT EXISTS "provider_accepted_audit_event_id" uuid,
  ADD COLUMN IF NOT EXISTS "terminal_outcome" text,
  ADD COLUMN IF NOT EXISTS "outcome_reason" text,
  ADD COLUMN IF NOT EXISTS "provider_accepted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "agent_answered_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "customer_answered_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "agent_completed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "customer_completed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "callback_deadline_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "guard_released_at" timestamp with time zone;

ALTER TABLE "team_call_operations"
  ADD COLUMN IF NOT EXISTS "legacy_completed_explicit_task_id" uuid,
  ADD COLUMN IF NOT EXISTS "legacy_completed_followup_task_id" uuid,
  ADD COLUMN IF NOT EXISTS "legacy_completed_speed_to_lead_count" integer DEFAULT 0 NOT NULL;

-- Compatibility backfills intentionally reshape the pre-0081 lifecycle.
-- Disable the old transition trigger only inside this migration; the stricter
-- replacement is installed again below before the transaction can commit.
DROP TRIGGER IF EXISTS "team_call_operation_transition"
  ON "team_call_operations";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'team_call_operations_attempt_audit_event_fk'
  ) THEN
    ALTER TABLE "team_call_operations"
      ADD CONSTRAINT "team_call_operations_attempt_audit_event_fk"
      FOREIGN KEY ("attempt_audit_event_id")
      REFERENCES "audit_logs"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'team_call_operations_provider_accepted_audit_event_fk'
  ) THEN
    ALTER TABLE "team_call_operations"
      ADD CONSTRAINT "team_call_operations_provider_accepted_audit_event_fk"
      FOREIGN KEY ("provider_accepted_audit_event_id")
      REFERENCES "audit_logs"("id") ON DELETE RESTRICT;
  END IF;
END;
$$;

-- Compatibility evidence for a database on which 0078/0080 was manually
-- applied. Official environments are expected to have no call rows yet, but a
-- missing attempted event must never be papered over by a nullable constraint.
WITH missing_attempts AS (
  SELECT
    o."id" AS operation_id,
    gen_random_uuid() AS audit_id,
    o."actor_member_id",
    o."actor_label",
    o."actor_role",
    o."session_id",
    o."auth_method",
    o."correlation_id",
    o."idempotency_key_hash",
    o."contact_id",
    o."requested_at"
  FROM "team_call_operations" o
  WHERE o."state" <> 'requested'
    AND o."attempt_audit_event_id" IS NULL
), inserted_attempts AS (
  INSERT INTO "audit_logs" (
    "id", "actor_type", "actor_id", "actor_label", "actor_role",
    "session_id", "auth_method", "correlation_id", "required_permissions",
    "outcome", "idempotency_key_hash", "action", "entity_type", "entity_id",
    "meta", "created_at"
  )
  SELECT
    m.audit_id, 'human', m."actor_member_id", m."actor_label", m."actor_role",
    m."session_id", m."auth_method", m."correlation_id", ARRAY['calls.place'],
    'attempted', m."idempotency_key_hash", 'call.started', 'contact',
    m."contact_id"::text,
    jsonb_build_object(
      'callOperationId', m.operation_id,
      'migrationBackfill', true,
      'providerCalled', true,
      'outcome', 'attempted'
    ),
    m."requested_at"
  FROM missing_attempts m
  RETURNING "id", ("meta" ->> 'callOperationId')::uuid AS operation_id
)
UPDATE "team_call_operations" o
SET "attempt_audit_event_id" = i."id"
FROM inserted_attempts i
WHERE o."id" = i.operation_id;

-- A legacy succeeded row represented Twilio API acceptance, not a connected
-- customer. Quarantine it rather than falsely reclassifying it as connected.
UPDATE "team_call_operations"
SET
  "state" = 'reconciliation_required',
  "version" = "version" + 1,
  "provider_accepted_at" = coalesce("provider_accepted_at", "completed_at"),
  "reconciliation_required_at" = coalesce(
    "reconciliation_required_at", "completed_at", now()
  ),
  "failure_code" = 'legacy_provider_acceptance_requires_reconciliation',
  "failure_detail" = 'Legacy success proved provider acceptance only; customer outcome and prior task effects require review.',
  "legacy_completed_explicit_task_id" = "completed_explicit_task_id",
  "legacy_completed_followup_task_id" = "completed_followup_task_id",
  "legacy_completed_speed_to_lead_count" = "completed_speed_to_lead_count",
  "completed_explicit_task_id" = NULL,
  "completed_followup_task_id" = NULL,
  "completed_speed_to_lead_count" = 0,
  "guard_released_at" = NULL,
  "terminal_outcome" = NULL,
  "outcome_reason" = NULL,
  "callback_deadline_at" = coalesce("callback_deadline_at", now()),
  "updated_at" = now()
WHERE "state" = 'succeeded';

UPDATE "team_call_operations"
SET
  "terminal_outcome" = 'not_dispatched',
  "outcome_reason" = coalesce("outcome_reason", "failure_code", 'provider_rejected'),
  "guard_released_at" = coalesce("guard_released_at", "completed_at", now()),
  "callback_deadline_at" = coalesce("callback_deadline_at", "completed_at", now())
WHERE "state" = 'failed';

UPDATE "team_call_operations"
SET "callback_deadline_at" = coalesce(
  "callback_deadline_at",
  "dispatched_at" + interval '4 hours'
)
WHERE "state" <> 'requested';

-- Correct the old reconciliation semantics. Confirming only that Twilio
-- accepted a call does not prove it is terminal and cannot release the guard.
UPDATE "team_call_operations" o
SET
  "reconciliation_resolution_id" = NULL,
  "reconciliation_resolved_at" = NULL,
  "guard_released_at" = NULL,
  "terminal_outcome" = NULL,
  "outcome_reason" = NULL,
  "version" = o."version" + 1,
  "updated_at" = now()
FROM "team_call_operation_reconciliations" r
WHERE o."reconciliation_resolution_id" = r."id"
  AND r."outcome" = 'confirmed_sent';

UPDATE "team_call_operations" o
SET
  "terminal_outcome" = 'not_dispatched',
  "outcome_reason" = 'operator_confirmed_not_dispatched',
  "guard_released_at" = coalesce(
    o."guard_released_at", o."reconciliation_resolved_at", r."created_at"
  )
FROM "team_call_operation_reconciliations" r
WHERE o."reconciliation_resolution_id" = r."id"
  AND r."outcome" = 'confirmed_not_sent';

ALTER TABLE "team_call_operations"
  DROP CONSTRAINT IF EXISTS "team_call_operations_state_check",
  DROP CONSTRAINT IF EXISTS "team_call_operations_provider_operation_check",
  DROP CONSTRAINT IF EXISTS "team_call_operations_task_count_check",
  DROP CONSTRAINT IF EXISTS "team_call_operations_lifecycle_check";

ALTER TABLE "team_call_operations"
  ADD CONSTRAINT "team_call_operations_state_check"
    CHECK ("state" IN (
      'requested', 'dispatched', 'active', 'succeeded', 'failed',
      'reconciliation_required'
    )),
  ADD CONSTRAINT "team_call_operations_provider_operation_check"
    CHECK (
      "provider_operation_id" IS NULL
      OR "provider_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  ADD CONSTRAINT "team_call_operations_provider_customer_operation_check"
    CHECK (
      "provider_customer_operation_id" IS NULL
      OR "provider_customer_operation_id" ~ '^CA[0-9A-Fa-f]{32}$'
    ),
  ADD CONSTRAINT "team_call_operations_terminal_outcome_check"
    CHECK (
      "terminal_outcome" IS NULL
      OR "terminal_outcome" IN ('connected', 'not_connected', 'not_dispatched')
    ),
  ADD CONSTRAINT "team_call_operations_task_count_check"
    CHECK (
      "completed_speed_to_lead_count" >= 0
      AND "legacy_completed_speed_to_lead_count" >= 0
    ),
  ADD CONSTRAINT "team_call_operations_lifecycle_check"
    CHECK (
      (
        "state" = 'requested'
        AND "dispatched_at" IS NULL
        AND "attempt_audit_event_id" IS NULL
        AND "callback_deadline_at" IS NULL
        AND "guard_released_at" IS NULL
        AND "completed_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "provider_customer_operation_id" IS NULL
        AND "provider_accepted_audit_event_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "terminal_outcome" IS NULL
        AND "outcome_reason" IS NULL
      ) OR (
        "state" = 'dispatched'
        AND "dispatched_at" IS NOT NULL
        AND "attempt_audit_event_id" IS NOT NULL
        AND "callback_deadline_at" IS NOT NULL
        AND "guard_released_at" IS NULL
        AND "completed_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "provider_accepted_audit_event_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "terminal_outcome" IS NULL
        AND "outcome_reason" IS NULL
      ) OR (
        "state" = 'active'
        AND "dispatched_at" IS NOT NULL
        AND "attempt_audit_event_id" IS NOT NULL
        AND "callback_deadline_at" IS NOT NULL
        AND "guard_released_at" IS NULL
        AND "completed_at" IS NULL
        AND "provider_operation_id" IS NOT NULL
        AND "provider_accepted_at" IS NOT NULL
        AND "provider_accepted_audit_event_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NULL
        AND "terminal_outcome" IS NULL
        AND "outcome_reason" IS NULL
      ) OR (
        "state" = 'succeeded'
        AND "attempt_audit_event_id" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "guard_released_at" IS NOT NULL
        AND "terminal_outcome" = 'connected'
        AND "outcome_reason" IS NOT NULL
        AND "provider_operation_id" IS NOT NULL
        AND "provider_customer_operation_id" IS NOT NULL
        AND "provider_accepted_audit_event_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NOT NULL
      ) OR (
        "state" = 'failed'
        AND "attempt_audit_event_id" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "guard_released_at" IS NOT NULL
        AND "terminal_outcome" IN ('not_connected', 'not_dispatched')
        AND "outcome_reason" IS NOT NULL
        AND (
          "terminal_outcome" <> 'not_connected'
          OR "provider_accepted_audit_event_id" IS NOT NULL
        )
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND "completed_explicit_task_id" IS NULL
        AND "completed_followup_task_id" IS NULL
        AND "completed_speed_to_lead_count" = 0
      ) OR (
        "state" = 'reconciliation_required'
        AND "attempt_audit_event_id" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "reconciliation_required_at" IS NOT NULL
        AND (
          (
            "reconciliation_resolution_id" IS NULL
            AND "reconciliation_resolved_at" IS NULL
            AND "guard_released_at" IS NULL
            AND "terminal_outcome" IS NULL
            AND "outcome_reason" IS NULL
          ) OR (
            "reconciliation_resolution_id" IS NOT NULL
            AND "reconciliation_resolved_at" IS NOT NULL
            AND "guard_released_at" IS NOT NULL
            AND "terminal_outcome" IS NOT NULL
            AND "outcome_reason" IS NOT NULL
          )
        )
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND (
          "terminal_outcome" = 'connected'
          OR (
            "completed_explicit_task_id" IS NULL
            AND "completed_followup_task_id" IS NULL
            AND "completed_speed_to_lead_count" = 0
          )
        )
      )
    );

DROP INDEX IF EXISTS "team_call_operations_active_contact_key";
CREATE INDEX "team_call_operations_active_contact_key"
  ON "team_call_operations" ("contact_id")
  WHERE "guard_released_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  "team_call_operations_provider_customer_operation_key"
  ON "team_call_operations" ("provider_customer_operation_id")
  WHERE "provider_customer_operation_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  "team_call_operations_attempt_audit_event_key"
  ON "team_call_operations" ("attempt_audit_event_id")
  WHERE "attempt_audit_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  "team_call_operations_provider_accepted_audit_event_key"
  ON "team_call_operations" ("provider_accepted_audit_event_id")
  WHERE "provider_accepted_audit_event_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "team_call_operation_callback_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_operation_id" uuid NOT NULL REFERENCES "team_call_operations"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "leg" text NOT NULL,
  "semantic_hash" varchar(64) NOT NULL,
  "parent_call_sid" text,
  "customer_call_sid" text,
  "status" text,
  "duration_sec" integer,
  "bridged" boolean,
  "apply_result" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_call_callback_events_kind_check"
    CHECK ("kind" IN ('connect', 'agent_status', 'customer_status', 'dial_action')),
  CONSTRAINT "team_call_callback_events_leg_check"
    CHECK ("leg" IN ('agent', 'customer')),
  CONSTRAINT "team_call_callback_events_hash_check"
    CHECK ("semantic_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_call_callback_events_parent_sid_check"
    CHECK ("parent_call_sid" IS NULL OR "parent_call_sid" ~ '^CA[0-9A-Fa-f]{32}$'),
  CONSTRAINT "team_call_callback_events_customer_sid_check"
    CHECK ("customer_call_sid" IS NULL OR "customer_call_sid" ~ '^CA[0-9A-Fa-f]{32}$'),
  CONSTRAINT "team_call_callback_events_duration_check"
    CHECK ("duration_sec" IS NULL OR "duration_sec" >= 0),
  CONSTRAINT "team_call_callback_events_apply_result_check"
    CHECK ("apply_result" IN ('applied', 'late', 'anomaly')),
  CONSTRAINT "team_call_callback_events_status_check"
    CHECK (
      "status" IS NULL OR "status" IN (
        'queued', 'initiated', 'ringing', 'answered', 'in-progress',
        'completed', 'busy', 'no-answer', 'failed', 'canceled'
      )
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_call_callback_events_semantic_key"
  ON "team_call_operation_callback_events" ("call_operation_id", "semantic_hash");
CREATE INDEX IF NOT EXISTS "team_call_callback_events_operation_received_idx"
  ON "team_call_operation_callback_events" ("call_operation_id", "received_at", "id");

CREATE TABLE IF NOT EXISTS "team_call_operation_task_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_operation_id" uuid NOT NULL REFERENCES "team_call_operations"("id") ON DELETE RESTRICT,
  "task_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "expected_contact_id" uuid NOT NULL,
  "expected_assigned_to" text NOT NULL,
  "expected_updated_at" timestamp with time zone NOT NULL,
  "effect" text DEFAULT 'pending' NOT NULL,
  "effect_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_call_task_intents_kind_check"
    CHECK ("kind" IN ('explicit', 'speed_to_lead', 'follow_up')),
  CONSTRAINT "team_call_task_intents_effect_check"
    CHECK ("effect" IN ('pending', 'completed', 'stale', 'already_terminal', 'not_connected', 'not_dispatched')),
  CONSTRAINT "team_call_task_intents_effect_time_check"
    CHECK (
      ("effect" = 'pending' AND "effect_at" IS NULL)
      OR ("effect" <> 'pending' AND "effect_at" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_call_task_intents_operation_task_kind_key"
  ON "team_call_operation_task_intents" ("call_operation_id", "task_id", "kind");
CREATE INDEX IF NOT EXISTS "team_call_task_intents_operation_effect_idx"
  ON "team_call_operation_task_intents" ("call_operation_id", "effect", "task_id");

ALTER TABLE "team_call_operation_reconciliations"
  DROP CONSTRAINT IF EXISTS "team_call_reconciliations_outcome_check",
  DROP CONSTRAINT IF EXISTS "team_call_reconciliations_evidence_outcome_check";
DROP INDEX IF EXISTS "team_call_reconciliations_decisive_operation_key";
ALTER TABLE "team_call_operation_reconciliations"
  ADD CONSTRAINT "team_call_reconciliations_outcome_check"
    CHECK ("outcome" IN (
      'confirmed_connected', 'confirmed_not_connected',
      'confirmed_not_dispatched', 'confirmed_active',
      'confirmed_sent', 'confirmed_not_sent', 'still_uncertain'
    )),
  ADD CONSTRAINT "team_call_reconciliations_evidence_outcome_check"
    CHECK (
      (
        "outcome" IN (
          'confirmed_connected', 'confirmed_not_connected',
          'confirmed_active', 'confirmed_sent'
        )
        AND "provider_operation_id" IS NOT NULL
        AND "evidence_type" IN ('provider_call_record', 'provider_support_response')
      ) OR (
        "outcome" IN ('confirmed_not_dispatched', 'confirmed_not_sent')
        AND "provider_operation_id" IS NULL
        AND "evidence_type" IN ('provider_no_matching_call', 'provider_support_response')
      ) OR "outcome" = 'still_uncertain'
    );
CREATE UNIQUE INDEX "team_call_reconciliations_decisive_operation_key"
  ON "team_call_operation_reconciliations" ("call_operation_id")
  WHERE "outcome" IN (
    'confirmed_connected', 'confirmed_not_connected',
    'confirmed_not_dispatched', 'confirmed_not_sent'
  );

CREATE OR REPLACE FUNCTION enforce_team_call_callback_event_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'team_call_callback_event_append_only';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "team_call_callback_event_append_only"
  ON "team_call_operation_callback_events";
CREATE TRIGGER "team_call_callback_event_append_only"
BEFORE UPDATE OR DELETE ON "team_call_operation_callback_events"
FOR EACH ROW EXECUTE FUNCTION enforce_team_call_callback_event_append_only();

CREATE OR REPLACE FUNCTION enforce_team_call_task_intent_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'team_call_task_intent_delete_forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."call_operation_id" IS DISTINCT FROM OLD."call_operation_id"
       OR NEW."task_id" IS DISTINCT FROM OLD."task_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."expected_contact_id" IS DISTINCT FROM OLD."expected_contact_id"
       OR NEW."expected_assigned_to" IS DISTINCT FROM OLD."expected_assigned_to"
       OR NEW."expected_updated_at" IS DISTINCT FROM OLD."expected_updated_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR OLD."effect" <> 'pending'
       OR NEW."effect" = 'pending'
       OR NEW."effect_at" IS NULL THEN
      RAISE EXCEPTION 'team_call_task_intent_invalid_transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "team_call_task_intent_transition"
  ON "team_call_operation_task_intents";
CREATE TRIGGER "team_call_task_intent_transition"
BEFORE UPDATE OR DELETE ON "team_call_operation_task_intents"
FOR EACH ROW EXECUTE FUNCTION enforce_team_call_task_intent_transition();

CREATE OR REPLACE FUNCTION enforce_team_call_operation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolution_operation_id uuid;
  resolution_outcome text;
  resolution_created_at timestamp with time zone;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."contact_id"::text, 0));
  IF NEW."guard_released_at" IS NULL
     AND EXISTS (
       SELECT 1
       FROM "team_call_operations" existing
       WHERE existing."contact_id" = NEW."contact_id"
         AND existing."guard_released_at" IS NULL
         AND existing."id" <> NEW."id"
     ) THEN
    RAISE EXCEPTION 'team_call_operation_contact_guard_conflict';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested' OR NEW."version" <> 1 THEN
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
     OR NEW."legacy_completed_explicit_task_id" IS DISTINCT FROM OLD."legacy_completed_explicit_task_id"
     OR NEW."legacy_completed_followup_task_id" IS DISTINCT FROM OLD."legacy_completed_followup_task_id"
     OR NEW."legacy_completed_speed_to_lead_count" IS DISTINCT FROM OLD."legacy_completed_speed_to_lead_count"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'team_call_operation_identity_immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'team_call_operation_version_must_increment';
  END IF;
  IF OLD."attempt_audit_event_id" IS NOT NULL
     AND NEW."attempt_audit_event_id" IS DISTINCT FROM OLD."attempt_audit_event_id" THEN
    RAISE EXCEPTION 'team_call_operation_attempt_audit_immutable';
  END IF;
  IF OLD."provider_accepted_audit_event_id" IS NOT NULL
     AND NEW."provider_accepted_audit_event_id" IS DISTINCT FROM OLD."provider_accepted_audit_event_id" THEN
    RAISE EXCEPTION 'team_call_operation_provider_accepted_audit_immutable';
  END IF;
  IF OLD."provider_operation_id" IS NOT NULL
     AND NEW."provider_operation_id" IS DISTINCT FROM OLD."provider_operation_id" THEN
    RAISE EXCEPTION 'team_call_operation_parent_sid_immutable';
  END IF;
  IF OLD."provider_customer_operation_id" IS NOT NULL
     AND NEW."provider_customer_operation_id" IS DISTINCT FROM OLD."provider_customer_operation_id" THEN
    RAISE EXCEPTION 'team_call_operation_customer_sid_immutable';
  END IF;

  IF OLD."state" IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'team_call_operation_terminal_immutable';
  END IF;
  IF OLD."state" = 'requested' AND NEW."state" <> 'dispatched' THEN
    RAISE EXCEPTION 'team_call_operation_invalid_requested_transition';
  END IF;
  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('active', 'succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'team_call_operation_invalid_dispatched_transition';
  END IF;
  IF OLD."state" = 'active'
     AND NEW."state" NOT IN ('active', 'succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'team_call_operation_invalid_active_transition';
  END IF;

  IF OLD."state" = 'reconciliation_required' THEN
    SELECT "call_operation_id", "outcome", "created_at"
      INTO resolution_operation_id, resolution_outcome, resolution_created_at
    FROM "team_call_operation_reconciliations"
    WHERE "id" = NEW."reconciliation_resolution_id";

    IF OLD."reconciliation_resolution_id" IS NOT NULL
       OR NEW."state" <> OLD."state"
       OR NEW."reconciliation_resolution_id" IS NULL
       OR NEW."reconciliation_resolved_at" IS NULL
       OR NEW."guard_released_at" IS NULL
       OR NEW."terminal_outcome" IS NULL
       OR NEW."provider_operation_id" IS DISTINCT FROM OLD."provider_operation_id"
       OR NEW."provider_customer_operation_id" IS DISTINCT FROM OLD."provider_customer_operation_id"
       OR NEW."terminal_audit_event_id" IS DISTINCT FROM OLD."terminal_audit_event_id"
       OR NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at"
       OR NEW."provider_accepted_at" IS DISTINCT FROM OLD."provider_accepted_at"
       OR NEW."agent_answered_at" IS DISTINCT FROM OLD."agent_answered_at"
       OR NEW."customer_answered_at" IS DISTINCT FROM OLD."customer_answered_at"
       OR NEW."agent_completed_at" IS DISTINCT FROM OLD."agent_completed_at"
       OR NEW."customer_completed_at" IS DISTINCT FROM OLD."customer_completed_at"
       OR NEW."callback_deadline_at" IS DISTINCT FROM OLD."callback_deadline_at"
       OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
       OR NEW."reconciliation_required_at" IS DISTINCT FROM OLD."reconciliation_required_at"
       OR NEW."provider_status" IS DISTINCT FROM OLD."provider_status"
       OR NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
       OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"
       OR (
         resolution_outcome <> 'confirmed_connected'
         AND (
           NEW."completed_explicit_task_id" IS DISTINCT FROM OLD."completed_explicit_task_id"
           OR NEW."completed_followup_task_id" IS DISTINCT FROM OLD."completed_followup_task_id"
           OR NEW."completed_speed_to_lead_count" IS DISTINCT FROM OLD."completed_speed_to_lead_count"
         )
       ) THEN
      RAISE EXCEPTION 'team_call_operation_terminal_immutable';
    END IF;

    IF resolution_operation_id IS DISTINCT FROM OLD."id"
       OR resolution_outcome NOT IN (
         'confirmed_connected', 'confirmed_not_connected',
         'confirmed_not_dispatched', 'confirmed_not_sent'
       ) THEN
      RAISE EXCEPTION 'team_call_operation_invalid_resolution';
    END IF;
    IF NEW."terminal_outcome" IS DISTINCT FROM (CASE resolution_outcome
         WHEN 'confirmed_connected' THEN 'connected'
         WHEN 'confirmed_not_connected' THEN 'not_connected'
         WHEN 'confirmed_not_dispatched' THEN 'not_dispatched'
         WHEN 'confirmed_not_sent' THEN 'not_dispatched'
       END)
       OR NEW."outcome_reason" IS DISTINCT FROM (CASE resolution_outcome
         WHEN 'confirmed_connected' THEN 'operator_confirmed_connected'
         WHEN 'confirmed_not_connected' THEN 'operator_confirmed_not_connected'
         WHEN 'confirmed_not_dispatched' THEN 'operator_confirmed_not_dispatched'
         WHEN 'confirmed_not_sent' THEN 'operator_confirmed_not_dispatched'
       END) THEN
      RAISE EXCEPTION 'team_call_operation_resolution_outcome_mismatch';
    END IF;
    NEW."reconciliation_resolved_at" := resolution_created_at;
    NEW."guard_released_at" := resolution_created_at;
  END IF;

  IF OLD."state" <> 'reconciliation_required'
     AND (NEW."reconciliation_resolution_id" IS NOT NULL
       OR NEW."reconciliation_resolved_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'team_call_operation_invalid_resolution';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "team_call_operation_transition"
BEFORE INSERT OR UPDATE ON "team_call_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_team_call_operation_transition();

CREATE OR REPLACE FUNCTION enforce_team_call_operation_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'team_call_operation_delete_forbidden';
END;
$$;
DROP TRIGGER IF EXISTS "team_call_operation_no_delete"
  ON "team_call_operations";
CREATE TRIGGER "team_call_operation_no_delete"
BEFORE DELETE ON "team_call_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_team_call_operation_no_delete();

CREATE OR REPLACE FUNCTION enforce_team_call_evidence_no_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'team_call_evidence_truncate_forbidden';
END;
$$;

DROP TRIGGER IF EXISTS "team_call_operations_no_truncate"
  ON "team_call_operations";
CREATE TRIGGER "team_call_operations_no_truncate"
BEFORE TRUNCATE ON "team_call_operations"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_team_call_evidence_no_truncate();

DROP TRIGGER IF EXISTS "team_call_callback_events_no_truncate"
  ON "team_call_operation_callback_events";
CREATE TRIGGER "team_call_callback_events_no_truncate"
BEFORE TRUNCATE ON "team_call_operation_callback_events"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_team_call_evidence_no_truncate();

DROP TRIGGER IF EXISTS "team_call_task_intents_no_truncate"
  ON "team_call_operation_task_intents";
CREATE TRIGGER "team_call_task_intents_no_truncate"
BEFORE TRUNCATE ON "team_call_operation_task_intents"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_team_call_evidence_no_truncate();

DROP TRIGGER IF EXISTS "team_call_reconciliations_no_truncate"
  ON "team_call_operation_reconciliations";
CREATE TRIGGER "team_call_reconciliations_no_truncate"
BEFORE TRUNCATE ON "team_call_operation_reconciliations"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_team_call_evidence_no_truncate();

COMMENT ON COLUMN "team_call_operations"."guard_released_at" IS
  'Null is the durable per-contact call guard. It is released only by a definitive terminal callback, definitive provider rejection, or decisive reconciliation.';
COMMENT ON TABLE "team_call_operation_callback_events" IS
  'Privacy-safe append-only facts from X-Twilio-Signature-verified callbacks; raw bodies, signatures, credentials, and phone numbers are prohibited.';
COMMENT ON TABLE "team_call_operation_task_intents" IS
  'Task snapshots captured before provider dispatch. Only a signed connected dial-action may automatically complete an unchanged pending snapshot.';
