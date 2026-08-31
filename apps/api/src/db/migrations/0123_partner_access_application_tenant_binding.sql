-- Bind each access application to the exact limited workspace created during
-- onboarding. The column remains nullable so ambiguous historical records are
-- quarantined for staff reconciliation instead of being guessed into a tenant.
ALTER TABLE "partner_access_applications"
  ADD COLUMN "bootstrap_partner_account_id" uuid;

-- Approved historical applications already carry an authoritative account.
UPDATE "partner_access_applications"
SET "bootstrap_partner_account_id" = "approved_partner_account_id"
WHERE "approved_partner_account_id" IS NOT NULL;

-- Pending historical applications were created atomically with one generated
-- account, applicant role, and membership at the same timestamp. Backfill only
-- when that complete signature identifies exactly one account.
WITH "candidate_accounts" AS (
  SELECT
    "application"."id" AS "application_id",
    min("account"."id"::text)::uuid AS "account_id",
    count(DISTINCT "account"."id") AS "candidate_count"
  FROM "partner_access_applications" AS "application"
  INNER JOIN "partner_account_memberships" AS "membership"
    ON "membership"."partner_user_id" = "application"."applicant_partner_user_id"
   AND "membership"."role_key" = 'applicant'
  INNER JOIN "partner_accounts" AS "account"
    ON "account"."id" = "membership"."partner_account_id"
   AND "account"."source" = 'partner_portal_access_application'
  INNER JOIN "partner_role_templates" AS "role"
    ON "role"."id" = "membership"."role_template_id"
   AND "role"."partner_account_id" = "account"."id"
   AND "role"."key" = 'applicant'
   AND "role"."is_system" = false
  WHERE "application"."bootstrap_partner_account_id" IS NULL
    AND "account"."created_at" = "application"."created_at"
    AND "membership"."created_at" = "application"."created_at"
  GROUP BY "application"."id"
)
UPDATE "partner_access_applications" AS "application"
SET "bootstrap_partner_account_id" = "candidate"."account_id"
FROM "candidate_accounts" AS "candidate"
WHERE "candidate"."application_id" = "application"."id"
  AND "candidate"."candidate_count" = 1;

ALTER TABLE "partner_access_applications"
  ADD CONSTRAINT "partner_access_applications_bootstrap_account_fk"
  FOREIGN KEY ("bootstrap_partner_account_id")
  REFERENCES "partner_accounts"("id")
  ON DELETE RESTRICT;

ALTER TABLE "partner_access_applications"
  ADD CONSTRAINT "partner_access_applications_approval_tenant_check"
  CHECK (
    "status" <> 'approved'
    OR (
      "bootstrap_partner_account_id" IS NOT NULL
      AND "approved_partner_account_id" = "bootstrap_partner_account_id"
    )
  );

CREATE INDEX "partner_access_applications_bootstrap_account_idx"
  ON "partner_access_applications" ("bootstrap_partner_account_id", "status");
