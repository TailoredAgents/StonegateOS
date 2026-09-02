-- Verified account domains are the only domain-to-tenant matching authority.
-- The legacy partner_accounts.domain and applicant-entered website remain
-- supporting data and are never sufficient to join an account.

CREATE TABLE "partner_account_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "normalized_domain" varchar(253) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "verification_method" text,
  "verification_evidence" text,
  "verified_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "verified_at" timestamptz,
  "revoked_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_account_domains_domain_check"
    CHECK (
      "normalized_domain" = lower(btrim("normalized_domain"))
      AND length("normalized_domain") BETWEEN 3 AND 253
      AND "normalized_domain" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    ),
  CONSTRAINT "partner_account_domains_status_check"
    CHECK ("status" IN ('pending', 'verified', 'revoked')),
  CONSTRAINT "partner_account_domains_lifecycle_check"
    CHECK (
      (
        "status" = 'pending'
        AND "verified_at" IS NULL
        AND "verified_by_team_member_id" IS NULL
        AND "revoked_at" IS NULL
        AND "revoked_by_team_member_id" IS NULL
      ) OR (
        "status" = 'verified'
        AND "verified_at" IS NOT NULL
        AND "verified_by_team_member_id" IS NOT NULL
        AND "verification_method" IS NOT NULL
        AND "verification_evidence" IS NOT NULL
        AND "revoked_at" IS NULL
        AND "revoked_by_team_member_id" IS NULL
      ) OR (
        "status" = 'revoked'
        AND "revoked_at" IS NOT NULL
        AND "revoked_by_team_member_id" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "partner_account_domains_account_domain_key"
  ON "partner_account_domains" ("partner_account_id", "normalized_domain");
CREATE INDEX "partner_account_domains_domain_status_idx"
  ON "partner_account_domains" ("normalized_domain", "status", "partner_account_id");

-- Preserve plausible legacy domains as pending review only. They cannot match
-- an applicant until authorized staff records verification provenance.
INSERT INTO "partner_account_domains" (
  "partner_account_id", "normalized_domain", "status"
)
SELECT
  "account"."id",
  lower(btrim("account"."domain")),
  'pending'
FROM "partner_accounts" AS "account"
WHERE "account"."domain" IS NOT NULL
  AND lower(btrim("account"."domain")) ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
ON CONFLICT ("partner_account_id", "normalized_domain") DO NOTHING;
