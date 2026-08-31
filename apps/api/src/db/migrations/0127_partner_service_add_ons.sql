-- Canonical, quantity-priced Partner Portal add-ons. Drafts retain only
-- validated selections; jobs retain an immutable public/commercial snapshot.

CREATE TABLE "partner_service_add_ons" (
  "key" varchar(80) PRIMARY KEY,
  "label" text NOT NULL,
  "description" text NOT NULL,
  "unit_label" varchar(80) NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_service_add_ons_key_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_-]{1,79}$')
);
CREATE INDEX "partner_service_add_ons_active_idx"
  ON "partner_service_add_ons" ("active", "label");

-- Keep the established Stonegate junk-removal service usable even on an
-- installation whose first partner rate card is configured after migration.
-- The conservative profile supports review requests; staff must explicitly
-- enable instant confirmation after operational duration/capacity review.
INSERT INTO "partner_service_catalog" (
  "key", "label", "description", "active", "instant_bookable",
  "required_scope_fields"
) VALUES (
  'junk-removal', 'Junk removal',
  'Junk removal priced by base load plus applicable disposal add-ons.',
  true, false, ARRAY['description', 'location', 'onSiteContact']::text[]
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "partner_scheduling_profiles" (
  "service_key", "version", "duration_minutes", "travel_buffer_minutes",
  "capacity_pool_key", "capacity_units", "required_scope_fields",
  "pricing_eligibility", "instant_confirmation_enabled", "active"
)
SELECT
  'junk-removal', 1, 120, 30, 'field_service', 1,
  ARRAY['description', 'location', 'onSiteContact']::text[],
  '{"reviewRequired":true,"configurationSource":"add_on_safe_seed"}'::jsonb,
  false, true
WHERE NOT EXISTS (
  SELECT 1 FROM "partner_scheduling_profiles"
  WHERE "service_key" = 'junk-removal'
)
ON CONFLICT ("service_key", "version") DO NOTHING;

CREATE TABLE "partner_service_add_on_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "service_key" varchar(80) NOT NULL
    REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "add_on_key" varchar(80) NOT NULL
    REFERENCES "partner_service_add_ons"("key") ON DELETE RESTRICT,
  "minimum_quantity" integer DEFAULT 1 NOT NULL,
  "maximum_quantity" integer DEFAULT 100 NOT NULL,
  "instant_confirmation_max_quantity" integer,
  "requires_review" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_service_add_on_options_quantity_check"
    CHECK (
      "minimum_quantity" BETWEEN 1 AND 100
      AND "maximum_quantity" BETWEEN "minimum_quantity" AND 100
    ),
  CONSTRAINT "partner_service_add_on_options_instant_quantity_check"
    CHECK (
      "instant_confirmation_max_quantity" IS NULL
      OR "instant_confirmation_max_quantity"
        BETWEEN "minimum_quantity" AND "maximum_quantity"
    )
);
CREATE UNIQUE INDEX "partner_service_add_on_options_service_add_on_key"
  ON "partner_service_add_on_options" ("service_key", "add_on_key");
CREATE INDEX "partner_service_add_on_options_service_active_idx"
  ON "partner_service_add_on_options" ("service_key", "active", "sort_order");

INSERT INTO "partner_service_add_ons" (
  "key", "label", "description", "unit_label", "active"
) VALUES
  (
    'mattress_disposal', 'Mattress disposal',
    'Additional disposal handling for each mattress or box spring.',
    'mattress', true
  ),
  (
    'paint_can_disposal', 'Paint can disposal',
    'Additional handling for each accepted paint can.',
    'can', true
  ),
  (
    'tire_disposal', 'Tire disposal',
    'Additional disposal handling for each accepted tire.',
    'tire', true
  )
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "partner_service_add_on_options" (
  "service_key", "add_on_key", "minimum_quantity", "maximum_quantity",
  "instant_confirmation_max_quantity", "requires_review", "active",
  "sort_order"
)
SELECT 'junk-removal', configured."add_on_key", 1, 100, 10, false, true,
  configured."sort_order"
FROM (VALUES
  ('mattress_disposal', 10),
  ('paint_can_disposal', 20),
  ('tire_disposal', 30)
) AS configured("add_on_key", "sort_order")
WHERE EXISTS (
  SELECT 1 FROM "partner_service_catalog" service
  WHERE service."key" = 'junk-removal'
)
ON CONFLICT ("service_key", "add_on_key") DO NOTHING;

CREATE TABLE "partner_rate_add_on_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rate_card_id" uuid NOT NULL
    REFERENCES "partner_rate_cards"("id") ON DELETE CASCADE,
  "service_key" varchar(80) NOT NULL
    REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "add_on_key" varchar(80) NOT NULL
    REFERENCES "partner_service_add_ons"("key") ON DELETE RESTRICT,
  "unit_amount_cents" integer NOT NULL
    CHECK ("unit_amount_cents" >= 0),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_rate_add_on_items_configured_option_fk"
    FOREIGN KEY ("service_key", "add_on_key")
    REFERENCES "partner_service_add_on_options"("service_key", "add_on_key")
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "partner_rate_add_on_items_card_service_add_on_key"
  ON "partner_rate_add_on_items" ("rate_card_id", "service_key", "add_on_key");
CREATE INDEX "partner_rate_add_on_items_service_add_on_idx"
  ON "partner_rate_add_on_items" ("service_key", "add_on_key");

INSERT INTO "partner_rate_add_on_items" (
  "rate_card_id", "service_key", "add_on_key", "unit_amount_cents"
)
SELECT item."rate_card_id", item."service_key",
  CASE item."tier_key"
    WHEN 'mattress_fee' THEN 'mattress_disposal'
    WHEN 'paint_fee' THEN 'paint_can_disposal'
    WHEN 'tire_fee' THEN 'tire_disposal'
  END,
  item."amount_cents"
FROM "partner_rate_items" item
WHERE item."service_key" = 'junk-removal'
  AND item."tier_key" IN ('mattress_fee', 'paint_fee', 'tire_fee')
ON CONFLICT ("rate_card_id", "service_key", "add_on_key")
DO UPDATE SET "unit_amount_cents" = excluded."unit_amount_cents";

ALTER TABLE "partner_booking_drafts"
  ADD COLUMN "tier_key" varchar(100),
  ADD COLUMN "selected_add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD CONSTRAINT "partner_booking_drafts_tier_key_check"
    CHECK (
      "tier_key" IS NULL
      OR "tier_key" ~ '^[a-z0-9][a-z0-9_-]{0,99}$'
    ),
  ADD CONSTRAINT "partner_booking_drafts_selected_add_ons_shape_check"
    CHECK (
      jsonb_typeof("selected_add_ons") = 'array'
      AND jsonb_array_length("selected_add_ons") <= 20
    );

ALTER TABLE "partner_bookings"
  ADD COLUMN "add_ons_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD CONSTRAINT "partner_bookings_add_ons_snapshot_shape_check"
    CHECK (
      jsonb_typeof("add_ons_snapshot") = 'array'
      AND jsonb_array_length("add_ons_snapshot") <= 20
    );
