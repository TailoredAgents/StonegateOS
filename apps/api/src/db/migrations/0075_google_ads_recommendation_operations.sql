ALTER TABLE "google_ads_analyst_recommendations"
  ADD CONSTRAINT "google_ads_analyst_recommendations_status_check"
  CHECK (
    "status" IN (
      'proposed',
      'approved',
      'ignored',
      'applying',
      'applied',
      'failed',
      'reconciliation_required'
    )
  ) NOT VALID;

ALTER TABLE "google_ads_analyst_recommendations"
  VALIDATE CONSTRAINT "google_ads_analyst_recommendations_status_check";

CREATE TABLE IF NOT EXISTS "google_ads_recommendation_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recommendation_id" uuid NOT NULL,
  "parent_operation_id" uuid NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "expected_version" varchar(200) NOT NULL,
  "actor_member_id" uuid NOT NULL,
  "actor_label" text,
  "state" text DEFAULT 'requested' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "provider" text DEFAULT 'google_ads' NOT NULL,
  "provider_request_key" uuid NOT NULL,
  "provider_operation_id" text,
  "terminal_audit_event_id" uuid,
  "provider_idempotency_supported" boolean DEFAULT false NOT NULL,
  "term" text NOT NULL,
  "match_type" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "reconciliation_required_at" timestamp with time zone,
  "provider_status" integer,
  "failure_code" text,
  "failure_detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_ads_rec_operations_recommendation_fk"
    FOREIGN KEY ("recommendation_id")
    REFERENCES "google_ads_analyst_recommendations"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "google_ads_rec_operations_terminal_audit_event_fk"
    FOREIGN KEY ("terminal_audit_event_id")
    REFERENCES "audit_logs"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "google_ads_rec_operations_state_check"
    CHECK (
      "state" IN (
        'requested',
        'dispatched',
        'succeeded',
        'failed',
        'reconciliation_required'
      )
    ),
  CONSTRAINT "google_ads_rec_operations_version_check"
    CHECK ("version" > 0),
  CONSTRAINT "google_ads_rec_operations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "google_ads_rec_operations_expected_version_check"
    CHECK (length("expected_version") BETWEEN 1 AND 200),
  CONSTRAINT "google_ads_rec_operations_match_type_check"
    CHECK ("match_type" IN ('BROAD', 'PHRASE', 'EXACT')),
  CONSTRAINT "google_ads_rec_operations_provider_status_check"
    CHECK ("provider_status" IS NULL OR "provider_status" BETWEEN 100 AND 599),
  CONSTRAINT "google_ads_rec_operations_provider_check"
    CHECK (
      "provider" = 'google_ads'
      AND "provider_idempotency_supported" = false
    ),
  CONSTRAINT "google_ads_rec_operations_term_check"
    CHECK (length(trim("term")) BETWEEN 1 AND 80),
  CONSTRAINT "google_ads_rec_operations_lifecycle_check"
    CHECK (
      (
        "state" = 'requested'
        AND "dispatched_at" IS NULL
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "provider_status" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
      ) OR (
        "state" = 'dispatched'
        AND "dispatched_at" IS NOT NULL
        AND "dispatched_at" >= "requested_at"
        AND "completed_at" IS NULL
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NULL
        AND "terminal_audit_event_id" IS NULL
        AND "provider_status" IS NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
      ) OR (
        "state" = 'succeeded'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NULL
        AND "provider_operation_id" IS NOT NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NULL
        AND "failure_detail" IS NULL
      ) OR (
        "state" = 'failed'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NULL
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
      ) OR (
        "state" = 'reconciliation_required'
        AND "dispatched_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "completed_at" >= "dispatched_at"
        AND "reconciliation_required_at" IS NOT NULL
        AND "reconciliation_required_at" >= "dispatched_at"
        AND "terminal_audit_event_id" IS NOT NULL
        AND "failure_code" IS NOT NULL
        AND "failure_detail" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_parent_recommendation_key"
  ON "google_ads_recommendation_operations" ("parent_operation_id", "recommendation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_actor_request_recommendation_key"
  ON "google_ads_recommendation_operations" (
    "actor_member_id",
    "idempotency_key_hash",
    "recommendation_id"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_active_recommendation_key"
  ON "google_ads_recommendation_operations" ("recommendation_id")
  WHERE "state" IN ('requested', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_provider_operation_key"
  ON "google_ads_recommendation_operations" ("provider_operation_id")
  WHERE "provider_operation_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_provider_request_key"
  ON "google_ads_recommendation_operations" ("provider_request_key");

CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_rec_operations_terminal_audit_event_key"
  ON "google_ads_recommendation_operations" ("terminal_audit_event_id")
  WHERE "terminal_audit_event_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "google_ads_rec_operations_state_updated_idx"
  ON "google_ads_recommendation_operations" ("state", "updated_at");

CREATE INDEX IF NOT EXISTS "google_ads_rec_operations_recommendation_created_idx"
  ON "google_ads_recommendation_operations" (
    "recommendation_id",
    "created_at",
    "id"
  );

CREATE OR REPLACE FUNCTION enforce_google_ads_recommendation_operation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'requested'
       OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'google_ads_recommendation_operation_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."recommendation_id" IS DISTINCT FROM OLD."recommendation_id"
     OR NEW."parent_operation_id" IS DISTINCT FROM OLD."parent_operation_id"
     OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
     OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
     OR NEW."expected_version" IS DISTINCT FROM OLD."expected_version"
     OR NEW."actor_member_id" IS DISTINCT FROM OLD."actor_member_id"
     OR NEW."actor_label" IS DISTINCT FROM OLD."actor_label"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."provider_request_key" IS DISTINCT FROM OLD."provider_request_key"
     OR NEW."provider_idempotency_supported" IS DISTINCT FROM OLD."provider_idempotency_supported"
     OR NEW."term" IS DISTINCT FROM OLD."term"
     OR NEW."match_type" IS DISTINCT FROM OLD."match_type"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'google_ads_recommendation_operation_identity_immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'google_ads_recommendation_operation_version_must_increment';
  END IF;

  IF OLD."state" IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'google_ads_recommendation_operation_terminal_immutable';
  END IF;

  IF OLD."state" = 'requested'
     AND NEW."state" <> 'dispatched' THEN
    RAISE EXCEPTION 'google_ads_recommendation_operation_invalid_requested_transition';
  END IF;

  IF OLD."state" = 'dispatched'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'google_ads_recommendation_operation_invalid_dispatched_transition';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "google_ads_recommendation_operation_transition"
  ON "google_ads_recommendation_operations";
CREATE TRIGGER "google_ads_recommendation_operation_transition"
BEFORE INSERT OR UPDATE ON "google_ads_recommendation_operations"
FOR EACH ROW
EXECUTE FUNCTION enforce_google_ads_recommendation_operation_transition();

COMMENT ON COLUMN "google_ads_recommendation_operations"."provider_request_key" IS
  'Stable Stonegate evidence key. Google Ads does not promise deduplication or exactly-once delivery for this mutation.';
COMMENT ON COLUMN "google_ads_recommendation_operations"."provider_idempotency_supported" IS
  'False for this Google Ads mutation. A dispatched operation is never automatically sent again.';
COMMENT ON COLUMN "google_ads_recommendation_operations"."reconciliation_required_at" IS
  'Set when delivery may have occurred but success cannot be proved. Operators must reconcile before another apply.';
COMMENT ON COLUMN "google_ads_recommendation_operations"."actor_member_id" IS
  'Immutable verified actor snapshot; intentionally not a mutable foreign key.';
