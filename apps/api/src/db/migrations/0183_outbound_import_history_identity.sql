-- Additive import provenance for repeatable, mixed-source partner outreach.
-- Existing account data is untouched; every new field is nullable.
ALTER TABLE "partner_accounts"
  ADD COLUMN IF NOT EXISTS "external_company_id" text,
  ADD COLUMN IF NOT EXISTS "external_location_id" text,
  ADD COLUMN IF NOT EXISTS "imported_status" text,
  ADD COLUMN IF NOT EXISTS "outreach_priority" text,
  ADD COLUMN IF NOT EXISTS "imported_next_action" text,
  ADD COLUMN IF NOT EXISTS "imported_email_status" text;

CREATE INDEX IF NOT EXISTS "partner_accounts_external_company_idx"
  ON "partner_accounts" ("external_company_id")
  WHERE "external_company_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "partner_accounts_external_location_idx"
  ON "partner_accounts" ("external_location_id")
  WHERE "external_location_id" IS NOT NULL;
