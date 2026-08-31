-- Quote V2 booking evidence. The appointment projection retains the exact
-- accepted configuration/range and content hashes even if mutable CRM data is
-- later anonymized or changed.

ALTER TABLE "appointments"
  ADD COLUMN "quote_response_id" uuid,
  ADD COLUMN "quoted_total_max_cents" integer,
  ADD COLUMN "quote_configuration_hash" varchar(64),
  ADD COLUMN "quote_content_hash" varchar(64),
  ADD CONSTRAINT "appointments_quote_response_id_fk"
    FOREIGN KEY ("quote_response_id") REFERENCES "quote_responses"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "appointments_quote_evidence_check"
    CHECK (
      "quote_response_id" IS NULL
      OR (
        "quote_version_id" IS NOT NULL
        AND "sales_opportunity_id" IS NOT NULL
        AND "quoted_total_cents" IS NOT NULL
        AND "quoted_total_cents" > 0
        AND "quoted_total_max_cents" IS NOT NULL
        AND "quoted_total_max_cents" >= "quoted_total_cents"
        AND "quote_configuration_hash" ~ '^[0-9a-f]{64}$'
        AND "quote_content_hash" ~ '^[0-9a-f]{64}$'
        AND nullif(btrim("quoted_scope_text"), '') IS NOT NULL
      )
    );

CREATE UNIQUE INDEX "appointments_quote_response_key"
  ON "appointments" ("quote_response_id")
  WHERE "quote_response_id" IS NOT NULL;
