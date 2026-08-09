-- Durable semantic delivery boundary for partner portal access links.
-- Provider I/O is permitted only after a dispatched row and its audit event
-- commit. An unresolved row guards the partner user regardless of actor or
-- caller idempotency key, preventing an ambiguous invite from being resent.

CREATE TABLE "partner_invite_operations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE RESTRICT,
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users"("id") ON DELETE RESTRICT,
  "operation_kind" text DEFAULT 'team_invite' NOT NULL,
  "initiator_type" text DEFAULT 'team_member' NOT NULL,
  "semantic_hash" varchar(64) NOT NULL,
  "requested_channels" text[] NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "actor_member_id" uuid,
  "actor_role" text,
  "actor_label" text,
  "session_id" uuid,
  "auth_method" text,
  "state" "external_message_dispatch_state" DEFAULT 'requested' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "provider_request_key" uuid NOT NULL,
  "provider_operation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "provider_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "requested_audit_event_id" uuid NOT NULL REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "dispatch_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "terminal_audit_event_id" uuid REFERENCES "audit_logs"("id") ON DELETE RESTRICT,
  "failure_code" text,
  "failure_detail" text,
  "retryable" boolean,
  "quarantined_at" timestamp with time zone,
  "quarantined_by" uuid,
  "quarantine_reason" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "reconciliation_required_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_invite_operations_version_check"
    CHECK ("version" >= 1),
  CONSTRAINT "partner_invite_operations_semantic_hash_check"
    CHECK ("semantic_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_invite_operations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_invite_operations_operation_kind_check"
    CHECK ("operation_kind" IN ('team_invite', 'public_login_link')),
  CONSTRAINT "partner_invite_operations_channel_check"
    CHECK ("requested_channels" IN (ARRAY['email']::text[], ARRAY['email', 'sms']::text[])),
  CONSTRAINT "partner_invite_operations_initiator_check"
    CHECK (
      (
        "initiator_type" = 'team_member'
        AND "actor_member_id" IS NOT NULL
        AND "auth_method" IN ('team_session', 'break_glass')
      ) OR (
        "initiator_type" = 'public_request'
        AND "actor_member_id" IS NULL
        AND "session_id" IS NULL
        AND "auth_method" IS NULL
      )
    ),
  CONSTRAINT "partner_invite_operations_provider_evidence_check"
    CHECK (jsonb_typeof("provider_evidence") = 'array'),
  CONSTRAINT "partner_invite_operations_quarantine_check"
    CHECK (
      (
        "quarantined_at" IS NULL
        AND "quarantined_by" IS NULL
        AND "quarantine_reason" IS NULL
      ) OR (
        "quarantined_at" IS NOT NULL
        AND "quarantine_reason" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_invite_operations_lifecycle_check"
    CHECK (
      (
        "state" = 'requested'
        AND "dispatched_at" IS NULL
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "dispatch_audit_event_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
        AND "retryable" IS NULL
        AND "quarantined_at" IS NULL
      ) OR (
        "state" = 'dispatched'
        AND "dispatched_at" IS NOT NULL
        AND "dispatched_at" >= "requested_at"
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "dispatch_audit_event_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
        AND "retryable" IS NULL
        AND "quarantined_at" IS NULL
      ) OR (
        "state" = 'succeeded'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NULL
        AND "dispatch_audit_event_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
        AND "retryable" = false
        AND "quarantined_at" IS NULL
      ) OR (
        "state" = 'failed'
        AND "completed_at" IS NOT NULL
        AND "reconciliation_required_at" IS NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND (
          (
            "dispatched_at" IS NOT NULL
            AND "completed_at" >= "dispatched_at"
            AND "dispatch_audit_event_id" IS NOT NULL
            AND "retryable" = true
            AND "quarantined_at" IS NULL
          ) OR (
            "dispatched_at" IS NULL
            AND "dispatch_audit_event_id" IS NULL
            AND "retryable" = false
            AND "quarantined_at" IS NOT NULL
          )
        )
      ) OR (
        "state" = 'reconciliation_required'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NOT NULL
        AND "reconciliation_required_at" >= "dispatched_at"
        AND "dispatch_audit_event_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
        AND "retryable" = false
        AND "quarantined_at" IS NULL
      )
    )
);

CREATE INDEX "partner_invite_operations_semantic_idx"
  ON "partner_invite_operations" ("semantic_hash", "created_at");
CREATE UNIQUE INDEX "partner_invite_operations_actor_request_key"
  ON "partner_invite_operations" ("actor_member_id", "idempotency_key_hash")
  WHERE "actor_member_id" IS NOT NULL;
CREATE UNIQUE INDEX "partner_invite_operations_public_request_key"
  ON "partner_invite_operations" ("idempotency_key_hash")
  WHERE "initiator_type" = 'public_request';
CREATE UNIQUE INDEX "partner_invite_operations_unresolved_target_key"
  ON "partner_invite_operations" ("partner_user_id")
  WHERE "state" IN ('requested', 'dispatched', 'reconciliation_required');
CREATE UNIQUE INDEX "partner_invite_operations_provider_request_key"
  ON "partner_invite_operations" ("provider_request_key");
CREATE UNIQUE INDEX "partner_invite_operations_requested_audit_key"
  ON "partner_invite_operations" ("requested_audit_event_id");
CREATE UNIQUE INDEX "partner_invite_operations_dispatch_audit_key"
  ON "partner_invite_operations" ("dispatch_audit_event_id")
  WHERE "dispatch_audit_event_id" IS NOT NULL;
CREATE UNIQUE INDEX "partner_invite_operations_terminal_audit_key"
  ON "partner_invite_operations" ("terminal_audit_event_id")
  WHERE "terminal_audit_event_id" IS NOT NULL;
CREATE INDEX "partner_invite_operations_org_state_idx"
  ON "partner_invite_operations" ("org_contact_id", "state", "updated_at");
CREATE INDEX "partner_invite_operations_user_created_idx"
  ON "partner_invite_operations" ("partner_user_id", "created_at", "id");

CREATE OR REPLACE FUNCTION enforce_partner_invite_operation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'partner_invite_operation_invalid_initial_state';
    END IF;
    RETURN NEW;
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

CREATE TRIGGER "partner_invite_operation_transition"
BEFORE INSERT OR UPDATE ON "partner_invite_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_partner_invite_operation_transition();

CREATE OR REPLACE FUNCTION enforce_partner_invite_operation_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_invite_operation_evidence_append_only';
END;
$$;

CREATE TRIGGER "partner_invite_operation_no_delete"
BEFORE DELETE ON "partner_invite_operations"
FOR EACH ROW EXECUTE FUNCTION enforce_partner_invite_operation_append_only();
CREATE TRIGGER "partner_invite_operation_no_truncate"
BEFORE TRUNCATE ON "partner_invite_operations"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_partner_invite_operation_append_only();

COMMENT ON TABLE "partner_invite_operations" IS
  'Durable access-link delivery ledger. A committed dispatched or reconciliation-required attempt must never be automatically resent.';
