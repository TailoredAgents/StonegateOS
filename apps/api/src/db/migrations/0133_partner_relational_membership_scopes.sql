-- Relational, tenant-safe partner membership scopes. access_scope JSON remains
-- a migration/display projection and is no longer loaded as authority.

CREATE TABLE "partner_account_cost_centers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "code" varchar(120) NOT NULL,
  "name" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_account_cost_centers_code_check"
    CHECK (length(btrim("code")) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "partner_account_cost_centers_account_id_key"
  ON "partner_account_cost_centers" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_account_cost_centers_account_code_key"
  ON "partner_account_cost_centers" ("partner_account_id", "code");
CREATE INDEX "partner_account_cost_centers_account_active_idx"
  ON "partner_account_cost_centers" ("partner_account_id", "active", "name");

CREATE TABLE "partner_membership_location_scopes" (
  "membership_id" uuid NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_membership_location_scopes_pk"
    PRIMARY KEY ("membership_id", "location_id"),
  CONSTRAINT "partner_membership_location_scopes_membership_account_fk"
    FOREIGN KEY ("membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_membership_location_scopes_location_account_fk"
    FOREIGN KEY ("partner_account_id", "location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "partner_membership_location_scopes_account_membership_idx"
  ON "partner_membership_location_scopes" ("partner_account_id", "membership_id");

CREATE TABLE "partner_membership_cost_center_scopes" (
  "membership_id" uuid NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "cost_center_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_membership_cost_center_scopes_pk"
    PRIMARY KEY ("membership_id", "cost_center_id"),
  CONSTRAINT "partner_membership_cost_center_scopes_membership_account_fk"
    FOREIGN KEY ("membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_membership_cost_center_scopes_cost_center_account_fk"
    FOREIGN KEY ("partner_account_id", "cost_center_id")
    REFERENCES "partner_account_cost_centers"("partner_account_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "partner_membership_cost_center_scopes_account_membership_idx"
  ON "partner_membership_cost_center_scopes" ("partner_account_id", "membership_id");

-- Direct location grants.
INSERT INTO "partner_membership_location_scopes" (
  "membership_id", "partner_account_id", "location_id"
)
SELECT DISTINCT
  "membership"."id",
  "membership"."partner_account_id",
  "location"."id"
FROM "partner_account_memberships" AS "membership"
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof("membership"."access_scope" -> 'locationIds') = 'array'
      THEN "membership"."access_scope" -> 'locationIds'
    ELSE '[]'::jsonb
  END
) AS "scope_value"("value")
INNER JOIN "partner_account_locations" AS "location"
  ON "location"."partner_account_id" = "membership"."partner_account_id"
  AND "scope_value"."value" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND "location"."id" = "scope_value"."value"::uuid
WHERE "membership"."access_level" = 'scoped'
ON CONFLICT DO NOTHING;
-- Legacy property grants resolve through an account-owned location so tenant
-- identity is proven before a relational grant is created.
INSERT INTO "partner_membership_location_scopes" (
  "membership_id", "partner_account_id", "location_id"
)
SELECT DISTINCT
  "membership"."id",
  "membership"."partner_account_id",
  "location"."id"
FROM "partner_account_memberships" AS "membership"
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof("membership"."access_scope" -> 'propertyIds') = 'array'
      THEN "membership"."access_scope" -> 'propertyIds'
    ELSE '[]'::jsonb
  END
) AS "scope_value"("value")
INNER JOIN "partner_account_locations" AS "location"
  ON "location"."partner_account_id" = "membership"."partner_account_id"
  AND "scope_value"."value" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND "location"."property_id" = "scope_value"."value"::uuid
WHERE "membership"."access_level" = 'scoped'
ON CONFLICT DO NOTHING;

INSERT INTO "partner_account_cost_centers" (
  "partner_account_id", "code", "name"
)
SELECT DISTINCT
  "membership"."partner_account_id",
  left(btrim("scope_value"."value"), 120),
  left(btrim("scope_value"."value"), 120)
FROM "partner_account_memberships" AS "membership"
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof("membership"."access_scope" -> 'costCenterIds') = 'array'
      THEN "membership"."access_scope" -> 'costCenterIds'
    ELSE '[]'::jsonb
  END
) AS "scope_value"("value")
WHERE "membership"."access_level" = 'scoped'
  AND length(btrim("scope_value"."value")) BETWEEN 1 AND 120
ON CONFLICT ("partner_account_id", "code") DO NOTHING;

INSERT INTO "partner_membership_cost_center_scopes" (
  "membership_id", "partner_account_id", "cost_center_id"
)
SELECT DISTINCT
  "membership"."id",
  "membership"."partner_account_id",
  "cost_center"."id"
FROM "partner_account_memberships" AS "membership"
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof("membership"."access_scope" -> 'costCenterIds') = 'array'
      THEN "membership"."access_scope" -> 'costCenterIds'
    ELSE '[]'::jsonb
  END
) AS "scope_value"("value")
INNER JOIN "partner_account_cost_centers" AS "cost_center"
  ON "cost_center"."partner_account_id" = "membership"."partner_account_id"
  AND "cost_center"."code" = left(btrim("scope_value"."value"), 120)
WHERE "membership"."access_level" = 'scoped'
ON CONFLICT DO NOTHING;
