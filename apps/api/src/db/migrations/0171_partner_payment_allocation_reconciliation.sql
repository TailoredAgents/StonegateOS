CREATE TABLE partner_allocation_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  partner_booking_id uuid NOT NULL REFERENCES partner_bookings(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
  reason text NOT NULL CONSTRAINT partner_allocation_reconciliations_reason_check CHECK(length(btrim(reason)) BETWEEN 12 AND 2000),
  evidence_reference text NOT NULL CONSTRAINT partner_allocation_reconciliations_evidence_check CHECK(length(btrim(evidence_reference)) BETWEEN 3 AND 500),
  before_snapshot jsonb NOT NULL CONSTRAINT partner_allocation_reconciliations_before_check CHECK(jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb NOT NULL CONSTRAINT partner_allocation_reconciliations_after_check CHECK(jsonb_typeof(after_snapshot) = 'object'),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_allocation_reconciliations_job_idx ON partner_allocation_reconciliations(partner_account_id, partner_booking_id, created_at, id);
CREATE TRIGGER partner_allocation_reconciliations_immutable BEFORE UPDATE OR DELETE ON partner_allocation_reconciliations
  FOR EACH ROW EXECUTE FUNCTION partner_billing_immutable_evidence();
--> statement-breakpoint
CREATE TABLE partner_refund_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  partner_invoice_id uuid NOT NULL REFERENCES partner_invoices(id) ON DELETE RESTRICT,
  refund_id uuid NOT NULL REFERENCES payment_refunds(id) ON DELETE RESTRICT,
  job_amount_cents integer NOT NULL CONSTRAINT partner_refund_allocations_amount_check CHECK(job_amount_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_refund_allocations_invoice_refund_key UNIQUE(partner_invoice_id, refund_id)
);
CREATE INDEX partner_refund_allocations_refund_idx ON partner_refund_allocations(refund_id);
--> statement-breakpoint
CREATE FUNCTION partner_allocation_reconciliation_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job uuid; target_account uuid; target_payment uuid;
BEGIN
  IF TG_TABLE_NAME = 'partner_refund_allocations' THEN
    SELECT partner_booking_id, partner_account_id INTO target_job, target_account FROM partner_invoices WHERE id = NEW.partner_invoice_id;
    SELECT payment_id INTO target_payment FROM payment_refunds WHERE id = NEW.refund_id;
  ELSE
    target_job := NEW.partner_booking_id; target_account := NEW.partner_account_id; target_payment := NEW.payment_id;
  END IF;
  IF target_account IS DISTINCT FROM NEW.partner_account_id OR NOT EXISTS (
    SELECT 1 FROM partner_bookings b JOIN payments p ON p.appointment_id = b.appointment_id
    WHERE b.id = target_job AND b.partner_account_id = NEW.partner_account_id AND p.id = target_payment
  ) THEN RAISE EXCEPTION 'partner_allocation_account_job_payment_mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_allocation_reconciliations_scope BEFORE INSERT ON partner_allocation_reconciliations
  FOR EACH ROW EXECUTE FUNCTION partner_allocation_reconciliation_scope_guard();
CREATE TRIGGER partner_refund_allocations_scope BEFORE INSERT OR UPDATE ON partner_refund_allocations
  FOR EACH ROW EXECUTE FUNCTION partner_allocation_reconciliation_scope_guard();
