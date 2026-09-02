-- Classification-only Partner billing dispute/refund-review requests. These
-- records never mutate invoice, allocation, payment, or provider state.

CREATE UNIQUE INDEX IF NOT EXISTS "partner_invoices_account_id_key"
  ON "partner_invoices" ("partner_account_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_threads_partner_account_id_key"
  ON "conversation_threads" ("partner_account_id", "id");

-- Install with the lower-lock NOT VALID form, then fail the migration closed if
-- any legacy row has not been reconciled. Cutover may not leave this tenant
-- boundary partially validated.
ALTER TABLE "partner_invoices"
  ADD CONSTRAINT "partner_invoices_account_booking_fk"
  FOREIGN KEY ("partner_account_id", "partner_booking_id")
  REFERENCES "partner_bookings"("partner_account_id", "id")
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE "partner_invoices"
  VALIDATE CONSTRAINT "partner_invoices_account_booking_fk";

-- Billing updates use the existing durable Partner notification ledger, but
-- they are account/invoice scoped rather than job scoped. Existing booking
-- notifications retain their required account-safe booking pair.
ALTER TABLE "partner_notification_deliveries"
  ALTER COLUMN "partner_booking_id" DROP NOT NULL;
ALTER TABLE "partner_notification_deliveries"
  DROP CONSTRAINT "partner_notification_deliveries_event_type_check";
ALTER TABLE "partner_notification_deliveries"
  ADD CONSTRAINT "partner_notification_deliveries_event_type_check"
  CHECK ("event_type" IN (
    'booking.created',
    'booking.review_received',
    'booking.rescheduled',
    'booking.reschedule_review_requested',
    'booking.canceled',
    'booking.cancellation_review_requested',
    'billing.dispute_requested',
    'billing.dispute_resolved'
  ));
ALTER TABLE "partner_notification_deliveries"
  DROP CONSTRAINT "partner_notification_deliveries_preference_event_key_check";
ALTER TABLE "partner_notification_deliveries"
  ADD CONSTRAINT "partner_notification_deliveries_preference_event_key_check"
  CHECK ("preference_event_key" IN (
    'booking_created',
    'booking_changed',
    'invoice_issued'
  ));
ALTER TABLE "partner_notification_deliveries"
  DROP CONSTRAINT "partner_notification_deliveries_action_path_check";
ALTER TABLE "partner_notification_deliveries"
  ADD CONSTRAINT "partner_notification_deliveries_action_path_check"
  CHECK (
    "action_path" ~ '^/partners/bookings/[0-9a-f-]{36}$'
    OR "action_path" = '/partners/billing'
  );

ALTER TABLE "staff_notification_operations"
  DROP CONSTRAINT "staff_notification_operations_kind_check";
ALTER TABLE "staff_notification_operations"
  ADD CONSTRAINT "staff_notification_operations_kind_check"
  CHECK ("kind" IN (
    'partner_booking_created',
    'partner_booking_canceled',
    'partner_billing_dispute_requested'
  ));

-- Financial threads are deliberately excluded from the general Staff Inbox.
-- Existing threads are classified as general; the billing-request service must
-- opt into the restricted scope explicitly.
ALTER TABLE "conversation_threads"
  ADD COLUMN "staff_scope" text NOT NULL DEFAULT 'general';
ALTER TABLE "conversation_threads"
  ADD CONSTRAINT "conversation_threads_staff_scope_check"
  CHECK ("staff_scope" IN ('general', 'partner_billing'));
ALTER TABLE "conversation_threads"
  ADD CONSTRAINT "conversation_threads_billing_scope_binding_check"
  CHECK (
    "staff_scope" <> 'partner_billing'
    OR (
      "partner_account_id" IS NOT NULL
      AND "partner_booking_id" IS NULL
      AND "portal_visible" IS true
    )
  );

-- Conversation threads predate account tenancy. Enforce safe new job bindings.
-- Booking deletion may continue to clear the legacy single-column FK safely.
CREATE OR REPLACE FUNCTION "enforce_conversation_thread_account_booking"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_booking_id" IS NOT NULL AND (
    NEW."partner_account_id" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "partner_bookings" AS booking
      WHERE booking."id" = NEW."partner_booking_id"
        AND booking."partner_account_id" = NEW."partner_account_id"
    )
  ) THEN
    RAISE EXCEPTION 'conversation_thread_account_booking_mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "conversation_threads_account_booking_guard"
BEFORE INSERT OR UPDATE OF "partner_account_id", "partner_booking_id"
ON "conversation_threads"
FOR EACH ROW
EXECUTE FUNCTION "enforce_conversation_thread_account_booking"();

CREATE TABLE "partner_billing_dispute_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_invoice_id" uuid NOT NULL,
  "partner_booking_id" uuid,
  "requested_by_membership_id" uuid NOT NULL,
  "conversation_thread_id" uuid NOT NULL,
  "thread_scope" text NOT NULL,
  "category" text NOT NULL,
  "reason" text NOT NULL,
  "request_snapshot" jsonb NOT NULL,
  "operation_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "revision" integer NOT NULL DEFAULT 1,
  "resolved_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "resolution_reason" text,
  "resolution_snapshot" jsonb,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_billing_disputes_invoice_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_invoice_id")
    REFERENCES "partner_invoices"("partner_account_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_billing_disputes_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_billing_disputes_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_billing_disputes_thread_account_fk"
    FOREIGN KEY ("partner_account_id", "conversation_thread_id")
    REFERENCES "conversation_threads"("partner_account_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_billing_disputes_thread_scope_check"
    CHECK ("thread_scope" = 'account_billing'),
  CONSTRAINT "partner_billing_disputes_category_check"
    CHECK ("category" IN (
      'invoice_amount',
      'duplicate_charge',
      'payment_not_reflected',
      'service_concern',
      'refund_request',
      'tax_or_document',
      'other'
    )),
  CONSTRAINT "partner_billing_disputes_reason_check"
    CHECK (
      "reason" = btrim("reason")
      AND length("reason") BETWEEN 10 AND 2000
    ),
  CONSTRAINT "partner_billing_disputes_snapshot_check"
    CHECK (
      jsonb_typeof("request_snapshot") = 'object'
      AND "request_snapshot" @> '{"version": 1}'::jsonb
      AND "request_snapshot" ? 'replayReceipt'
      AND jsonb_typeof("request_snapshot" -> 'replayReceipt') = 'object'
      AND "request_snapshot" -> 'replayReceipt' @> '{
        "version": 1,
        "status": 201
      }'::jsonb
      AND "request_snapshot" -> 'replayReceipt' ? 'correlationId'
      AND jsonb_typeof(
        "request_snapshot" -> 'replayReceipt' -> 'correlationId'
      ) = 'string'
      AND "request_snapshot" -> 'replayReceipt' ->> 'correlationId'
        ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
      AND "request_snapshot" -> 'replayReceipt' ? 'etag'
      AND jsonb_typeof(
        "request_snapshot" -> 'replayReceipt' -> 'etag'
      ) = 'string'
      AND "request_snapshot" -> 'replayReceipt' ->> 'etag'
        ~ '^"[A-Za-z0-9_-]{43}"$'
      AND "request_snapshot" -> 'replayReceipt' ? 'message'
      AND jsonb_typeof(
        "request_snapshot" -> 'replayReceipt' -> 'message'
      ) = 'string'
      AND length(
        "request_snapshot" -> 'replayReceipt' ->> 'message'
      ) BETWEEN 1 AND 500
    ),
  CONSTRAINT "partner_billing_disputes_operation_hash_check"
    CHECK ("operation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_billing_disputes_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_billing_disputes_state_check"
    CHECK ("state" IN (
      'pending',
      'information_provided',
      'adjustment_required',
      'refund_review',
      'declined'
    )),
  CONSTRAINT "partner_billing_disputes_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "partner_billing_disputes_resolution_check"
    CHECK (
      (
        "state" = 'pending'
        AND "resolved_by_team_member_id" IS NULL
        AND "resolution_reason" IS NULL
        AND "resolution_snapshot" IS NULL
        AND "resolved_at" IS NULL
      ) OR (
        "state" IN (
          'information_provided',
          'adjustment_required',
          'refund_review',
          'declined'
        )
        AND "resolved_by_team_member_id" IS NOT NULL
        AND "resolution_reason" IS NOT NULL
        AND length(btrim("resolution_reason")) BETWEEN 12 AND 2000
        AND "resolution_snapshot" IS NOT NULL
        AND jsonb_typeof("resolution_snapshot") = 'object'
        AND "resolution_snapshot" @> '{
          "version": 1,
          "monetaryMutationPerformed": false,
          "providerActionPerformed": false
        }'::jsonb
        AND "resolution_snapshot" ? 'outcome'
        AND jsonb_typeof("resolution_snapshot" -> 'outcome') = 'string'
        AND "resolution_snapshot" ->> 'outcome' = "state"
        AND "resolved_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "partner_billing_disputes_account_request_key"
  ON "partner_billing_dispute_requests" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_billing_disputes_account_operation_key"
  ON "partner_billing_dispute_requests"
  ("partner_account_id", "operation_key_hash");
CREATE UNIQUE INDEX "partner_billing_disputes_pending_invoice_key"
  ON "partner_billing_dispute_requests"
  ("partner_account_id", "partner_invoice_id")
  WHERE "state" = 'pending';
CREATE UNIQUE INDEX "partner_billing_disputes_account_thread_key"
  ON "partner_billing_dispute_requests" ("conversation_thread_id")
  WHERE "thread_scope" = 'account_billing';
CREATE INDEX "partner_billing_disputes_account_state_idx"
  ON "partner_billing_dispute_requests"
  ("partner_account_id", "state", "created_at", "id");
CREATE INDEX "partner_billing_disputes_invoice_history_idx"
  ON "partner_billing_dispute_requests"
  ("partner_account_id", "partner_invoice_id", "created_at", "id");
CREATE INDEX "partner_billing_disputes_booking_history_idx"
  ON "partner_billing_dispute_requests"
  ("partner_account_id", "partner_booking_id", "created_at", "id")
  WHERE "partner_booking_id" IS NOT NULL;

-- A dispute's optional job association is a snapshot of the invoice's job; it
-- may never name a different same-account job. The dedicated thread is also a
-- financial thread, not a job thread. Row locks close concurrent rebind races.
CREATE OR REPLACE FUNCTION "enforce_partner_billing_dispute_bindings"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  invoice_booking_id uuid;
  thread_booking_id uuid;
  thread_staff_scope text;
BEGIN
  SELECT invoice."partner_booking_id"
    INTO invoice_booking_id
  FROM "partner_invoices" AS invoice
  WHERE invoice."id" = NEW."partner_invoice_id"
    AND invoice."partner_account_id" = NEW."partner_account_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_billing_dispute_invoice_account_mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."partner_booking_id" IS DISTINCT FROM invoice_booking_id THEN
    RAISE EXCEPTION 'partner_billing_dispute_invoice_booking_mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT thread."partner_booking_id", thread."staff_scope"
    INTO thread_booking_id, thread_staff_scope
  FROM "conversation_threads" AS thread
  WHERE thread."id" = NEW."conversation_thread_id"
    AND thread."partner_account_id" = NEW."partner_account_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_billing_dispute_thread_account_mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF thread_booking_id IS NOT NULL
    OR thread_staff_scope IS DISTINCT FROM 'partner_billing'
  THEN
    RAISE EXCEPTION 'partner_billing_dispute_thread_not_financial'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_billing_disputes_binding_guard"
BEFORE INSERT ON "partner_billing_dispute_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_billing_dispute_bindings"();

-- Once cited by immutable dispute evidence, neither side may be rebound behind
-- that evidence. These reverse guards also make concurrent updates serialize.
CREATE OR REPLACE FUNCTION "protect_partner_invoice_dispute_binding"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (
    NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
  ) AND EXISTS (
    SELECT 1
    FROM "partner_billing_dispute_requests" AS dispute
    WHERE dispute."partner_invoice_id" = OLD."id"
      AND (
        dispute."partner_account_id" IS DISTINCT FROM NEW."partner_account_id"
        OR dispute."partner_booking_id" IS DISTINCT FROM NEW."partner_booking_id"
      )
  ) THEN
    RAISE EXCEPTION 'partner_invoice_has_billing_dispute_booking_conflict'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_invoices_billing_dispute_binding_guard"
BEFORE UPDATE OF "partner_account_id", "partner_booking_id"
ON "partner_invoices"
FOR EACH ROW
EXECUTE FUNCTION "protect_partner_invoice_dispute_binding"();

CREATE OR REPLACE FUNCTION "protect_billing_dispute_thread_binding"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."staff_scope" IS DISTINCT FROM OLD."staff_scope" THEN
    RAISE EXCEPTION 'conversation_thread_staff_scope_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "partner_billing_dispute_requests" AS dispute
    WHERE dispute."conversation_thread_id" = OLD."id"
      AND (
        dispute."partner_account_id" IS DISTINCT FROM NEW."partner_account_id"
        OR NEW."partner_booking_id" IS NOT NULL
        OR NEW."staff_scope" IS DISTINCT FROM 'partner_billing'
        OR NEW."portal_visible" IS DISTINCT FROM true
      )
  ) THEN
    RAISE EXCEPTION 'conversation_thread_has_billing_dispute_conflict'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "conversation_threads_billing_dispute_binding_guard"
BEFORE UPDATE OF "partner_account_id", "partner_booking_id", "staff_scope", "portal_visible"
ON "conversation_threads"
FOR EACH ROW
EXECUTE FUNCTION "protect_billing_dispute_thread_binding"();

CREATE OR REPLACE FUNCTION "enforce_partner_billing_dispute_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_invoice_id" IS DISTINCT FROM OLD."partner_invoice_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."conversation_thread_id" IS DISTINCT FROM OLD."conversation_thread_id"
    OR NEW."thread_scope" IS DISTINCT FROM OLD."thread_scope"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."request_snapshot" IS DISTINCT FROM OLD."request_snapshot"
    OR NEW."operation_key_hash" IS DISTINCT FROM OLD."operation_key_hash"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_billing_dispute_request_evidence_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'partner_billing_dispute_resolution_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."state" NOT IN (
      'information_provided',
      'adjustment_required',
      'refund_review',
      'declined'
    )
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_billing_dispute_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_billing_disputes_evidence_immutable"
BEFORE UPDATE ON "partner_billing_dispute_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_billing_dispute_immutable"();

COMMENT ON TABLE "partner_billing_dispute_requests" IS
  'Immutable account/invoice-owned Partner billing questions, disputes, and refund-review requests; terminal outcomes classify Staff follow-up and never mutate money/provider state.';
