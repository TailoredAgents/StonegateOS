-- Idempotent customer actions for bearer-capability quote pages.
--
-- The raw share token remains only on the protected quotes row. Replay is
-- scoped by quote ID and uses hashes for both the caller key and normalized
-- request, so generic operational storage never receives the capability.

CREATE TABLE IF NOT EXISTS "public_quote_mutation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quote_id" uuid NOT NULL,
  "action" text NOT NULL,
  "key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "response_status" integer NOT NULL,
  "response_body" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "public_quote_mutation_receipts_quote_id_quotes_id_fk"
    FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "public_quote_mutation_receipts_key_hash_check"
    CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "public_quote_mutation_receipts_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "public_quote_mutation_receipts_action_check"
    CHECK ("action" IN ('decision', 'refresh')),
  CONSTRAINT "public_quote_mutation_receipts_response_status_check"
    CHECK ("response_status" BETWEEN 200 AND 299),
  CONSTRAINT "public_quote_mutation_receipts_expiry_check"
    CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "public_quote_mutation_receipts_quote_action_key"
  ON "public_quote_mutation_receipts" ("quote_id", "action", "key_hash");

CREATE INDEX IF NOT EXISTS "public_quote_mutation_receipts_expires_idx"
  ON "public_quote_mutation_receipts" ("expires_at");

COMMENT ON TABLE "public_quote_mutation_receipts" IS
  'Token-free exact-replay receipts for customer quote decisions and refresh requests.';

-- The worker now reconstructs the URL from the protected quote row. Remove
-- capabilities copied into already-queued legacy quote-send events before
-- the new processor is enabled.
UPDATE "outbox_events"
SET "payload" = "payload" - 'shareToken' - 'shareUrl'
WHERE "type" = 'quote.sent'
  AND ("payload" ? 'shareToken' OR "payload" ? 'shareUrl');

-- Scrub capabilities copied by pre-0077 quote mutation receipts. The protected
-- quote row remains the only source used to reconstruct an authorized replay.
UPDATE "team_mutation_idempotency"
SET "response_body" =
  CASE "action"
    WHEN 'quote.created' THEN
      jsonb_set(
        "response_body" #- '{data,quote,shareToken}',
        '{data,shareUrl}',
        'null'::jsonb,
        true
      )
    WHEN 'quote.updated' THEN
      "response_body" #- '{data,quote,shareToken}'
    WHEN 'quote.sent' THEN
      jsonb_set(
        "response_body" - 'shareToken',
        '{data,shareUrl}',
        'null'::jsonb,
        true
      ) #- '{data,shareToken}'
    ELSE "response_body"
  END
WHERE "action" IN ('quote.created', 'quote.updated', 'quote.sent')
  AND "response_body" IS NOT NULL;
