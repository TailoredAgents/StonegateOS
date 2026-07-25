-- Payment ledger and Square POS foundation. Applied after the media release.
CREATE TABLE "payment_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "appointment_id" uuid NOT NULL,
  "provider" text DEFAULT 'square' NOT NULL,
  "client_request_id" text NOT NULL,
  "status" text DEFAULT 'created' NOT NULL,
  "requested_job_amount_cents" integer NOT NULL,
  "currency" varchar(10) DEFAULT 'USD' NOT NULL,
  "provider_order_id" text,
  "provider_payment_id" text,
  "square_location_id" text,
  "initiated_by_member_id" uuid,
  "return_nonce_hash" text,
  "return_state_expires_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_appointment_id_appointments_id_fk"
  FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_initiated_by_member_id_team_members_id_fk"
  FOREIGN KEY ("initiated_by_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "payment_attempts_client_request_key"
  ON "payment_attempts" USING btree ("client_request_id");
--> statement-breakpoint
CREATE INDEX "payment_attempts_appointment_idx"
  ON "payment_attempts" USING btree ("appointment_id", "created_at");
--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx"
  ON "payment_attempts" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "payment_attempts_expires_idx"
  ON "payment_attempts" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_order_idx"
  ON "payment_attempts" USING btree ("provider", "provider_order_id");
--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_payment_idx"
  ON "payment_attempts" USING btree ("provider", "provider_payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_active_square_appointment_key"
  ON "payment_attempts" USING btree ("appointment_id")
  WHERE "provider" = 'square'
    AND "status" IN ('created', 'launched', 'pending_verification');
--> statement-breakpoint

ALTER TABLE "payments"
  ALTER COLUMN "stripe_charge_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments"
  ADD COLUMN "provider" text DEFAULT 'stripe' NOT NULL,
  ADD COLUMN "provider_payment_id" text,
  ADD COLUMN "provider_order_id" text,
  ADD COLUMN "payment_attempt_id" uuid,
  ADD COLUMN "job_amount_cents" integer,
  ADD COLUMN "tip_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "total_amount_cents" integer,
  ADD COLUMN "refunded_amount_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "canonical_status" text,
  ADD COLUMN "provider_status" text,
  ADD COLUMN "tender_type" text,
  ADD COLUMN "entry_method" text,
  ADD COLUMN "square_location_id" text,
  ADD COLUMN "initiated_by_member_id" uuid,
  ADD COLUMN "legacy_source" text,
  ADD COLUMN "provider_created_at" timestamp with time zone,
  ADD COLUMN "paid_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_payment_attempt_id_payment_attempts_id_fk"
  FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_initiated_by_member_id_team_members_id_fk"
  FOREIGN KEY ("initiated_by_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

UPDATE "payments"
SET
  "provider" = 'stripe',
  "provider_payment_id" = COALESCE("provider_payment_id", "stripe_charge_id"),
  "total_amount_cents" = COALESCE("total_amount_cents", "amount"),
  "canonical_status" = COALESCE(
    "canonical_status",
    CASE
      WHEN "appointment_id" IS NULL THEN 'needs_review'
      WHEN lower("status") IN ('succeeded', 'paid', 'completed') THEN 'completed'
      WHEN lower("status") = 'refunded' THEN 'refunded'
      ELSE 'unknown'
    END
  ),
  "provider_status" = COALESCE("provider_status", "status"),
  "tender_type" = COALESCE("tender_type", "method"),
  "legacy_source" = COALESCE("legacy_source", 'stripe_import'),
  "provider_created_at" = COALESCE("provider_created_at", "created_at"),
  "paid_at" = COALESCE("paid_at", "captured_at", "created_at")
WHERE "stripe_charge_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "payments_provider_payment_key"
  ON "payments" USING btree ("provider", "provider_payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payment_attempt_key"
  ON "payments" USING btree ("payment_attempt_id");
--> statement-breakpoint
CREATE INDEX "payments_canonical_status_idx"
  ON "payments" USING btree ("canonical_status", "created_at");
--> statement-breakpoint
CREATE INDEX "payments_provider_order_idx"
  ON "payments" USING btree ("provider", "provider_order_id");
--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx"
  ON "payments" USING btree ("paid_at");
--> statement-breakpoint

-- Separate a historical appointment-level card tip only when it maps to one
-- successful matched Stripe charge. Ambiguous tip mappings stay reviewable.
WITH "matched_stripe" AS (
  SELECT
    "p"."id",
    "p"."amount",
    "a"."card_tip_cents",
    count(*) OVER (PARTITION BY "p"."appointment_id") AS "payment_count"
  FROM "payments" AS "p"
  INNER JOIN "appointments" AS "a"
    ON "a"."id" = "p"."appointment_id"
  WHERE "p"."provider" = 'stripe'
    AND "p"."canonical_status" = 'completed'
)
UPDATE "payments" AS "p"
SET
  "job_amount_cents" = CASE
    WHEN "m"."payment_count" = 1
      AND COALESCE("m"."card_tip_cents", 0) BETWEEN 0 AND "m"."amount"
      THEN "m"."amount" - COALESCE("m"."card_tip_cents", 0)
    WHEN COALESCE("m"."card_tip_cents", 0) = 0
      THEN "m"."amount"
    ELSE "p"."job_amount_cents"
  END,
  "tip_cents" = CASE
    WHEN "m"."payment_count" = 1
      AND COALESCE("m"."card_tip_cents", 0) BETWEEN 0 AND "m"."amount"
      THEN COALESCE("m"."card_tip_cents", 0)
    ELSE "p"."tip_cents"
  END,
  "canonical_status" = CASE
    WHEN COALESCE("m"."card_tip_cents", 0) < 0
      OR COALESCE("m"."card_tip_cents", 0) > "m"."amount"
      OR (
        "m"."payment_count" > 1
        AND COALESCE("m"."card_tip_cents", 0) > 0
      )
      THEN 'needs_review'
    ELSE "p"."canonical_status"
  END
FROM "matched_stripe" AS "m"
WHERE "p"."id" = "m"."id";
--> statement-breakpoint

-- An aggregate above the agreed final job total is not guessed at. Preserve
-- the provider rows and send the appointment to owner reconciliation.
WITH "overpaid_appointments" AS (
  SELECT "p"."appointment_id"
  FROM "payments" AS "p"
  INNER JOIN "appointments" AS "a"
    ON "a"."id" = "p"."appointment_id"
  WHERE "p"."canonical_status" = 'completed'
    AND "a"."final_total_cents" IS NOT NULL
  GROUP BY "p"."appointment_id", "a"."final_total_cents"
  HAVING sum(COALESCE("p"."job_amount_cents", "p"."amount")) >
    "a"."final_total_cents"
)
UPDATE "payments" AS "p"
SET "canonical_status" = 'needs_review'
FROM "overpaid_appointments" AS "o"
WHERE "p"."appointment_id" = "o"."appointment_id"
  AND "p"."canonical_status" = 'completed';
--> statement-breakpoint

-- Before this ledger existed, a completed appointment's final total represented
-- money received. Add only the uncovered remainder, retaining a stable provider
-- ID so this backfill is idempotent.
WITH "historical_coverage" AS (
  SELECT
    "a"."id" AS "appointment_id",
    "a"."final_total_cents",
    COALESCE(
      sum("p"."job_amount_cents")
        FILTER (WHERE "p"."canonical_status" = 'completed'),
      0
    )::integer AS "covered_job_cents",
    count("p"."id")
      FILTER (WHERE "p"."canonical_status" = 'completed')::integer
      AS "completed_payment_count",
    bool_or("p"."canonical_status" = 'needs_review') AS "has_review_item",
    COALESCE("a"."card_tip_cents", 0) AS "legacy_tip_cents",
    COALESCE("a"."completed_at", "a"."updated_at", "a"."created_at", now())
      AS "paid_at"
  FROM "appointments" AS "a"
  LEFT JOIN "payments" AS "p"
    ON "p"."appointment_id" = "a"."id"
  WHERE "a"."status" = 'completed'
    AND "a"."final_total_cents" IS NOT NULL
    AND "a"."final_total_cents" >= 0
  GROUP BY
    "a"."id",
    "a"."final_total_cents",
    "a"."card_tip_cents",
    "a"."completed_at",
    "a"."updated_at",
    "a"."created_at"
),
"legacy_rows" AS (
  SELECT
    "appointment_id",
    "final_total_cents" - "covered_job_cents" AS "job_amount_cents",
    CASE
      WHEN "completed_payment_count" = 0 AND "legacy_tip_cents" > 0
        THEN "legacy_tip_cents"
      ELSE 0
    END AS "tip_cents",
    "paid_at"
  FROM "historical_coverage"
  WHERE "final_total_cents" - "covered_job_cents" > 0
    AND COALESCE("has_review_item", false) = false
)
INSERT INTO "payments" (
  "provider",
  "provider_payment_id",
  "amount",
  "job_amount_cents",
  "tip_cents",
  "total_amount_cents",
  "refunded_amount_cents",
  "currency",
  "status",
  "canonical_status",
  "provider_status",
  "method",
  "tender_type",
  "entry_method",
  "legacy_source",
  "appointment_id",
  "created_at",
  "updated_at",
  "provider_created_at",
  "paid_at",
  "captured_at"
)
SELECT
  'legacy',
  'legacy_completion:' || "appointment_id"::text,
  "job_amount_cents" + "tip_cents",
  "job_amount_cents",
  "tip_cents",
  "job_amount_cents" + "tip_cents",
  0,
  'USD',
  'completed',
  'completed',
  'completed',
  CASE WHEN "tip_cents" > 0 THEN 'card' ELSE 'legacy' END,
  CASE WHEN "tip_cents" > 0 THEN 'card' ELSE 'legacy' END,
  'legacy',
  'legacy_completion',
  "appointment_id",
  "paid_at",
  "paid_at",
  "paid_at",
  "paid_at",
  "paid_at"
FROM "legacy_rows"
ON CONFLICT ("provider", "provider_payment_id") DO NOTHING;
--> statement-breakpoint

CREATE TABLE "payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_refund_id" text,
  "amount_cents" integer NOT NULL,
  "job_amount_cents" integer DEFAULT 0 NOT NULL,
  "tip_cents" integer DEFAULT 0 NOT NULL,
  "currency" varchar(10) DEFAULT 'USD' NOT NULL,
  "canonical_status" text NOT NULL,
  "provider_status" text,
  "reason" text,
  "metadata" jsonb,
  "provider_created_at" timestamp with time zone,
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "payment_refunds_provider_refund_key"
  ON "payment_refunds" USING btree ("provider", "provider_refund_id");
--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_idx"
  ON "payment_refunds" USING btree ("payment_id", "created_at");
--> statement-breakpoint
CREATE INDEX "payment_refunds_status_idx"
  ON "payment_refunds" USING btree ("canonical_status", "created_at");
--> statement-breakpoint

CREATE TABLE "payment_provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "processing_status" text DEFAULT 'received' NOT NULL,
  "payment_id" uuid,
  "payment_attempt_id" uuid,
  "payload" jsonb,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "error" text
);
--> statement-breakpoint

ALTER TABLE "payment_provider_events"
  ADD CONSTRAINT "payment_provider_events_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_provider_events"
  ADD CONSTRAINT "payment_provider_events_payment_attempt_id_payment_attempts_id_fk"
  FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "payment_provider_events_provider_event_key"
  ON "payment_provider_events" USING btree ("provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX "payment_provider_events_status_idx"
  ON "payment_provider_events" USING btree ("processing_status", "received_at");
--> statement-breakpoint
CREATE INDEX "payment_provider_events_payment_idx"
  ON "payment_provider_events" USING btree ("payment_id");
--> statement-breakpoint
CREATE INDEX "payment_provider_events_attempt_idx"
  ON "payment_provider_events" USING btree ("payment_attempt_id");
