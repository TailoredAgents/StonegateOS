-- Give ambiguous partner access-link dispatches an append-only, human-reviewed
-- release path. Provider I/O is never retried by this migration or by the
-- recovery worker: a reviewer must first attach conclusive provider evidence.

ALTER TABLE "partner_invite_operations"
  ADD COLUMN "resolution" text,
  ADD COLUMN "resolution_evidence" text,
  ADD COLUMN "resolved_at" timestamp with time zone,
  ADD COLUMN "resolved_by" uuid REFERENCES "team_members"("id") ON DELETE RESTRICT,
  ADD COLUMN "resolution_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT;

ALTER TABLE "partner_invite_operations"
  ADD CONSTRAINT "partner_invite_operations_resolution_check"
  CHECK (
    (
      "resolution" IS NULL
      AND "resolution_evidence" IS NULL
      AND "resolved_at" IS NULL
      AND "resolved_by" IS NULL
      AND "resolution_audit_event_id" IS NULL
    ) OR (
      "state" = 'reconciliation_required'
      AND "resolution" IN ('confirmed_sent', 'confirmed_not_sent')
      AND length("resolution_evidence") BETWEEN 20 AND 1000
      AND "resolved_at" IS NOT NULL
      AND "resolved_at" >= "reconciliation_required_at"
      AND "resolved_by" IS NOT NULL
      AND "resolution_audit_event_id" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "partner_invite_operations_resolution_audit_key"
  ON "partner_invite_operations" ("resolution_audit_event_id")
  WHERE "resolution_audit_event_id" IS NOT NULL;

DROP INDEX "partner_invite_operations_unresolved_target_key";
CREATE UNIQUE INDEX "partner_invite_operations_unresolved_target_key"
  ON "partner_invite_operations" ("partner_user_id")
  WHERE "state" IN ('requested', 'dispatched', 'reconciliation_required')
    AND "resolved_at" IS NULL;

CREATE OR REPLACE FUNCTION enforce_partner_invite_operation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'partner_invite_operation_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  -- A reconciliation resolution is the only permitted update to a terminal
  -- operation. Every original provider fact remains byte-for-byte immutable.
  IF OLD."state" = 'reconciliation_required'
     AND OLD."resolved_at" IS NULL
     AND NEW."state" = 'reconciliation_required'
     AND NEW."version" = OLD."version" + 1
     AND NEW."resolution" IN ('confirmed_sent', 'confirmed_not_sent')
     AND NEW."resolution_evidence" IS NOT NULL
     AND NEW."resolved_at" IS NOT NULL
     AND NEW."resolved_by" IS NOT NULL
     AND NEW."resolution_audit_event_id" IS NOT NULL
     AND (
       to_jsonb(NEW) - ARRAY[
         'version', 'resolution', 'resolution_evidence', 'resolved_at',
         'resolved_by', 'resolution_audit_event_id', 'updated_at'
       ]::text[]
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY[
         'version', 'resolution', 'resolution_evidence', 'resolved_at',
         'resolved_by', 'resolution_audit_event_id', 'updated_at'
       ]::text[]
     ) THEN
    NEW."updated_at" := now();
    RETURN NEW;
  END IF;

  IF NEW."resolution" IS DISTINCT FROM OLD."resolution"
     OR NEW."resolution_evidence" IS DISTINCT FROM OLD."resolution_evidence"
     OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
     OR NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"
     OR NEW."resolution_audit_event_id" IS DISTINCT FROM OLD."resolution_audit_event_id" THEN
    RAISE EXCEPTION 'partner_invite_operation_resolution_immutable';
  END IF;

  IF NEW."org_contact_id" IS DISTINCT FROM OLD."org_contact_id"
     OR NEW."partner_user_id" IS DISTINCT FROM OLD."partner_user_id"
     OR NEW."operation_kind" IS DISTINCT FROM OLD."operation_kind"
     OR NEW."initiator_type" IS DISTINCT FROM OLD."initiator_type"
     OR NEW."semantic_hash" IS DISTINCT FROM OLD."semantic_hash"
     OR NEW."requested_channels" IS DISTINCT FROM OLD."requested_channels"
     OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
     OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
     OR NEW."actor_member_id" IS DISTINCT FROM OLD."actor_member_id"
     OR NEW."actor_role" IS DISTINCT FROM OLD."actor_role"
     OR NEW."actor_label" IS DISTINCT FROM OLD."actor_label"
     OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
     OR NEW."auth_method" IS DISTINCT FROM OLD."auth_method"
     OR NEW."provider_request_key" IS DISTINCT FROM OLD."provider_request_key"
     OR NEW."requested_audit_event_id" IS DISTINCT FROM OLD."requested_audit_event_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'partner_invite_operation_identity_immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'partner_invite_operation_version_must_increment';
  END IF;
  IF OLD."dispatch_audit_event_id" IS NOT NULL
     AND NEW."dispatch_audit_event_id" IS DISTINCT FROM OLD."dispatch_audit_event_id" THEN
    RAISE EXCEPTION 'partner_invite_operation_dispatch_audit_immutable';
  END IF;
  IF OLD."terminal_audit_event_id" IS NOT NULL
     AND NEW."terminal_audit_event_id" IS DISTINCT FROM OLD."terminal_audit_event_id" THEN
    RAISE EXCEPTION 'partner_invite_operation_terminal_audit_immutable';
  END IF;
  IF OLD."provider_operation_ids" <> '{}'::text[]
     AND NEW."provider_operation_ids" IS DISTINCT FROM OLD."provider_operation_ids" THEN
    RAISE EXCEPTION 'partner_invite_operation_provider_evidence_immutable';
  END IF;
  IF OLD."provider_evidence" <> '[]'::jsonb
     AND NEW."provider_evidence" IS DISTINCT FROM OLD."provider_evidence" THEN
    RAISE EXCEPTION 'partner_invite_operation_provider_evidence_immutable';
  END IF;
  IF OLD."state" IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'partner_invite_operation_terminal_immutable';
  END IF;

  IF OLD."state" = 'requested'
     AND NOT (
       NEW."state" = 'dispatched'
       OR (NEW."state" = 'failed' AND NEW."quarantined_at" IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'partner_invite_operation_invalid_requested_transition';
  END IF;
  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'partner_invite_operation_invalid_dispatched_transition';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "partner_invite_operations"."resolution" IS
  'Conclusive operator-reviewed provider outcome. Resolving releases the resend guard but never performs a send.';
