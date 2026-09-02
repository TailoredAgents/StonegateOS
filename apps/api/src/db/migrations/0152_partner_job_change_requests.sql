-- Durable, account-owned Partner job change requests. The request evidence is
-- immutable and deliberately excludes price, schedule, proof, appointment
-- identifiers, and CRM-contact authority.

CREATE TABLE "partner_job_change_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL,
  "requested_by_membership_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "proposed_changes" jsonb NOT NULL,
  "request_snapshot" jsonb NOT NULL,
  "base_booking_revision" integer NOT NULL,
  "operation_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "resolved_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "resolution_reason" text,
  "resolution_snapshot" jsonb,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_job_change_requests_state_check"
    CHECK (
      "state" IN (
        'pending',
        'approved',
        'declined',
        'change_order_required'
      )
    ),
  CONSTRAINT "partner_job_change_requests_reason_check"
    CHECK (
      "reason" = btrim("reason")
      AND length("reason") BETWEEN 5 AND 1000
    ),
  CONSTRAINT "partner_job_change_requests_proposed_check"
    CHECK (
      jsonb_typeof("proposed_changes") = 'object'
      AND "proposed_changes" ->> 'version' = '1'
      AND jsonb_typeof("proposed_changes" -> 'materiality') = 'object'
    ),
  CONSTRAINT "partner_job_change_requests_snapshot_check"
    CHECK (
      jsonb_typeof("request_snapshot") = 'object'
      AND "request_snapshot" ->> 'version' = '1'
    ),
  CONSTRAINT "partner_job_change_requests_base_revision_check"
    CHECK ("base_booking_revision" > 0),
  CONSTRAINT "partner_job_change_requests_operation_hash_check"
    CHECK ("operation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_job_change_requests_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_job_change_requests_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "partner_job_change_requests_resolution_check"
    CHECK (
      (
        "state" = 'pending'
        AND "resolved_by_team_member_id" IS NULL
        AND "resolution_reason" IS NULL
        AND "resolution_snapshot" IS NULL
        AND "resolved_at" IS NULL
      ) OR (
        "state" IN ('approved', 'declined', 'change_order_required')
        AND "resolved_by_team_member_id" IS NOT NULL
        AND "resolution_reason" IS NOT NULL
        AND length(btrim("resolution_reason")) BETWEEN 12 AND 1000
        AND jsonb_typeof("resolution_snapshot") = 'object'
        AND "resolution_snapshot" ->> 'version' = '1'
        AND "resolved_at" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_job_change_requests_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_job_change_requests_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "partner_job_change_requests_account_request_key"
  ON "partner_job_change_requests" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_job_change_requests_account_operation_key"
  ON "partner_job_change_requests"
  ("partner_account_id", "operation_key_hash");
CREATE UNIQUE INDEX "partner_job_change_requests_pending_booking_key"
  ON "partner_job_change_requests"
  ("partner_account_id", "partner_booking_id")
  WHERE "state" = 'pending';
CREATE INDEX "partner_job_change_requests_account_state_idx"
  ON "partner_job_change_requests"
  ("partner_account_id", "state", "created_at", "id");

CREATE OR REPLACE FUNCTION "enforce_partner_job_change_request_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."proposed_changes" IS DISTINCT FROM OLD."proposed_changes"
    OR NEW."request_snapshot" IS DISTINCT FROM OLD."request_snapshot"
    OR NEW."base_booking_revision" IS DISTINCT FROM OLD."base_booking_revision"
    OR NEW."operation_key_hash" IS DISTINCT FROM OLD."operation_key_hash"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_job_change_request_evidence_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'partner_job_change_request_resolution_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."state" NOT IN (
      'approved',
      'declined',
      'change_order_required'
    )
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_job_change_request_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_job_change_requests_evidence_immutable"
BEFORE UPDATE ON "partner_job_change_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_job_change_request_immutable"();

COMMENT ON TABLE "partner_job_change_requests" IS
  'Durable account-owned Partner job change requests with immutable bounded evidence and Staff-only audited resolution.';
