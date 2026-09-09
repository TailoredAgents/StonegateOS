ALTER TABLE partner_invoices ADD COLUMN credited_cents integer NOT NULL DEFAULT 0;
ALTER TABLE partner_invoices DROP CONSTRAINT partner_invoices_totals_check;
ALTER TABLE partner_invoices ADD CONSTRAINT partner_invoices_totals_check CHECK (
  subtotal_cents >= 0 AND tax_cents >= 0 AND discount_cents >= 0 AND deposit_cents >= 0
  AND total_cents = subtotal_cents + tax_cents - discount_cents
  AND paid_cents >= 0 AND credited_cents >= 0
  AND balance_cents = total_cents - paid_cents - credited_cents AND balance_cents >= 0
);
ALTER TABLE partner_statements ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
DROP INDEX partner_statements_account_period_currency_key;
CREATE UNIQUE INDEX partner_statements_account_period_currency_key
  ON partner_statements (partner_account_id, period_start, period_end, currency, revision);

CREATE TABLE partner_invoice_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  partner_invoice_id uuid NOT NULL REFERENCES partner_invoices(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  kind text NOT NULL DEFAULT 'credit' CHECK (kind IN ('credit', 'void')),
  created_by uuid NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_invoice_credits_account_invoice_fk FOREIGN KEY (partner_account_id, partner_invoice_id)
    REFERENCES partner_invoices(partner_account_id, id) ON DELETE RESTRICT
);
CREATE TABLE partner_billing_document_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  partner_booking_id uuid REFERENCES partner_bookings(id) ON DELETE RESTRICT,
  partner_invoice_id uuid REFERENCES partner_invoices(id) ON DELETE RESTRICT,
  source_key text NOT NULL,
  document_type text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash varchar(64) NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  document_id uuid REFERENCES partner_documents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT partner_billing_documents_invoice_account_fk FOREIGN KEY (partner_account_id, partner_invoice_id)
    REFERENCES partner_invoices(partner_account_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_billing_documents_job_account_fk FOREIGN KEY (partner_account_id, partner_booking_id)
    REFERENCES partner_bookings(partner_account_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX partner_billing_documents_source_snapshot_key
  ON partner_billing_document_operations(partner_account_id, document_type, source_key, snapshot_hash);
CREATE TABLE partner_billing_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  partner_invoice_id uuid NOT NULL REFERENCES partner_invoices(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 192),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitted','settled','failed','needs_review')),
  provider_refund_id text,
  requested_by uuid NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_billing_refunds_invoice_account_fk FOREIGN KEY (partner_account_id, partner_invoice_id)
    REFERENCES partner_invoices(partner_account_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX partner_billing_refunds_provider_key ON partner_billing_refund_requests(provider_refund_id);

CREATE FUNCTION partner_billing_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Issued financial evidence is immutable; record an explicit correction';
END $$;
CREATE TRIGGER partner_invoice_credits_immutable BEFORE UPDATE OR DELETE ON partner_invoice_credits
  FOR EACH ROW EXECUTE FUNCTION partner_billing_immutable_evidence();
CREATE TRIGGER partner_statements_immutable BEFORE UPDATE OR DELETE ON partner_statements
  FOR EACH ROW EXECUTE FUNCTION partner_billing_immutable_evidence();
CREATE FUNCTION partner_billing_document_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.partner_account_id IS DISTINCT FROM OLD.partner_account_id
    OR NEW.partner_booking_id IS DISTINCT FROM OLD.partner_booking_id
    OR NEW.partner_invoice_id IS DISTINCT FROM OLD.partner_invoice_id
    OR NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.version IS DISTINCT FROM OLD.version OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
    OR (OLD.status = 'ready' AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)) THEN
    RAISE EXCEPTION 'Financial document snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_billing_documents_snapshot_immutable BEFORE UPDATE OR DELETE ON partner_billing_document_operations
  FOR EACH ROW EXECUTE FUNCTION partner_billing_document_snapshot_guard();

CREATE FUNCTION partner_issued_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.issued_at IS NOT NULL AND (TG_OP = 'DELETE' OR
    NEW.partner_account_id IS DISTINCT FROM OLD.partner_account_id OR NEW.partner_booking_id IS DISTINCT FROM OLD.partner_booking_id OR
    NEW.invoice_number IS DISTINCT FROM OLD.invoice_number OR NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents OR
    NEW.discount_cents IS DISTINCT FROM OLD.discount_cents OR NEW.deposit_cents IS DISTINCT FROM OLD.deposit_cents OR
    NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
    NEW.billing_contact IS DISTINCT FROM OLD.billing_contact OR NEW.terms IS DISTINCT FROM OLD.terms OR
    NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.po_number IS DISTINCT FROM OLD.po_number OR
    NEW.cost_center IS DISTINCT FROM OLD.cost_center) THEN
    RAISE EXCEPTION 'Issued invoice terms are immutable; record an explicit correction';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_invoices_issued_immutable BEFORE UPDATE OR DELETE ON partner_invoices
  FOR EACH ROW EXECUTE FUNCTION partner_issued_invoice_guard();
CREATE FUNCTION partner_issued_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.partner_invoice_id ELSE NEW.partner_invoice_id END;
  IF EXISTS (SELECT 1 FROM partner_invoices WHERE id = target_id AND issued_at IS NOT NULL) OR
    (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM partner_invoices WHERE id = OLD.partner_invoice_id AND issued_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Issued invoice lines are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_invoice_lines_issued_immutable BEFORE INSERT OR UPDATE OR DELETE ON partner_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION partner_issued_invoice_line_guard();
