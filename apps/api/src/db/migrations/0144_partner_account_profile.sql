-- Canonical Partner account profile and billing settings. These values are
-- tenant-owned and deliberately do not reference CRM contacts or payment
-- provider records.

ALTER TABLE "partner_accounts"
  ADD COLUMN "profile_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "service_contact_name" varchar(160),
  ADD COLUMN "service_contact_email" varchar(254),
  ADD COLUMN "service_contact_phone_e164" varchar(16),
  ADD COLUMN "billing_contact_name" varchar(160),
  ADD COLUMN "billing_contact_email" varchar(254),
  ADD COLUMN "billing_contact_phone_e164" varchar(16),
  ADD COLUMN "billing_address_line1" varchar(200),
  ADD COLUMN "billing_address_line2" varchar(200),
  ADD COLUMN "billing_address_city" varchar(120),
  ADD COLUMN "billing_address_state" varchar(64),
  ADD COLUMN "billing_address_postal_code" varchar(20),
  ADD COLUMN "billing_address_country" varchar(2),
  ADD COLUMN "default_po_number" varchar(80),
  ADD COLUMN "cost_center_guidance" varchar(500);

ALTER TABLE "partner_accounts"
  ADD CONSTRAINT "partner_accounts_profile_revision_check"
    CHECK ("profile_revision" > 0),
  ADD CONSTRAINT "partner_accounts_service_contact_shape_check"
    CHECK (
      (
        "service_contact_name" IS NULL
        AND "service_contact_email" IS NULL
        AND "service_contact_phone_e164" IS NULL
      ) OR (
        "service_contact_name" IS NOT NULL
        AND "service_contact_email" IS NOT NULL
        AND length(btrim("service_contact_name")) BETWEEN 1 AND 160
        AND "service_contact_email" = lower(btrim("service_contact_email"))
        AND length("service_contact_email") BETWEEN 3 AND 254
        AND "service_contact_email" !~ '[[:space:]]'
        AND "service_contact_email" LIKE '%@%'
        AND (
          "service_contact_phone_e164" IS NULL
          OR "service_contact_phone_e164" ~ '^\+[1-9][0-9]{7,14}$'
        )
      )
    ),
  ADD CONSTRAINT "partner_accounts_billing_contact_shape_check"
    CHECK (
      (
        "billing_contact_name" IS NULL
        AND "billing_contact_email" IS NULL
        AND "billing_contact_phone_e164" IS NULL
      ) OR (
        "billing_contact_name" IS NOT NULL
        AND "billing_contact_email" IS NOT NULL
        AND length(btrim("billing_contact_name")) BETWEEN 1 AND 160
        AND "billing_contact_email" = lower(btrim("billing_contact_email"))
        AND length("billing_contact_email") BETWEEN 3 AND 254
        AND "billing_contact_email" !~ '[[:space:]]'
        AND "billing_contact_email" LIKE '%@%'
        AND (
          "billing_contact_phone_e164" IS NULL
          OR "billing_contact_phone_e164" ~ '^\+[1-9][0-9]{7,14}$'
        )
      )
    ),
  ADD CONSTRAINT "partner_accounts_billing_address_shape_check"
    CHECK (
      (
        "billing_address_line1" IS NULL
        AND "billing_address_line2" IS NULL
        AND "billing_address_city" IS NULL
        AND "billing_address_state" IS NULL
        AND "billing_address_postal_code" IS NULL
        AND "billing_address_country" IS NULL
      ) OR (
        "billing_address_line1" IS NOT NULL
        AND "billing_address_city" IS NOT NULL
        AND "billing_address_state" IS NOT NULL
        AND "billing_address_postal_code" IS NOT NULL
        AND "billing_address_country" IS NOT NULL
        AND length(btrim("billing_address_line1")) BETWEEN 1 AND 200
        AND (
          "billing_address_line2" IS NULL
          OR length(btrim("billing_address_line2")) BETWEEN 1 AND 200
        )
        AND length(btrim("billing_address_city")) BETWEEN 1 AND 120
        AND length(btrim("billing_address_state")) BETWEEN 1 AND 64
        AND length(btrim("billing_address_postal_code")) BETWEEN 1 AND 20
        AND "billing_address_country" ~ '^[A-Z]{2}$'
      )
    ),
  ADD CONSTRAINT "partner_accounts_default_po_number_check"
    CHECK (
      "default_po_number" IS NULL
      OR length(btrim("default_po_number")) BETWEEN 1 AND 80
    ),
  ADD CONSTRAINT "partner_accounts_cost_center_guidance_check"
    CHECK (
      "cost_center_guidance" IS NULL
      OR length(btrim("cost_center_guidance")) BETWEEN 1 AND 500
    );

COMMENT ON COLUMN "partner_accounts"."profile_revision" IS
  'Independent optimistic-concurrency revision for Partner-managed profile fields.';
COMMENT ON COLUMN "partner_accounts"."cost_center_guidance" IS
  'Partner-visible booking guidance only; it is not a staff commercial term or authorization source.';
