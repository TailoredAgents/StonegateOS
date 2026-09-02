-- Provider-backed address verification, office-review evidence, and a
-- recoverable duplicate-location merge. A merge retires the duplicate while
-- preserving the source row and every historical foreign key; it never
-- rewrites completed jobs, quotes, documents, or financial evidence.

ALTER TABLE "partner_account_locations"
  ADD COLUMN "address_verification_status" text DEFAULT 'review_required' NOT NULL,
  ADD COLUMN "address_verification_provider" text DEFAULT 'none' NOT NULL,
  ADD COLUMN "address_verification_confidence" integer,
  ADD COLUMN "address_verification_feature_id" text,
  ADD COLUMN "address_verification_suggestion" jsonb,
  ADD COLUMN "address_verified_at" timestamptz,
  ADD COLUMN "merged_into_location_id" uuid,
  ADD COLUMN "merged_at" timestamptz,
  ADD COLUMN "merged_by_membership_id" uuid,
  ADD COLUMN "merge_reason" text;

UPDATE "partner_account_locations"
SET
  "address_verification_status" = CASE
    WHEN "geocode_status" = 'verified'
      AND "latitude" IS NOT NULL
      AND "longitude" IS NOT NULL
      THEN 'verified'
    ELSE 'review_required'
  END,
  "address_verification_provider" = CASE
    WHEN "geocode_status" = 'verified' THEN 'legacy'
    WHEN "geocode_status" = 'manual' THEN 'manual'
    ELSE 'none'
  END,
  "address_verified_at" = CASE
    WHEN "geocode_status" IN ('verified', 'manual') THEN "updated_at"
    ELSE NULL
  END;

ALTER TABLE "partner_account_locations"
  ADD CONSTRAINT "partner_account_locations_verification_status_check"
    CHECK (
      "address_verification_status" IN (
        'verified',
        'suggested_correction',
        'review_required',
        'staff_verified'
      )
    ),
  ADD CONSTRAINT "partner_account_locations_verification_provider_check"
    CHECK (
      "address_verification_provider" IN ('mapbox', 'manual', 'legacy', 'none')
    ),
  ADD CONSTRAINT "partner_account_locations_verification_confidence_check"
    CHECK (
      "address_verification_confidence" IS NULL
      OR "address_verification_confidence" BETWEEN 0 AND 100
    ),
  ADD CONSTRAINT "partner_account_locations_verification_evidence_check"
    CHECK (
      (
        "address_verification_status" IN ('verified', 'staff_verified')
        AND "address_verified_at" IS NOT NULL
      )
      OR (
        "address_verification_status" IN ('suggested_correction', 'review_required')
        AND "address_verified_at" IS NULL
      )
    ),
  ADD CONSTRAINT "partner_account_locations_suggestion_shape_check"
    CHECK (
      "address_verification_suggestion" IS NULL
      OR jsonb_typeof("address_verification_suggestion") = 'object'
    ),
  ADD CONSTRAINT "partner_account_locations_merge_state_check"
    CHECK (
      (
        "merged_into_location_id" IS NULL
        AND "merged_at" IS NULL
        AND "merged_by_membership_id" IS NULL
        AND "merge_reason" IS NULL
      )
      OR (
        "merged_into_location_id" IS NOT NULL
        AND "merged_into_location_id" <> "id"
        AND "merged_at" IS NOT NULL
        AND "merged_by_membership_id" IS NOT NULL
        AND length(btrim("merge_reason")) BETWEEN 5 AND 500
        AND "active" IS FALSE
      )
    ),
  ADD CONSTRAINT "partner_account_locations_merge_account_fk"
    FOREIGN KEY ("partner_account_id", "merged_into_location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "partner_account_locations_merge_actor_account_fk"
    FOREIGN KEY ("merged_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT;

CREATE INDEX "partner_account_locations_verification_queue_idx"
  ON "partner_account_locations" (
    "address_verification_status",
    "partner_account_id",
    "updated_at",
    "id"
  )
  WHERE "active" IS TRUE
    AND "address_verification_status" IN ('suggested_correction', 'review_required');

CREATE INDEX "partner_account_locations_merged_into_idx"
  ON "partner_account_locations" (
    "partner_account_id",
    "merged_into_location_id",
    "merged_at",
    "id"
  )
  WHERE "merged_into_location_id" IS NOT NULL;

CREATE TABLE "partner_location_address_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "requested_by_membership_id" uuid NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "reason_code" text NOT NULL,
  "entered_address" jsonb NOT NULL,
  "provider_suggestion" jsonb,
  "provider_confidence" integer,
  "duplicate_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reviewed_by_team_member_id" uuid,
  "resolution_note" text,
  "resolved_at" timestamptz,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_location_address_reviews_account_fk"
    FOREIGN KEY ("partner_account_id")
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_location_address_reviews_location_account_fk"
    FOREIGN KEY ("partner_account_id", "location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_location_address_reviews_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_location_address_reviews_reviewer_fk"
    FOREIGN KEY ("reviewed_by_team_member_id")
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_location_address_reviews_state_check"
    CHECK ("state" IN ('pending', 'verified', 'correction_required', 'dismissed')),
  CONSTRAINT "partner_location_address_reviews_reason_check"
    CHECK (
      "reason_code" IN (
        'provider_unavailable',
        'low_confidence',
        'suggested_correction',
        'possible_duplicate',
        'partner_requested'
      )
    ),
  CONSTRAINT "partner_location_address_reviews_json_check"
    CHECK (
      jsonb_typeof("entered_address") = 'object'
      AND (
        "provider_suggestion" IS NULL
        OR jsonb_typeof("provider_suggestion") = 'object'
      )
      AND jsonb_typeof("duplicate_candidates") = 'array'
      AND jsonb_array_length("duplicate_candidates") <= 20
    ),
  CONSTRAINT "partner_location_address_reviews_confidence_check"
    CHECK (
      "provider_confidence" IS NULL
      OR "provider_confidence" BETWEEN 0 AND 100
    ),
  CONSTRAINT "partner_location_address_reviews_lifecycle_check"
    CHECK (
      (
        "state" = 'pending'
        AND "reviewed_by_team_member_id" IS NULL
        AND "resolution_note" IS NULL
        AND "resolved_at" IS NULL
      )
      OR (
        "state" <> 'pending'
        AND "reviewed_by_team_member_id" IS NOT NULL
        AND length(btrim("resolution_note")) BETWEEN 5 AND 1000
        AND "resolved_at" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_location_address_reviews_version_check"
    CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "partner_location_address_reviews_open_location_key"
  ON "partner_location_address_reviews" ("partner_account_id", "location_id")
  WHERE "state" = 'pending';

CREATE INDEX "partner_location_address_reviews_queue_idx"
  ON "partner_location_address_reviews" (
    "state",
    "created_at",
    "id"
  );

CREATE INDEX "partner_location_address_reviews_account_idx"
  ON "partner_location_address_reviews" (
    "partner_account_id",
    "state",
    "created_at",
    "id"
  );
