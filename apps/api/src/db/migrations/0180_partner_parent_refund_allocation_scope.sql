-- Preserve historical appointment binding while accepting the commercial-parent
-- payment authority introduced in 0176. No payment or allocation is rewritten.
CREATE OR REPLACE FUNCTION partner_allocation_reconciliation_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job uuid; target_account uuid; target_payment uuid;
BEGIN
  IF TG_TABLE_NAME = 'partner_refund_allocations' THEN
    SELECT partner_booking_id, partner_account_id INTO target_job, target_account FROM partner_invoices WHERE id = NEW.partner_invoice_id;
    SELECT payment_id INTO target_payment FROM payment_refunds WHERE id = NEW.refund_id;
  ELSE
    target_job := NEW.partner_booking_id; target_account := NEW.partner_account_id; target_payment := NEW.payment_id;
  END IF;
  IF target_account IS DISTINCT FROM NEW.partner_account_id OR NOT EXISTS (
    SELECT 1 FROM partner_bookings b JOIN payments p ON p.id = target_payment
    WHERE b.id = target_job AND b.partner_account_id = NEW.partner_account_id AND (
      (b.model_version = 1 AND p.appointment_id = b.appointment_id)
      OR (b.model_version = 2 AND b.appointment_id IS NULL AND p.appointment_id IS NULL
        AND p.partner_booking_id = b.id AND p.partner_account_id = b.partner_account_id)
    )
  ) THEN RAISE EXCEPTION 'partner_allocation_account_job_payment_mismatch'; END IF;
  RETURN NEW;
END $$;
