-- Durable, account-owned Partner cancellation-review lifecycle. Historical
-- hash-only review rows are quarantined as exact evidence and are never
-- promoted into actionable requests or decisions by this migration.

CREATE TABLE "partner_cancellation_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL,
  "requested_by_membership_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "request_snapshot" jsonb NOT NULL,
  "operation_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "resolved_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "resolution_reason" text,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_cancellation_requests_state_check"
    CHECK ("state" IN ('pending', 'approved', 'declined')),
  CONSTRAINT "partner_cancellation_requests_reason_check"
    CHECK (
      "reason" = btrim("reason")
      AND length("reason") BETWEEN 5 AND 1000
    ),
  CONSTRAINT "partner_cancellation_requests_snapshot_check"
    CHECK (
      jsonb_typeof("request_snapshot") = 'object'
      AND "request_snapshot" ->> 'version' = '1'
    ),
  CONSTRAINT "partner_cancellation_requests_operation_hash_check"
    CHECK ("operation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_cancellation_requests_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_cancellation_requests_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "partner_cancellation_requests_resolution_check"
    CHECK (
      (
        "state" = 'pending'
        AND "resolved_by_team_member_id" IS NULL
        AND "resolution_reason" IS NULL
        AND "resolved_at" IS NULL
      ) OR (
        "state" IN ('approved', 'declined')
        AND "resolved_by_team_member_id" IS NOT NULL
        AND "resolution_reason" IS NOT NULL
        AND length(btrim("resolution_reason")) BETWEEN 12 AND 1000
        AND "resolved_at" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_cancellation_requests_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_cancellation_requests_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "partner_cancellation_requests_account_request_key"
  ON "partner_cancellation_requests" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_cancellation_requests_account_operation_key"
  ON "partner_cancellation_requests"
  ("partner_account_id", "operation_key_hash");
CREATE UNIQUE INDEX "partner_cancellation_requests_pending_booking_key"
  ON "partner_cancellation_requests"
  ("partner_account_id", "partner_booking_id")
  WHERE "state" = 'pending';
CREATE INDEX "partner_cancellation_requests_account_state_idx"
  ON "partner_cancellation_requests"
  ("partner_account_id", "state", "created_at", "id");

CREATE OR REPLACE FUNCTION "enforce_partner_cancellation_request_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."request_snapshot" IS DISTINCT FROM OLD."request_snapshot"
    OR NEW."operation_key_hash" IS DISTINCT FROM OLD."operation_key_hash"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_cancellation_request_evidence_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'partner_cancellation_request_resolution_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."state" NOT IN ('approved', 'declined')
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_cancellation_request_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_cancellation_requests_evidence_immutable"
BEFORE UPDATE ON "partner_cancellation_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_cancellation_request_immutable"();

CREATE TABLE "partner_cancellation_request_reconciliation_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL
    REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "legacy_operation_key_hash" varchar(64),
  "legacy_request_hash" varchar(64),
  "reason_code" text NOT NULL,
  "evidence_snapshot" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_cancellation_request_reconciliation_state_check"
    CHECK ("state" = 'open'),
  CONSTRAINT "partner_cancellation_request_reconciliation_reason_check"
    CHECK (
      "reason_code" IN (
        'legacy_cancellation_review_requires_reconciliation',
        'legacy_cancellation_review_hash_pair_invalid',
        'legacy_cancellation_review_tenant_unresolved'
      )
    ),
  CONSTRAINT "partner_cancellation_request_reconciliation_hash_check"
    CHECK (
      (
        "legacy_operation_key_hash" IS NOT NULL
        OR "legacy_request_hash" IS NOT NULL
      )
      AND (
        "legacy_operation_key_hash" IS NULL
        OR "legacy_operation_key_hash" ~ '^[0-9a-f]{64}$'
      )
      AND (
        "legacy_request_hash" IS NULL
        OR "legacy_request_hash" ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT "partner_cancellation_request_reconciliation_evidence_check"
    CHECK (
      jsonb_typeof("evidence_snapshot") = 'object'
      AND "evidence_snapshot" ->> 'version' = '1'
    ),
  CONSTRAINT "partner_cancellation_request_reconciliation_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id")
    ON DELETE RESTRICT
);

CREATE INDEX "partner_cancellation_request_reconciliation_account_state_idx"
  ON "partner_cancellation_request_reconciliation_cases"
  ("partner_account_id", "state", "created_at", "id");
CREATE UNIQUE INDEX "partner_cancellation_request_reconciliation_booking_key"
  ON "partner_cancellation_request_reconciliation_cases"
  ("partner_booking_id");

INSERT INTO "partner_cancellation_request_reconciliation_cases" (
  "partner_account_id",
  "partner_booking_id",
  "legacy_operation_key_hash",
  "legacy_request_hash",
  "reason_code",
  "evidence_snapshot"
)
SELECT
  booking."partner_account_id",
  booking."id",
  booking."cancel_operation_key_hash",
  booking."cancel_request_hash",
  CASE
    WHEN booking."partner_account_id" IS NULL
      THEN 'legacy_cancellation_review_tenant_unresolved'
    WHEN (
      booking."cancel_operation_key_hash" IS NULL
    ) <> (
      booking."cancel_request_hash" IS NULL
    ) THEN 'legacy_cancellation_review_hash_pair_invalid'
    ELSE 'legacy_cancellation_review_requires_reconciliation'
  END,
  jsonb_build_object(
    'version', 1,
    'quarantinedAt', now(),
    'publicStatus', booking."public_status",
    'bookingVersion', booking."version",
    'bookingUpdatedAt', booking."updated_at",
    'requestedReviewReasons', to_jsonb(booking."requested_review_reasons"),
    'jobEvents', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', event."id",
          'eventType', event."event_type",
          'publicDetail', event."public_detail",
          'effectiveAt', event."effective_at"
        ) ORDER BY event."effective_at", event."id"
      )
      FROM "partner_job_events" event
      WHERE event."partner_booking_id" = booking."id"
        AND (
          event."partner_account_id" = booking."partner_account_id"
          OR booking."partner_account_id" IS NULL
        )
        AND event."event_type" = 'job.cancellation_review_requested'
    ), '[]'::jsonb)
  )
FROM "partner_bookings" booking
WHERE booking."public_status" <> 'canceled'
  AND (
    booking."cancel_operation_key_hash" IS NOT NULL
    OR booking."cancel_request_hash" IS NOT NULL
  )
  AND (
    'cancellation_review_requested' = ANY(booking."requested_review_reasons")
    OR EXISTS (
      SELECT 1
      FROM "partner_job_events" event
      WHERE event."partner_booking_id" = booking."id"
        AND event."event_type" = 'job.cancellation_review_requested'
    )
  )
ON CONFLICT ("partner_booking_id") DO NOTHING;

CREATE OR REPLACE FUNCTION "enforce_partner_cancellation_reconciliation_append_only"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'partner_cancellation_reconciliation_append_only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "partner_cancellation_reconciliation_append_only"
BEFORE UPDATE OR DELETE
ON "partner_cancellation_request_reconciliation_cases"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_cancellation_reconciliation_append_only"();

COMMENT ON TABLE "partner_cancellation_requests" IS
  'Durable, account-owned Partner cancellation requests with immutable request evidence and Staff-only audited resolution.';
COMMENT ON TABLE "partner_cancellation_request_reconciliation_cases" IS
  'Read-only quarantine evidence for pre-0149 hash-based cancellation review rows; not actionable without explicit reconciliation.';
