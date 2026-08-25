-- Backfill active website self-bookings created before the booking endpoint
-- started copying the customer-visible instant-quote range into CRM metadata.
-- Existing booking details are authoritative and are never overwritten.

WITH "online_booking_quotes" AS (
  SELECT
    appointment."id" AS "appointment_id",
    quote."job_types",
    quote."perceived_size",
    quote."ai_result",
    lead."source" AS "lead_source",
    lead."utm_source",
    lead."gclid",
    lead."fbclid",
    CASE
      WHEN jsonb_typeof(quote."ai_result" -> 'priceLowDiscounted') = 'number'
        THEN (quote."ai_result" ->> 'priceLowDiscounted')::numeric
      -- Legacy demolition quotes returned (but did not persist) their fixed
      -- display discount. Reconstruct the historical $100 default when the
      -- saved quote has no explicit discount amount.
      WHEN jsonb_typeof(quote."ai_result" -> 'meta' -> 'demoType') = 'string'
        AND jsonb_typeof(quote."ai_result" -> 'priceLow') = 'number'
        THEN greatest(
          0,
          (quote."ai_result" ->> 'priceLow')::numeric
            - CASE
                WHEN jsonb_typeof(quote."ai_result" -> 'discountAmount') = 'number'
                  THEN (quote."ai_result" ->> 'discountAmount')::numeric
                ELSE 100
              END
        )
      WHEN jsonb_typeof(quote."ai_result" -> 'priceLow') = 'number'
        THEN (quote."ai_result" ->> 'priceLow')::numeric
      ELSE NULL
    END AS "price_low_dollars",
    CASE
      WHEN jsonb_typeof(quote."ai_result" -> 'priceHighDiscounted') = 'number'
        THEN (quote."ai_result" ->> 'priceHighDiscounted')::numeric
      WHEN jsonb_typeof(quote."ai_result" -> 'meta' -> 'demoType') = 'string'
        AND jsonb_typeof(quote."ai_result" -> 'priceHigh') = 'number'
        THEN greatest(
          0,
          (quote."ai_result" ->> 'priceHigh')::numeric
            - CASE
                WHEN jsonb_typeof(quote."ai_result" -> 'discountAmount') = 'number'
                  THEN (quote."ai_result" ->> 'discountAmount')::numeric
                ELSE 100
              END
        )
      WHEN jsonb_typeof(quote."ai_result" -> 'priceHigh') = 'number'
        THEN (quote."ai_result" ->> 'priceHigh')::numeric
      ELSE NULL
    END AS "price_high_dollars",
    CASE
      WHEN jsonb_typeof(quote."ai_result" -> 'loadFractionEstimate') = 'number'
        THEN (quote."ai_result" ->> 'loadFractionEstimate')::numeric
      ELSE NULL
    END AS "load_fraction",
    EXISTS (
      SELECT 1
      FROM unnest(quote."job_types") AS "job_type"
      WHERE lower(regexp_replace("job_type", '[^a-z0-9]+', '_', 'g')) LIKE 'demo\_%' ESCAPE '\'
    ) AS "is_demolition_quote"
  FROM "appointments" AS appointment
  INNER JOIN "leads" AS lead
    ON lead."id" = appointment."lead_id"
  INNER JOIN "instant_quotes" AS quote
    ON quote."id" = lead."instant_quote_id"
  WHERE appointment."booking_details" IS NULL
    AND appointment."type" = 'estimate'
    AND appointment."status" IN ('requested', 'confirmed')
),
"valid_booking_ranges" AS (
  SELECT
    source.*,
    round(least(source."price_low_dollars", source."price_high_dollars") * 100)::integer
      AS "range_min_cents",
    round(greatest(source."price_low_dollars", source."price_high_dollars") * 100)::integer
      AS "range_max_cents",
    CASE
      WHEN source."fbclid" IS NOT NULL
        OR lower(coalesce(source."lead_source", '')) SIMILAR TO '%(facebook|instagram|messenger|meta)%'
        OR lower(coalesce(source."utm_source", '')) SIMILAR TO '%(facebook|instagram|messenger|meta)%'
        THEN 'facebook'
      WHEN source."gclid" IS NOT NULL
        OR lower(coalesce(source."lead_source", '')) LIKE '%google%'
        OR lower(coalesce(source."utm_source", '')) LIKE '%google%'
        THEN 'google'
      ELSE 'website'
    END AS "booking_source"
  FROM "online_booking_quotes" AS source
  WHERE source."price_low_dollars" IS NOT NULL
    AND source."price_high_dollars" IS NOT NULL
    AND source."price_low_dollars" >= 0
    AND source."price_high_dollars" >= 0
    AND greatest(source."price_low_dollars", source."price_high_dollars") * 100 <= 2147483647
),
"booking_details_backfill" AS (
  SELECT
    source."appointment_id",
    CASE
      WHEN source."is_demolition_quote" THEN
        jsonb_build_object(
          'serviceType', 'demolition',
          'source', jsonb_build_object('type', source."booking_source"),
          'pricing', jsonb_build_object(
            'mode', 'range',
            'rangeMinCents', source."range_min_cents",
            'rangeMaxCents', source."range_max_cents"
          ),
          'demolition', jsonb_build_object(
            'demoType', CASE lower(coalesce(source."ai_result" -> 'meta' ->> 'demoType', ''))
              WHEN 'shed' THEN 'shed'
              WHEN 'deck' THEN 'deck'
              WHEN 'fence' THEN 'fence'
              WHEN 'kitchen_bath' THEN 'interior'
              WHEN 'drywall' THEN 'interior'
              WHEN 'concrete' THEN 'concrete'
              ELSE 'other'
            END,
            'scopeSize', left(
              coalesce(
                nullif(source."ai_result" -> 'meta' ->> 'demoSize', ''),
                nullif(source."perceived_size", ''),
                'Demolition scope'
              ),
              240
            ),
            'haulAway', CASE
              WHEN jsonb_typeof(source."ai_result" -> 'meta' -> 'haulAway') = 'boolean'
                THEN (source."ai_result" -> 'meta' ->> 'haulAway')::boolean
              ELSE true
            END
          )
        )
      ELSE
        jsonb_build_object(
          'serviceType', 'junk_removal',
          'source', jsonb_build_object('type', source."booking_source"),
          'pricing', jsonb_build_object(
            'mode', 'range',
            'rangeMinCents', source."range_min_cents",
            'rangeMaxCents', source."range_max_cents"
          ),
          'loadSize', CASE
            WHEN source."load_fraction" > 1 THEN
              jsonb_build_object(
                'kind', 'custom',
                'customLoads', ceil(source."load_fraction" * 4) / 4
              )
            WHEN source."load_fraction" > 0.75 THEN
              jsonb_build_object('kind', 'three_quarters_to_full', 'customLoads', NULL)
            WHEN source."load_fraction" > 0.5 THEN
              jsonb_build_object('kind', 'half_to_three_quarters', 'customLoads', NULL)
            WHEN source."load_fraction" > 0 THEN
              jsonb_build_object('kind', 'quarter_to_half', 'customLoads', NULL)
            WHEN lower(source."perceived_size") SIMILAR TO '%(full|large|big)%' THEN
              jsonb_build_object('kind', 'three_quarters_to_full', 'customLoads', NULL)
            WHEN lower(source."perceived_size") SIMILAR TO '%(half|medium)%' THEN
              jsonb_build_object('kind', 'half_to_three_quarters', 'customLoads', NULL)
            ELSE
              jsonb_build_object('kind', 'quarter_to_half', 'customLoads', NULL)
          END
        )
    END AS "booking_details"
  FROM "valid_booking_ranges" AS source
)
UPDATE "appointments" AS appointment
SET
  "booking_details" = backfill."booking_details",
  "updated_at" = date_trunc('milliseconds', clock_timestamp())
FROM "booking_details_backfill" AS backfill
WHERE appointment."id" = backfill."appointment_id"
  AND appointment."booking_details" IS NULL;

COMMENT ON COLUMN "appointments"."booking_details" IS
  'Validated CRM booking metadata; legacy active website self-bookings were backfilled from their linked instant quotes in migration 0101.';
