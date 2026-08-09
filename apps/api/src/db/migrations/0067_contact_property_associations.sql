-- Expand physical properties away from single-contact ownership.
--
-- The legacy properties.contact_id column remains nullable during the expand
-- phase so older readers and writers continue to work. New CRM code uses the
-- contact_properties many-to-many association as the source of truth.

ALTER TABLE "properties"
  ADD COLUMN IF NOT EXISTS "address_key" text;

CREATE TABLE IF NOT EXISTS "contact_properties" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contact_id" uuid NOT NULL,
  "property_id" uuid NOT NULL,
  "relationship" text DEFAULT 'customer' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contact_properties_contact_id_contacts_id_fk'
  ) THEN
    ALTER TABLE "contact_properties"
      ADD CONSTRAINT "contact_properties_contact_id_contacts_id_fk"
      FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contact_properties_property_id_properties_id_fk'
  ) THEN
    ALTER TABLE "contact_properties"
      ADD CONSTRAINT "contact_properties_property_id_properties_id_fk"
      FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "contact_properties_contact_property_key"
  ON "contact_properties" ("contact_id", "property_id");

CREATE INDEX IF NOT EXISTS "contact_properties_contact_idx"
  ON "contact_properties" ("contact_id");

CREATE INDEX IF NOT EXISTS "contact_properties_property_idx"
  ON "contact_properties" ("property_id");

-- Preserve every existing owner link before relaxing the compatibility FK.
INSERT INTO "contact_properties" (
  "contact_id",
  "property_id",
  "relationship",
  "created_at",
  "updated_at"
)
SELECT
  "contact_id",
  "id",
  'customer',
  "created_at",
  "updated_at"
FROM "properties"
WHERE "contact_id" IS NOT NULL
ON CONFLICT ("contact_id", "property_id") DO NOTHING;

-- Canonicalize address identity without merging or deleting any legacy rows.
-- If old case/whitespace variants collide, the oldest row becomes the
-- canonical property for future links; all duplicate rows and their existing
-- appointment/quote/lead references remain intact for a later reviewed merge.
WITH normalized AS (
  SELECT
    "id",
    lower(regexp_replace(btrim("address_line1"), '[[:space:]]+', ' ', 'g'))
      || '|'
      || lower(regexp_replace(btrim(coalesce("address_line2", '')), '[[:space:]]+', ' ', 'g'))
      || '|'
      || lower(regexp_replace(btrim("city"), '[[:space:]]+', ' ', 'g'))
      || '|'
      || lower(btrim("state"))
      || '|'
      || lower(regexp_replace(btrim("postal_code"), '[[:space:]]+', '', 'g'))
      AS "address_key",
    row_number() OVER (
      PARTITION BY
        lower(regexp_replace(btrim("address_line1"), '[[:space:]]+', ' ', 'g')),
        lower(regexp_replace(btrim(coalesce("address_line2", '')), '[[:space:]]+', ' ', 'g')),
        lower(regexp_replace(btrim("city"), '[[:space:]]+', ' ', 'g')),
        lower(btrim("state")),
        lower(regexp_replace(btrim("postal_code"), '[[:space:]]+', '', 'g'))
      ORDER BY "created_at" ASC, "id" ASC
    ) AS "identity_rank"
  FROM "properties"
)
UPDATE "properties" AS property
SET "address_key" = normalized."address_key"
FROM normalized
WHERE property."id" = normalized."id"
  AND normalized."identity_rank" = 1
  AND property."address_key" IS NULL;

-- The old key incorrectly treated an entire street as one contact-owned row:
-- it omitted apartment/unit and city and was case/whitespace sensitive.
DROP INDEX IF EXISTS "properties_address_key";

CREATE UNIQUE INDEX IF NOT EXISTS "properties_physical_address_key"
  ON "properties" ("address_key")
  WHERE "address_key" IS NOT NULL;

-- Deleting a contact must remove its association, not its physical property
-- and all property-linked appointment/quote records.
ALTER TABLE "properties"
  DROP CONSTRAINT IF EXISTS "properties_contact_id_contacts_id_fk";

ALTER TABLE "properties"
  ALTER COLUMN "contact_id" DROP NOT NULL;

ALTER TABLE "properties"
  ADD CONSTRAINT "properties_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

COMMENT ON COLUMN "properties"."contact_id" IS
  'Deprecated compatibility owner. Use contact_properties; remove only after all readers and writers migrate.';

COMMENT ON COLUMN "properties"."address_key" IS
  'Canonical physical address identity. Nullable only for transitional legacy or duplicate rows.';

COMMENT ON TABLE "contact_properties" IS
  'Many-to-many relationship between CRM contacts and physical properties.';
