-- Canonical Partner commercial agreement and Quote-V2-backed job change
-- orders. Global catalog configuration never grants account entitlement.

CREATE UNIQUE INDEX IF NOT EXISTS "partner_documents_account_document_key"
  ON "partner_documents" ("partner_account_id", "id");

CREATE OR REPLACE FUNCTION "partner_bounded_text_array"(
  value jsonb,
  maximum_items integer,
  maximum_length integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array'
    OR jsonb_array_length(value) > maximum_items
  THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value)
  LOOP
    IF jsonb_typeof(item) <> 'string'
      OR length(btrim(item #>> '{}')) NOT BETWEEN 1 AND maximum_length
      OR item #>> '{}' IS DISTINCT FROM btrim(item #>> '{}')
    THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION "partner_valid_service_entitlements"(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  item jsonb;
  service_keys text[] := ARRAY[]::text[];
  service_key text;
BEGIN
  IF jsonb_typeof(value) <> 'array'
    OR jsonb_array_length(value) NOT BETWEEN 1 AND 100
  THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value)
  LOOP
    IF jsonb_typeof(item) <> 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
         IS DISTINCT FROM ARRAY['exclusions', 'inclusions', 'pricingState', 'quoteRule', 'serviceKey']::text[]
      OR coalesce(item ->> 'serviceKey', '') !~ '^[a-z][a-z0-9_-]{1,79}$'
      OR item ->> 'pricingState' NOT IN ('contracted', 'estimate', 'quote_required', 'standard_rate')
      OR NOT partner_bounded_text_array(item -> 'inclusions', 40, 500)
      OR NOT partner_bounded_text_array(item -> 'exclusions', 40, 500)
      OR NOT (
        item -> 'quoteRule' = 'null'::jsonb
        OR (
          jsonb_typeof(item -> 'quoteRule') = 'string'
          AND length(btrim(item ->> 'quoteRule')) BETWEEN 1 AND 1000
          AND item ->> 'quoteRule' = btrim(item ->> 'quoteRule')
        )
      )
    THEN
      RETURN false;
    END IF;
    service_key := item ->> 'serviceKey';
    IF service_key = ANY(service_keys) THEN
      RETURN false;
    END IF;
    service_keys := array_append(service_keys, service_key);
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE "partner_account_service_agreements" (
  "partner_account_id" uuid PRIMARY KEY REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "active" boolean NOT NULL DEFAULT false,
  "agreement_label" varchar(160) NOT NULL,
  "currency" varchar(3) NOT NULL,
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "inclusions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "exclusions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "quote_rules" text,
  "service_entitlements" jsonb NOT NULL,
  "agreement_document_id" uuid,
  "revision" integer NOT NULL DEFAULT 1,
  "updated_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_account_service_agreements_document_account_fk"
    FOREIGN KEY ("partner_account_id", "agreement_document_id")
    REFERENCES "partner_documents"("partner_account_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_service_agreements_label_check"
    CHECK ("agreement_label" = btrim("agreement_label") AND length("agreement_label") BETWEEN 1 AND 160),
  CONSTRAINT "partner_account_service_agreements_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "partner_account_service_agreements_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "partner_account_service_agreements_lists_check"
    CHECK (
      partner_bounded_text_array("inclusions", 40, 500)
      AND partner_bounded_text_array("exclusions", 40, 500)
    ),
  CONSTRAINT "partner_account_service_agreements_entitlements_check"
    CHECK (partner_valid_service_entitlements("service_entitlements")),
  CONSTRAINT "partner_account_service_agreements_quote_rules_check"
    CHECK ("quote_rules" IS NULL OR ("quote_rules" = btrim("quote_rules") AND length("quote_rules") BETWEEN 1 AND 2000)),
  CONSTRAINT "partner_account_service_agreements_revision_check"
    CHECK ("revision" > 0)
);

CREATE INDEX "partner_account_service_agreements_effective_idx"
  ON "partner_account_service_agreements" ("active", "effective_from", "effective_to");

-- Existing explicit account rates are the only safe entitlement source. Pick
-- the highest-version/latest-effective current card deterministically; do not
-- infer entitlement from the global service catalog.
WITH ranked_cards AS (
  SELECT card.*,
    row_number() OVER (
      PARTITION BY card."partner_account_id"
      ORDER BY card."version" DESC, card."effective_from" DESC, card."id" DESC
    ) AS position
  FROM "partner_rate_cards" card
  WHERE card."partner_account_id" IS NOT NULL
    AND card."active" = true
    AND card."effective_from" <= now()
    AND (card."effective_to" IS NULL OR card."effective_to" > now())
    AND upper(btrim(card."currency")) ~ '^[A-Z]{3}$'
), selected_cards AS (
  SELECT * FROM ranked_cards WHERE position = 1
), entitled_services AS (
  SELECT card."partner_account_id", card."currency", card."effective_from",
    card."effective_to", item."service_key"
  FROM selected_cards card
  JOIN "partner_rate_items" item ON item."rate_card_id" = card."id"
  JOIN "partner_service_catalog" service
    ON service."key" = item."service_key" AND service."active" = true
  WHERE NOT (
    item."service_key" = 'junk-removal'
    AND item."tier_key" IN ('mattress_fee', 'paint_fee', 'tire_fee')
  )
  GROUP BY card."partner_account_id", card."currency", card."effective_from",
    card."effective_to", item."service_key"
), agreement_rows AS (
  SELECT "partner_account_id", upper(btrim("currency")) AS "currency",
    "effective_from", "effective_to",
    jsonb_agg(
      jsonb_build_object(
        'serviceKey', "service_key",
        'pricingState', 'contracted',
        'inclusions', '[]'::jsonb,
        'exclusions', '[]'::jsonb,
        'quoteRule', null
      ) ORDER BY "service_key"
    ) AS "service_entitlements"
  FROM entitled_services
  GROUP BY "partner_account_id", upper(btrim("currency")), "effective_from", "effective_to"
)
INSERT INTO "partner_account_service_agreements" (
  "partner_account_id", "active", "agreement_label", "currency",
  "effective_from", "effective_to", "inclusions", "exclusions",
  "quote_rules", "service_entitlements", "revision", "created_at", "updated_at"
)
SELECT "partner_account_id", true, 'Current Partner service agreement',
  "currency", "effective_from", "effective_to", '[]'::jsonb, '[]'::jsonb,
  null, "service_entitlements", 1, now(), now()
FROM agreement_rows
ON CONFLICT ("partner_account_id") DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS "partner_job_change_requests_account_booking_request_key"
  ON "partner_job_change_requests" ("partner_account_id", "partner_booking_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "partner_quotes_account_booking_projection_key"
  ON "partner_quotes" ("partner_account_id", "partner_booking_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "quote_responses_id_quote_version_key"
  ON "quote_responses" ("id", "quote_id", "quote_version_id");

CREATE TABLE "partner_job_change_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL,
  "partner_job_change_request_id" uuid NOT NULL,
  "partner_quote_id" uuid NOT NULL,
  "quote_id" uuid NOT NULL,
  "quote_version_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'offered',
  "offer_snapshot" jsonb NOT NULL,
  "base_booking_revision" integer NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "offered_by_team_member_id" uuid NOT NULL REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "quote_response_id" uuid,
  "resolution_snapshot" jsonb,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_job_change_orders_request_account_job_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id", "partner_job_change_request_id")
    REFERENCES "partner_job_change_requests"("partner_account_id", "partner_booking_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "partner_job_change_orders_quote_account_job_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id", "partner_quote_id")
    REFERENCES "partner_quotes"("partner_account_id", "partner_booking_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "partner_job_change_orders_version_quote_fk"
    FOREIGN KEY ("quote_version_id", "quote_id")
    REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "partner_job_change_orders_response_quote_version_fk"
    FOREIGN KEY ("quote_response_id", "quote_id", "quote_version_id")
    REFERENCES "quote_responses"("id", "quote_id", "quote_version_id") ON DELETE RESTRICT,
  CONSTRAINT "partner_job_change_orders_state_check"
    CHECK ("state" IN ('offered', 'accepted', 'declined', 'superseded')),
  CONSTRAINT "partner_job_change_orders_offer_check"
    CHECK (
      jsonb_typeof("offer_snapshot") = 'object'
      AND "offer_snapshot" ->> 'version' = '1'
      AND ("offer_snapshot" ->> 'amountMinor')::numeric > 0
      AND "offer_snapshot" ->> 'currency' ~ '^[A-Z]{3}$'
    ),
  CONSTRAINT "partner_job_change_orders_revision_check"
    CHECK ("revision" > 0 AND "base_booking_revision" > 0),
  CONSTRAINT "partner_job_change_orders_resolution_check"
    CHECK (
      ("state" = 'offered' AND "quote_response_id" IS NULL AND "resolution_snapshot" IS NULL AND "resolved_at" IS NULL)
      OR (
        "state" IN ('accepted', 'declined', 'superseded')
        AND jsonb_typeof("resolution_snapshot") = 'object'
        AND "resolution_snapshot" ->> 'version' = '1'
        AND "resolution_snapshot" ->> 'outcome' = "state"
        AND "resolved_at" IS NOT NULL
        AND (("state" IN ('accepted', 'declined') AND "quote_response_id" IS NOT NULL) OR ("state" = 'superseded' AND "quote_response_id" IS NULL))
      )
    )
);

CREATE UNIQUE INDEX "partner_job_change_orders_request_key"
  ON "partner_job_change_orders" ("partner_job_change_request_id");
CREATE UNIQUE INDEX "partner_job_change_orders_quote_key"
  ON "partner_job_change_orders" ("partner_quote_id");
CREATE UNIQUE INDEX "partner_job_change_orders_active_booking_key"
  ON "partner_job_change_orders" ("partner_account_id", "partner_booking_id")
  WHERE "state" = 'offered';
CREATE INDEX "partner_job_change_orders_account_state_idx"
  ON "partner_job_change_orders" ("partner_account_id", "state", "created_at", "id");

CREATE OR REPLACE FUNCTION "enforce_partner_job_change_order_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."partner_job_change_request_id" IS DISTINCT FROM OLD."partner_job_change_request_id"
    OR NEW."partner_quote_id" IS DISTINCT FROM OLD."partner_quote_id"
    OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."quote_version_id" IS DISTINCT FROM OLD."quote_version_id"
    OR NEW."offer_snapshot" IS DISTINCT FROM OLD."offer_snapshot"
    OR NEW."base_booking_revision" IS DISTINCT FROM OLD."base_booking_revision"
    OR NEW."offered_by_team_member_id" IS DISTINCT FROM OLD."offered_by_team_member_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_job_change_order_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" <> 'offered'
    OR NEW."state" NOT IN ('accepted', 'declined', 'superseded')
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_job_change_order_transition_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_job_change_orders_immutable_trigger"
BEFORE UPDATE ON "partner_job_change_orders"
FOR EACH ROW EXECUTE FUNCTION "enforce_partner_job_change_order_immutable"();

COMMENT ON TABLE "partner_account_service_agreements" IS
  'Canonical account-owned Partner service entitlement, price-state, currency, and agreement presentation policy.';
COMMENT ON TABLE "partner_job_change_orders" IS
  'Immutable account/job-bound bridge from a material Partner job change request to one exact accepted Quote V2.';
