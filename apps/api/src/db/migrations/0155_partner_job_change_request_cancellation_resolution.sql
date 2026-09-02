-- A canceled job cannot retain an actionable Partner change request. Add a
-- truthful system/Staff supersession outcome while preserving immutable
-- request evidence and the one-way pending-to-terminal lifecycle.

ALTER TABLE "partner_job_change_requests"
  DROP CONSTRAINT "partner_job_change_requests_state_check";

ALTER TABLE "partner_job_change_requests"
  ADD CONSTRAINT "partner_job_change_requests_state_check"
  CHECK (
    "state" IN (
      'pending',
      'approved',
      'declined',
      'change_order_required',
      'superseded'
    )
  );

ALTER TABLE "partner_job_change_requests"
  DROP CONSTRAINT "partner_job_change_requests_resolution_check";

ALTER TABLE "partner_job_change_requests"
  ADD CONSTRAINT "partner_job_change_requests_resolution_check"
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
      AND "resolution_snapshot" ->> 'outcome' = "state"
      AND "resolved_at" IS NOT NULL
    ) OR (
      "state" = 'superseded'
      AND "resolution_reason" IS NOT NULL
      AND length(btrim("resolution_reason")) BETWEEN 12 AND 1000
      AND jsonb_typeof("resolution_snapshot") = 'object'
      AND "resolution_snapshot" ->> 'version' = '1'
      AND "resolution_snapshot" ->> 'outcome' = 'superseded'
      AND "resolution_snapshot" ->> 'trigger' IN (
        'partner_direct_cancellation',
        'staff_approved_cancellation'
      )
      AND (
        (
          "resolution_snapshot" ->> 'actorType' = 'system'
          AND "resolution_snapshot" ->> 'trigger' = 'partner_direct_cancellation'
          AND "resolved_by_team_member_id" IS NULL
        ) OR (
          "resolution_snapshot" ->> 'actorType' = 'staff'
          AND "resolution_snapshot" ->> 'trigger' = 'staff_approved_cancellation'
          AND "resolved_by_team_member_id" IS NOT NULL
        )
      )
      AND "resolved_at" IS NOT NULL
    )
  );

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
      'change_order_required',
      'superseded'
    )
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_job_change_request_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE "partner_job_change_requests" IS
  'Durable account-owned Partner job change requests with immutable bounded evidence and one-way Staff or cancellation supersession resolution.';
