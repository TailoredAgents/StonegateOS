-- Quote V2 conversion evidence: customer change ownership and deposits that
-- exist before an appointment. This remains additive for legacy POS payments.

ALTER TABLE "quote_change_requests"
  ADD COLUMN "owner_task_id" uuid,
  ADD COLUMN "due_at" timestamptz,
  ADD CONSTRAINT "quote_change_requests_owner_task_id_fk"
    FOREIGN KEY ("owner_task_id") REFERENCES "crm_tasks"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "quote_change_requests_v2_workflow_check"
    CHECK ("quote_version_id" IS NULL OR ("owner_task_id" IS NOT NULL AND "due_at" IS NOT NULL));

CREATE UNIQUE INDEX "quote_change_requests_owner_task_key"
  ON "quote_change_requests" ("owner_task_id")
  WHERE "owner_task_id" IS NOT NULL;

ALTER TABLE "payment_attempts"
  ALTER COLUMN "appointment_id" DROP NOT NULL,
  ADD COLUMN "quote_response_id" uuid,
  ADD COLUMN "appointment_hold_id" uuid,
  DROP CONSTRAINT "payment_attempts_appointment_id_appointments_id_fk",
  ADD CONSTRAINT "payment_attempts_appointment_id_appointments_id_fk"
    FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "payment_attempts_quote_response_id_fk"
    FOREIGN KEY ("quote_response_id") REFERENCES "quote_responses"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempts_appointment_hold_id_fk"
    FOREIGN KEY ("appointment_hold_id") REFERENCES "appointment_holds"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "payment_attempts_subject_check"
    CHECK ("appointment_id" IS NOT NULL OR "quote_response_id" IS NOT NULL);

CREATE INDEX "payment_attempts_quote_response_idx"
  ON "payment_attempts" ("quote_response_id", "created_at");

CREATE UNIQUE INDEX "payment_attempts_active_quote_deposit_key"
  ON "payment_attempts" ("quote_response_id")
  WHERE "quote_response_id" IS NOT NULL
    AND "quote_payment_kind" = 'deposit'
    AND "status" IN ('created', 'launched', 'pending_verification');

ALTER TABLE "payments"
  ADD COLUMN "quote_response_id" uuid,
  ADD CONSTRAINT "payments_quote_response_id_fk"
    FOREIGN KEY ("quote_response_id") REFERENCES "quote_responses"("id") ON DELETE RESTRICT;

CREATE INDEX "payments_quote_response_idx"
  ON "payments" ("quote_response_id", "created_at");

CREATE UNIQUE INDEX "payments_completed_quote_deposit_key"
  ON "payments" ("quote_response_id")
  WHERE "quote_response_id" IS NOT NULL
    AND "quote_payment_kind" = 'deposit'
    AND "canonical_status" = 'completed';

