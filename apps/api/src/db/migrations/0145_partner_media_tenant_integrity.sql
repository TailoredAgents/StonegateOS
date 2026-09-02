-- Partner media tenant integrity and durable finalization idempotency.
--
-- The preflight deliberately aborts on ambiguous or contradictory ownership.
-- A migration operator must quarantine and reconcile those records; this
-- migration never guesses a tenant or silently rewrites an association.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "partner_draft_media" association
    JOIN "partner_booking_drafts" draft
      ON draft."id" = association."booking_draft_id"
    WHERE association."partner_account_id" <> draft."partner_account_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partner media migration blocked: draft association tenant mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "partner_job_evidence" association
    JOIN "partner_bookings" booking
      ON booking."id" = association."partner_booking_id"
    WHERE association."partner_account_id" <> booking."partner_account_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partner media migration blocked: job evidence tenant mismatch';
  END IF;

  IF EXISTS (
    SELECT binding."media_asset_id"
    FROM (
      SELECT "media_asset_id", "partner_account_id" FROM "partner_draft_media"
      UNION ALL
      SELECT "media_asset_id", "partner_account_id" FROM "partner_job_evidence"
    ) binding
    GROUP BY binding."media_asset_id"
    HAVING count(DISTINCT binding."partner_account_id") > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partner media migration blocked: media asset is associated with multiple tenants';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "partner_draft_media" association
    JOIN "partner_account_memberships" membership
      ON membership."id" = association."uploaded_by_membership_id"
    WHERE association."uploaded_by_membership_id" IS NOT NULL
      AND association."partner_account_id" <> membership."partner_account_id"
  ) OR EXISTS (
    SELECT 1
    FROM "partner_job_evidence" association
    JOIN "partner_account_memberships" membership
      ON membership."id" = association."uploaded_by_membership_id"
    WHERE association."uploaded_by_membership_id" IS NOT NULL
      AND association."partner_account_id" <> membership."partner_account_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partner media migration blocked: uploader membership tenant mismatch';
  END IF;
END $$;

ALTER TABLE "media_assets"
  ADD COLUMN "partner_account_id" uuid;

ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id")
  ON DELETE RESTRICT;

WITH explicit_bindings AS (
  SELECT binding."media_asset_id", min(binding."partner_account_id"::text)::uuid AS "partner_account_id"
  FROM (
    SELECT "media_asset_id", "partner_account_id" FROM "partner_draft_media"
    UNION ALL
    SELECT "media_asset_id", "partner_account_id" FROM "partner_job_evidence"
  ) binding
  GROUP BY binding."media_asset_id"
)
UPDATE "media_assets" asset
SET "partner_account_id" = binding."partner_account_id"
FROM explicit_bindings binding
WHERE asset."id" = binding."media_asset_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "media_asset_id", "partner_account_id" FROM "partner_draft_media"
      UNION ALL
      SELECT "media_asset_id", "partner_account_id" FROM "partner_job_evidence"
    ) association
    JOIN "media_assets" asset ON asset."id" = association."media_asset_id"
    WHERE asset."partner_account_id" IS NULL
      OR asset."partner_account_id" <> association."partner_account_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partner media migration blocked: explicit asset binding could not be established';
  END IF;
END $$;

CREATE UNIQUE INDEX "media_assets_id_partner_account_key"
  ON "media_assets" ("id", "partner_account_id");

ALTER TABLE "partner_draft_media"
  ADD CONSTRAINT "partner_draft_media_asset_account_fk"
    FOREIGN KEY ("media_asset_id", "partner_account_id")
    REFERENCES "media_assets"("id", "partner_account_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_draft_media_uploader_account_fk"
    FOREIGN KEY ("uploaded_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT;

ALTER TABLE "partner_job_evidence"
  ADD CONSTRAINT "partner_job_evidence_asset_account_fk"
    FOREIGN KEY ("media_asset_id", "partner_account_id")
    REFERENCES "media_assets"("id", "partner_account_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_job_evidence_uploader_account_fk"
    FOREIGN KEY ("uploaded_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT;

CREATE TABLE "partner_media_mutation_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "actor_membership_id" uuid NOT NULL,
  "action" varchar(64) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "parent_kind" text NOT NULL,
  "parent_id" uuid NOT NULL,
  "association_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'in_progress',
  "claim_token" uuid NOT NULL,
  "claim_expires_at" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 1,
  "last_error_code" varchar(80),
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_media_mutation_operations_actor_account_fk"
    FOREIGN KEY ("actor_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_media_mutation_operations_action_check"
    CHECK ("action" IN ('finalize')),
  CONSTRAINT "partner_media_mutation_operations_parent_kind_check"
    CHECK ("parent_kind" IN ('draft', 'job')),
  CONSTRAINT "partner_media_mutation_operations_status_check"
    CHECK ("status" IN ('in_progress', 'succeeded', 'failed')),
  CONSTRAINT "partner_media_mutation_operations_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_media_mutation_operations_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_media_mutation_operations_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 1 AND 20),
  CONSTRAINT "partner_media_mutation_operations_completion_check"
    CHECK (
      ("status" = 'in_progress' AND "completed_at" IS NULL)
      OR ("status" <> 'in_progress' AND "completed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "partner_media_mutation_operations_actor_action_key"
  ON "partner_media_mutation_operations"
  ("partner_account_id", "actor_membership_id", "action", "idempotency_key_hash");
CREATE INDEX "partner_media_mutation_operations_claim_idx"
  ON "partner_media_mutation_operations" ("status", "claim_expires_at");
CREATE INDEX "partner_media_mutation_operations_association_idx"
  ON "partner_media_mutation_operations"
  ("partner_account_id", "parent_kind", "parent_id", "association_id", "created_at");
