-- Partner Portal V2 commercial ledger. Financial records are immutable by
-- convention and account-scoped; provider secrets and raw payment payloads do
-- not belong in this schema.

CREATE TABLE "partner_rate_card_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL CHECK ("version" > 0),
  "currency" varchar(3) DEFAULT 'USD' NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft', 'active', 'expired', 'superseded')),
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "supersedes_id" uuid,
  "created_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_rate_card_versions_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);
ALTER TABLE "partner_rate_card_versions"
  ADD CONSTRAINT "partner_rate_card_versions_supersedes_id_fk"
  FOREIGN KEY ("supersedes_id") REFERENCES "partner_rate_card_versions"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "partner_rate_card_versions_account_version_key" ON "partner_rate_card_versions" ("partner_account_id", "version");
CREATE INDEX "partner_rate_card_versions_account_effective_idx" ON "partner_rate_card_versions" ("partner_account_id", "status", "effective_from", "effective_to");

CREATE TABLE "partner_rate_card_version_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_rate_card_version_id" uuid NOT NULL REFERENCES "partner_rate_card_versions"("id") ON DELETE RESTRICT,
  "service_key" varchar(80) NOT NULL REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "tier_key" text NOT NULL,
  "label" text,
  "amount_cents" integer NOT NULL CHECK ("amount_cents" >= 0),
  "pricing_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_rate_card_version_items_service_tier_key" ON "partner_rate_card_version_items" ("partner_rate_card_version_id", "service_key", "tier_key");

-- Snapshot each unambiguous legacy card as version one. The legacy tables
-- remain the compatibility projection until V2 dual-write is proven stable.
INSERT INTO "partner_rate_card_versions" (
  "partner_account_id", "version", "currency", "status", "effective_from"
)
SELECT "partner_account_id", 1, "currency", CASE WHEN "active" THEN 'active' ELSE 'expired' END, "effective_from"
FROM "partner_rate_cards"
WHERE "partner_account_id" IS NOT NULL
ON CONFLICT ("partner_account_id", "version") DO NOTHING;
INSERT INTO "partner_rate_card_version_items" (
  "partner_rate_card_version_id", "service_key", "tier_key", "label", "amount_cents"
)
SELECT versioned."id", item."service_key", item."tier_key", item."label", item."amount_cents"
FROM "partner_rate_items" item
JOIN "partner_rate_cards" legacy ON legacy."id" = item."rate_card_id"
JOIN "partner_rate_card_versions" versioned
  ON versioned."partner_account_id" = legacy."partner_account_id" AND versioned."version" = 1
ON CONFLICT ("partner_rate_card_version_id", "service_key", "tier_key") DO NOTHING;

CREATE TABLE "partner_approval_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "conditions" jsonb NOT NULL,
  "required_approver_role_keys" text[] DEFAULT ARRAY['approver']::text[] NOT NULL,
  "required_decision_count" integer DEFAULT 1 NOT NULL CHECK ("required_decision_count" BETWEEN 1 AND 20),
  "active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "created_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "partner_approval_rules_account_active_idx" ON "partner_approval_rules" ("partner_account_id", "active", "name");

CREATE TABLE "partner_approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "booking_draft_id" uuid REFERENCES "partner_booking_drafts"("id") ON DELETE RESTRICT,
  "requested_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending', 'approved', 'declined', 'expired', 'approved_needs_reschedule', 'withdrawn')),
  "rule_snapshot" jsonb NOT NULL,
  "request_snapshot" jsonb NOT NULL,
  "required_decision_count" integer NOT NULL CHECK ("required_decision_count" BETWEEN 1 AND 20),
  "approval_hold_id" uuid REFERENCES "appointment_holds"("id") ON DELETE SET NULL,
  "expires_at" timestamptz,
  "resolved_at" timestamptz,
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_approval_requests_target_check" CHECK (num_nonnulls("partner_booking_id", "booking_draft_id") = 1)
);
CREATE INDEX "partner_approval_requests_account_state_idx" ON "partner_approval_requests" ("partner_account_id", "state", "created_at", "id");

CREATE TABLE "partner_approval_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approval_request_id" uuid NOT NULL REFERENCES "partner_approval_requests"("id") ON DELETE RESTRICT,
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "decided_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL CHECK ("decision" IN ('approved', 'declined')),
  "reason" text,
  "decision_snapshot" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_approval_decisions_request_member_key" ON "partner_approval_decisions" ("approval_request_id", "decided_by_membership_id");
CREATE INDEX "partner_approval_decisions_account_history_idx" ON "partner_approval_decisions" ("partner_account_id", "created_at");

CREATE TABLE "partner_quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "booking_draft_id" uuid REFERENCES "partner_booking_drafts"("id") ON DELETE RESTRICT,
  "quote_number" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft', 'sent', 'accepted', 'declined', 'expired', 'superseded')),
  "currency" varchar(3) DEFAULT 'USD' NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "subtotal_cents" integer NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "discount_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "lines" jsonb NOT NULL,
  "terms" text,
  "expires_at" timestamptz,
  "sent_at" timestamptz,
  "accepted_at" timestamptz,
  "declined_at" timestamptz,
  "superseded_at" timestamptz,
  "document_id" uuid REFERENCES "partner_documents"("id") ON DELETE SET NULL,
  "created_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_quotes_target_check" CHECK (num_nonnulls("partner_booking_id", "booking_draft_id") >= 1),
  CONSTRAINT "partner_quotes_totals_check" CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "discount_cents" >= 0 AND "total_cents" = "subtotal_cents" + "tax_cents" - "discount_cents" AND "total_cents" >= 0)
);
CREATE UNIQUE INDEX "partner_quotes_quote_version_key" ON "partner_quotes" ("partner_account_id", "quote_number", "version");
CREATE INDEX "partner_quotes_account_status_idx" ON "partner_quotes" ("partner_account_id", "status", "created_at");

CREATE TABLE "partner_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "invoice_number" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void')),
  "currency" varchar(3) DEFAULT 'USD' NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "subtotal_cents" integer NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "discount_cents" integer DEFAULT 0 NOT NULL,
  "deposit_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "paid_cents" integer DEFAULT 0 NOT NULL,
  "balance_cents" integer NOT NULL,
  "po_number" text,
  "cost_center" text,
  "billing_contact" jsonb NOT NULL,
  "terms" text,
  "due_date" date,
  "issued_at" timestamptz,
  "paid_at" timestamptz,
  "voided_at" timestamptz,
  "provider" text,
  "provider_invoice_id" text,
  "provider_order_id" text,
  "hosted_payment_url" text,
  "document_id" uuid REFERENCES "partner_documents"("id") ON DELETE SET NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_invoices_totals_check" CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "discount_cents" >= 0 AND "deposit_cents" >= 0 AND "total_cents" = "subtotal_cents" + "tax_cents" - "discount_cents" AND "paid_cents" >= 0 AND "balance_cents" = "total_cents" - "paid_cents" AND "balance_cents" >= 0)
);
CREATE UNIQUE INDEX "partner_invoices_account_invoice_key" ON "partner_invoices" ("partner_account_id", "invoice_number");
CREATE UNIQUE INDEX "partner_invoices_provider_invoice_key" ON "partner_invoices" ("provider", "provider_invoice_id") WHERE "provider_invoice_id" IS NOT NULL;
CREATE INDEX "partner_invoices_account_status_idx" ON "partner_invoices" ("partner_account_id", "status", "due_date", "created_at");

CREATE TABLE "partner_invoice_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_invoice_id" uuid NOT NULL REFERENCES "partner_invoices"("id") ON DELETE RESTRICT,
  "line_number" integer NOT NULL CHECK ("line_number" > 0),
  "kind" text DEFAULT 'service' NOT NULL,
  "description" text NOT NULL,
  "quantity" numeric(12,3) DEFAULT 1 NOT NULL,
  "unit_amount_cents" integer NOT NULL,
  "line_total_cents" integer NOT NULL,
  "tax_code" text,
  "metadata" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_invoice_lines_amount_check" CHECK ("unit_amount_cents" >= 0 AND "line_total_cents" >= 0 AND "quantity" > 0)
);
CREATE UNIQUE INDEX "partner_invoice_lines_invoice_line_key" ON "partner_invoice_lines" ("partner_invoice_id", "line_number");

CREATE TABLE "partner_payment_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_invoice_id" uuid NOT NULL REFERENCES "partner_invoices"("id") ON DELETE RESTRICT,
  "payment_id" uuid NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
  "amount_cents" integer NOT NULL CHECK ("amount_cents" > 0),
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending', 'settled', 'reversed')),
  "allocated_at" timestamptz,
  "reversed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_payment_allocations_invoice_payment_key" ON "partner_payment_allocations" ("partner_invoice_id", "payment_id");
CREATE INDEX "partner_payment_allocations_account_state_idx" ON "partner_payment_allocations" ("partner_account_id", "state", "created_at");

CREATE TABLE "partner_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "opening_balance_cents" integer NOT NULL,
  "invoice_cents" integer NOT NULL,
  "payment_cents" integer NOT NULL,
  "refund_cents" integer NOT NULL,
  "credit_cents" integer NOT NULL,
  "closing_balance_cents" integer NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "partner_documents"("id") ON DELETE RESTRICT,
  "generated_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_statements_period_check" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "partner_statements_balance_check" CHECK ("closing_balance_cents" = "opening_balance_cents" + "invoice_cents" + "refund_cents" - "payment_cents" - "credit_cents")
);
CREATE UNIQUE INDEX "partner_statements_account_period_currency_key" ON "partner_statements" ("partner_account_id", "period_start", "period_end", "currency");
CREATE INDEX "partner_statements_account_period_idx" ON "partner_statements" ("partner_account_id", "period_end");

-- Decisions and invoice lines are append-only evidence. Corrections create a
-- new rule/quote/document version, a void invoice, or a reversing allocation.
CREATE OR REPLACE FUNCTION "partner_portal_reject_immutable_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a new version or reversal', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "partner_approval_decisions_immutable"
  BEFORE UPDATE OR DELETE ON "partner_approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION "partner_portal_reject_immutable_update"();
CREATE TRIGGER "partner_invoice_lines_immutable"
  BEFORE UPDATE OR DELETE ON "partner_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "partner_portal_reject_immutable_update"();
CREATE TRIGGER "partner_proof_packages_immutable"
  BEFORE UPDATE OR DELETE ON "partner_proof_packages"
  FOR EACH ROW EXECUTE FUNCTION "partner_portal_reject_immutable_update"();
