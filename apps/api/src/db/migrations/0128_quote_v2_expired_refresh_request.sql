-- Permit signer-only expired proposal refresh requests and require their
-- canonical change-request evidence. Existing native signer capabilities
-- remain valid; the runtime derives refresh compatibility from their prior
-- `change` grant only for an exact expired current/published version.
ALTER TABLE "quote_capabilities"
  DROP CONSTRAINT "quote_capabilities_actions_check";
--> statement-breakpoint

ALTER TABLE "quote_capabilities"
  ADD CONSTRAINT "quote_capabilities_actions_check"
    CHECK (
      cardinality("allowed_actions") > 0
      AND "allowed_actions" <@ ARRAY[
        'view', 'pdf', 'change', 'refresh', 'accept', 'decline',
        'availability', 'hold', 'checkout', 'book'
      ]::text[]
      AND (
        "recipient_role" = 'signer'
        OR NOT (
          "allowed_actions" && ARRAY[
            'change', 'refresh', 'accept', 'decline',
            'availability', 'hold', 'checkout', 'book'
          ]::text[]
        )
      )
    )
    NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_capabilities"
  VALIDATE CONSTRAINT "quote_capabilities_actions_check";
--> statement-breakpoint

-- Preserve already-imported legacy bearer URLs. Earlier backfill versions
-- reduced expired links to view/PDF-only, which would otherwise strand the
-- customer after the V2 public router took ownership of the URL. This grant is
-- deliberately narrow: exact current/published legacy snapshot, open quote and
-- opportunity, active contact/signer/read retention, genuine expiry, and no
-- prior refresh/change/terminal evidence. It does not reopen the expired
-- version or restore any accept/payment/booking action.
UPDATE "quote_capabilities" AS "capability"
SET
  "allowed_actions" = array_append("capability"."allowed_actions", 'refresh'),
  "updated_at" = now()
FROM
  "quotes" AS "quote",
  "quote_versions" AS "version",
  "sales_opportunities" AS "opportunity",
  "contacts" AS "contact"
WHERE
  "capability"."quote_id" = "quote"."id"
  AND "capability"."quote_version_id" = "version"."id"
  AND "version"."quote_id" = "quote"."id"
  AND "quote"."sales_opportunity_id" = "opportunity"."id"
  AND "quote"."contact_id" = "contact"."id"
  AND "quote"."engine_version" = 'v2'
  AND "quote"."aggregate_state" = 'open'
  AND "opportunity"."status" = 'open'
  AND "quote"."current_version_id" = "version"."id"
  AND "quote"."published_version_id" = "version"."id"
  AND "version"."provenance" = 'legacy_current_state'
  AND "version"."state" IN ('issued', 'expired')
  AND "version"."expires_at" IS NOT NULL
  AND "version"."expires_at" <= now()
  AND "version"."document_snapshot" #>> '{lifecycle,refreshRequestedAt}' IS NULL
  AND "contact"."deleted_at" IS NULL
  AND "capability"."recipient_role" = 'signer'
  AND "capability"."status" = 'active'
  AND "capability"."read_expires_at" > now()
  AND NOT ('refresh' = ANY("capability"."allowed_actions"))
  AND NOT EXISTS (
    SELECT 1
    FROM "quote_change_requests" AS "change_request"
    WHERE
      "change_request"."quote_id" = "quote"."id"
      AND "change_request"."status" IN ('open', 'acknowledged')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "quote_responses" AS "response"
    WHERE
      "response"."quote_version_id" = "version"."id"
      AND "response"."response_type" IN (
        'accepted', 'declined', 'change_requested', 'refresh_requested'
      )
  );
--> statement-breakpoint

ALTER TABLE "quote_responses"
  DROP CONSTRAINT "quote_responses_change_request_check";
--> statement-breakpoint

ALTER TABLE "quote_responses"
  ADD CONSTRAINT "quote_responses_change_request_check"
    CHECK (
      "response_type" NOT IN ('change_requested', 'refresh_requested')
      OR "change_request_id" IS NOT NULL
    )
    NOT VALID;
--> statement-breakpoint

ALTER TABLE "quote_responses"
  VALIDATE CONSTRAINT "quote_responses_change_request_check";
