-- Add explicit CRM relationships to public instant quotes.
--
-- Historical linkage is derived only from lead rows that unanimously identify
-- one contact and one property. Ambiguous groups are recorded for review; this
-- migration intentionally does not infer relationships from names or phones.

ALTER TABLE "instant_quotes"
  ADD COLUMN IF NOT EXISTS "contact_id" uuid,
  ADD COLUMN IF NOT EXISTS "property_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'instant_quotes_contact_id_contacts_id_fk'
  ) THEN
    ALTER TABLE "instant_quotes"
      ADD CONSTRAINT "instant_quotes_contact_id_contacts_id_fk"
      FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'instant_quotes_property_id_properties_id_fk'
  ) THEN
    ALTER TABLE "instant_quotes"
      ADD CONSTRAINT "instant_quotes_property_id_properties_id_fk"
      FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "instant_quotes_contact_idx"
  ON "instant_quotes" ("contact_id");

CREATE INDEX IF NOT EXISTS "instant_quotes_property_idx"
  ON "instant_quotes" ("property_id");

CREATE TABLE IF NOT EXISTS "instant_quote_relationship_backfill_ambiguities" (
  "instant_quote_id" uuid PRIMARY KEY NOT NULL,
  "lead_count" integer NOT NULL,
  "contact_ids" uuid[] NOT NULL,
  "property_ids" uuid[] NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'instant_quote_relationship_backfill_ambiguities_quote_fk'
  ) THEN
    ALTER TABLE "instant_quote_relationship_backfill_ambiguities"
      ADD CONSTRAINT "instant_quote_relationship_backfill_ambiguities_quote_fk"
      FOREIGN KEY ("instant_quote_id") REFERENCES "public"."instant_quotes"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

-- Preserve a durable review queue for every historical quote whose leads do
-- not agree on exactly one contact and exactly one property.
INSERT INTO "instant_quote_relationship_backfill_ambiguities" (
  "instant_quote_id",
  "lead_count",
  "contact_ids",
  "property_ids",
  "detected_at"
)
SELECT
  lead."instant_quote_id",
  count(*)::integer,
  array_agg(DISTINCT lead."contact_id" ORDER BY lead."contact_id"),
  array_agg(DISTINCT lead."property_id" ORDER BY lead."property_id"),
  now()
FROM "leads" AS lead
WHERE lead."instant_quote_id" IS NOT NULL
GROUP BY lead."instant_quote_id"
HAVING count(DISTINCT lead."contact_id") <> 1
    OR count(DISTINCT lead."property_id") <> 1
ON CONFLICT ("instant_quote_id") DO UPDATE
SET
  "lead_count" = EXCLUDED."lead_count",
  "contact_ids" = EXCLUDED."contact_ids",
  "property_ids" = EXCLUDED."property_ids",
  "detected_at" = EXCLUDED."detected_at";

-- Ensure every deterministic lead pair is represented by the canonical
-- contact-property association before the quote receives the pair.
WITH deterministic_relationships AS (
  SELECT
    lead."instant_quote_id",
    (array_agg(DISTINCT lead."contact_id" ORDER BY lead."contact_id"))[1]
      AS "contact_id",
    (array_agg(DISTINCT lead."property_id" ORDER BY lead."property_id"))[1]
      AS "property_id"
  FROM "leads" AS lead
  WHERE lead."instant_quote_id" IS NOT NULL
  GROUP BY lead."instant_quote_id"
  HAVING count(DISTINCT lead."contact_id") = 1
     AND count(DISTINCT lead."property_id") = 1
)
INSERT INTO "contact_properties" (
  "contact_id",
  "property_id",
  "relationship",
  "created_at",
  "updated_at"
)
SELECT
  deterministic."contact_id",
  deterministic."property_id",
  'customer',
  now(),
  now()
FROM deterministic_relationships AS deterministic
ON CONFLICT ("contact_id", "property_id") DO NOTHING;

WITH deterministic_relationships AS (
  SELECT
    lead."instant_quote_id",
    (array_agg(DISTINCT lead."contact_id" ORDER BY lead."contact_id"))[1]
      AS "contact_id",
    (array_agg(DISTINCT lead."property_id" ORDER BY lead."property_id"))[1]
      AS "property_id"
  FROM "leads" AS lead
  WHERE lead."instant_quote_id" IS NOT NULL
  GROUP BY lead."instant_quote_id"
  HAVING count(DISTINCT lead."contact_id") = 1
     AND count(DISTINCT lead."property_id") = 1
)
UPDATE "instant_quotes" AS quote
SET
  "contact_id" = deterministic."contact_id",
  "property_id" = deterministic."property_id"
FROM deterministic_relationships AS deterministic
WHERE quote."id" = deterministic."instant_quote_id"
  AND quote."contact_id" IS NULL
  AND quote."property_id" IS NULL;

ALTER TABLE "instant_quotes"
  VALIDATE CONSTRAINT "instant_quotes_contact_id_contacts_id_fk";

ALTER TABLE "instant_quotes"
  VALIDATE CONSTRAINT "instant_quotes_property_id_properties_id_fk";

ALTER TABLE "instant_quote_relationship_backfill_ambiguities"
  VALIDATE CONSTRAINT "instant_quote_relationship_backfill_ambiguities_quote_fk";

-- New writes set both columns together, and the association FK prevents a
-- contact/property pair from pointing at an unrelated physical property.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'instant_quotes_contact_property_association_fk'
  ) THEN
    ALTER TABLE "instant_quotes"
      ADD CONSTRAINT "instant_quotes_contact_property_association_fk"
      FOREIGN KEY ("contact_id", "property_id")
      REFERENCES "public"."contact_properties"("contact_id", "property_id")
      ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

ALTER TABLE "instant_quotes"
  VALIDATE CONSTRAINT "instant_quotes_contact_property_association_fk";

COMMENT ON COLUMN "instant_quotes"."contact_id" IS
  'Explicit CRM contact relationship; nullable when public quote persistence cannot be linked safely.';

COMMENT ON COLUMN "instant_quotes"."property_id" IS
  'Explicit physical property relationship; set atomically with contact_id.';

COMMENT ON TABLE "instant_quote_relationship_backfill_ambiguities" IS
  'Durable report of legacy instant quotes whose lead relationships could not be backfilled without guessing.';
