-- Browser-confirmed proposal visibility is operational engagement, not
-- immutable acceptance evidence. Keep quote/version-scoped detail for 90 days
-- and preserve only identifier-free daily counts after that boundary.
CREATE TABLE "quote_visible_engagement_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "capability_id" uuid REFERENCES "quote_capabilities"("id") ON DELETE SET NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "visible_ms_bucket" text NOT NULL,
  "correlation_id" text,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_visible_engagement_version_match" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_visible_engagement_idempotency_hash_check" CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_visible_engagement_bucket_check" CHECK ("visible_ms_bucket" IN ('1-5s', '5-30s', '30s+')),
  CONSTRAINT "quote_visible_engagement_time_check" CHECK ("created_at" >= "occurred_at")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "quote_visible_engagement_version_idempotency_key"
  ON "quote_visible_engagement_events" ("quote_version_id", "idempotency_key_hash");
--> statement-breakpoint

CREATE INDEX "quote_visible_engagement_occurred_idx"
  ON "quote_visible_engagement_events" ("occurred_at", "id");
--> statement-breakpoint

CREATE INDEX "quote_visible_engagement_quote_history_idx"
  ON "quote_visible_engagement_events" ("quote_id", "occurred_at", "id");
--> statement-breakpoint

CREATE TABLE "quote_visible_engagement_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "engagement_date" date NOT NULL,
  "visible_ms_bucket" text NOT NULL,
  "event_count" bigint NOT NULL,
  "first_occurred_at" timestamptz NOT NULL,
  "last_occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_visible_engagement_daily_bucket_check" CHECK ("visible_ms_bucket" IN ('1-5s', '5-30s', '30s+')),
  CONSTRAINT "quote_visible_engagement_daily_count_check" CHECK ("event_count" > 0),
  CONSTRAINT "quote_visible_engagement_daily_time_check" CHECK ("last_occurred_at" >= "first_occurred_at")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "quote_visible_engagement_daily_date_bucket_key"
  ON "quote_visible_engagement_daily" ("engagement_date", "visible_ms_bucket");
--> statement-breakpoint

CREATE INDEX "quote_visible_engagement_daily_date_idx"
  ON "quote_visible_engagement_daily" ("engagement_date");
--> statement-breakpoint

-- Move the short-lived engagement records written before this migration out
-- of the immutable activity ledger. Rows with an intact version remain
-- detailed inside the 90-day window. A deterministic fallback hash keeps the
-- one-time copy idempotent without retaining a raw browser key.
INSERT INTO "quote_visible_engagement_events" (
  "id",
  "quote_id",
  "quote_version_id",
  "capability_id",
  "idempotency_key_hash",
  "visible_ms_bucket",
  "correlation_id",
  "occurred_at",
  "created_at"
)
SELECT
  event."id",
  event."quote_id",
  event."quote_version_id",
  NULL,
  CASE
    WHEN event."causation_id" ~ '^[0-9a-fA-F]{64}$'
      THEN lower(event."causation_id")
    ELSE md5(event."id"::text) || md5(event."id"::text || ':proposal-visible')
  END,
  CASE
    WHEN event."metadata" ->> 'visibleMsBucket' IN ('1-5s', '5-30s', '30s+')
      THEN event."metadata" ->> 'visibleMsBucket'
    ELSE '1-5s'
  END,
  event."correlation_id",
  event."occurred_at",
  GREATEST(event."created_at", event."occurred_at")
FROM "quote_activity_events" AS event
WHERE event."event_type" = 'proposal_visible'
  AND event."quote_version_id" IS NOT NULL
  AND event."occurred_at" >= transaction_timestamp() - interval '90 days'
ON CONFLICT ("quote_version_id", "idempotency_key_hash") DO NOTHING;
--> statement-breakpoint

-- Older records, plus any malformed historic row without an exact version,
-- become aggregate-only immediately. No quote, version, capability, token,
-- contact, network, or browser identifier is carried into this table.
INSERT INTO "quote_visible_engagement_daily" (
  "engagement_date",
  "visible_ms_bucket",
  "event_count",
  "first_occurred_at",
  "last_occurred_at"
)
SELECT
  (event."occurred_at" AT TIME ZONE 'UTC')::date,
  CASE
    WHEN event."metadata" ->> 'visibleMsBucket' IN ('1-5s', '5-30s', '30s+')
      THEN event."metadata" ->> 'visibleMsBucket'
    ELSE '1-5s'
  END,
  count(*)::bigint,
  min(event."occurred_at"),
  max(event."occurred_at")
FROM "quote_activity_events" AS event
WHERE event."event_type" = 'proposal_visible'
  AND (
    event."occurred_at" < transaction_timestamp() - interval '90 days'
    OR event."quote_version_id" IS NULL
  )
GROUP BY 1, 2
ON CONFLICT ("engagement_date", "visible_ms_bucket") DO UPDATE
SET "event_count" = "quote_visible_engagement_daily"."event_count" + EXCLUDED."event_count",
    "first_occurred_at" = LEAST("quote_visible_engagement_daily"."first_occurred_at", EXCLUDED."first_occurred_at"),
    "last_occurred_at" = GREATEST("quote_visible_engagement_daily"."last_occurred_at", EXCLUDED."last_occurred_at"),
    "updated_at" = transaction_timestamp();
--> statement-breakpoint

-- The source table rejects all updates/deletes by design. This tightly scoped
-- migration exception removes only the engagement rows that were classified
-- incorrectly; the immutable trigger is restored in the same migration.
DROP TRIGGER "quote_activity_events_immutable" ON "quote_activity_events";
--> statement-breakpoint

DELETE FROM "quote_activity_events"
WHERE "event_type" = 'proposal_visible';
--> statement-breakpoint

CREATE TRIGGER "quote_activity_events_immutable"
  BEFORE UPDATE OR DELETE ON "quote_activity_events"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_reject_evidence_mutation"();
--> statement-breakpoint

-- Capability revocation is the durable contact-deletion boundary. Reconcile
-- any contacts that were already soft-deleted before this invariant shipped.
UPDATE "quote_capabilities" AS capability
SET "status" = 'revoked',
    "revoked_at" = COALESCE(capability."revoked_at", transaction_timestamp()),
    "revocation_reason" = 'contact_inactive',
    "updated_at" = transaction_timestamp()
FROM "quotes" AS quote
INNER JOIN "contacts" AS contact
  ON contact."id" = quote."contact_id"
WHERE capability."quote_id" = quote."id"
  AND contact."deleted_at" IS NOT NULL
  AND capability."status" <> 'revoked';
--> statement-breakpoint

COMMENT ON TABLE "quote_visible_engagement_events" IS
  'Browser-confirmed Quote V2 visibility detail. Aggregate and delete after 90 days; never store raw capabilities, IPs, or user-agent strings.';
--> statement-breakpoint

COMMENT ON TABLE "quote_visible_engagement_daily" IS
  'Identifier-free daily Quote V2 visibility counts retained after detailed engagement is deleted.';
