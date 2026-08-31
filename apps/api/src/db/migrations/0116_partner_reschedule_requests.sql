ALTER TABLE "partner_bookings"
  ADD COLUMN "reschedule_operation_key_hash" varchar(64),
  ADD COLUMN "reschedule_request_hash" varchar(64);

ALTER TABLE "partner_bookings"
  ADD CONSTRAINT "partner_bookings_reschedule_operation_key_hash_check"
    CHECK (
      "reschedule_operation_key_hash" IS NULL
      OR "reschedule_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_bookings_reschedule_request_hash_check"
    CHECK (
      "reschedule_request_hash" IS NULL
      OR "reschedule_request_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_bookings_reschedule_operation_pair_check"
    CHECK (
      ("reschedule_operation_key_hash" IS NULL)
      = ("reschedule_request_hash" IS NULL)
    );

CREATE UNIQUE INDEX "partner_bookings_reschedule_operation_key_hash_key"
  ON "partner_bookings" ("reschedule_operation_key_hash")
  WHERE "reschedule_operation_key_hash" IS NOT NULL;

ALTER TABLE "partner_booking_drafts"
  ADD COLUMN "reschedule_from_partner_booking_id" uuid;

ALTER TABLE "partner_booking_drafts"
  ADD CONSTRAINT "partner_booking_drafts_reschedule_account_fk"
    FOREIGN KEY ("partner_account_id", "reschedule_from_partner_booking_id")
    REFERENCES "partner_bookings" ("partner_account_id", "id")
    ON DELETE CASCADE;

CREATE UNIQUE INDEX "partner_booking_drafts_active_reschedule_key"
  ON "partner_booking_drafts" (
    "partner_account_id",
    "reschedule_from_partner_booking_id"
  )
  WHERE
    "reschedule_from_partner_booking_id" IS NOT NULL
    AND "state" IN ('draft', 'ready');

CREATE UNIQUE INDEX IF NOT EXISTS "partner_account_memberships_id_account_key"
  ON "partner_account_memberships" ("id", "partner_account_id");

CREATE TABLE "partner_reschedule_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts" ("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL,
  "booking_draft_id" uuid NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "proposed_start_at" timestamp with time zone NOT NULL,
  "requested_arrival_start_at" timestamp with time zone NOT NULL,
  "requested_arrival_end_at" timestamp with time zone NOT NULL,
  "previous_start_at" timestamp with time zone NOT NULL,
  "previous_arrival_start_at" timestamp with time zone,
  "previous_arrival_end_at" timestamp with time zone,
  "review_reasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "operation_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "created_by_membership_id" uuid NOT NULL,
  "resolved_by_team_member_id" uuid
    REFERENCES "team_members" ("id") ON DELETE SET NULL,
  "resolution_reason" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_reschedule_requests_state_check"
    CHECK (
      "state" IN (
        'pending',
        'accepted',
        'declined',
        'withdrawn',
        'superseded'
      )
    ),
  CONSTRAINT "partner_reschedule_requests_window_check"
    CHECK ("requested_arrival_end_at" > "requested_arrival_start_at"),
  CONSTRAINT "partner_reschedule_requests_previous_window_check"
    CHECK (
      (
        "previous_arrival_start_at" IS NULL
        AND "previous_arrival_end_at" IS NULL
      )
      OR (
        "previous_arrival_start_at" IS NOT NULL
        AND "previous_arrival_end_at" > "previous_arrival_start_at"
      )
    ),
  CONSTRAINT "partner_reschedule_requests_operation_hash_check"
    CHECK ("operation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_reschedule_requests_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_reschedule_requests_resolution_check"
    CHECK (
      (
        "state" = 'pending'
        AND "resolved_at" IS NULL
        AND "resolved_by_team_member_id" IS NULL
        AND "resolution_reason" IS NULL
      )
      OR (
        "state" <> 'pending'
        AND "resolved_at" IS NOT NULL
        AND "resolution_reason" IS NOT NULL
      )
    ),
  CONSTRAINT "partner_reschedule_requests_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings" ("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_reschedule_requests_draft_account_fk"
    FOREIGN KEY ("partner_account_id", "booking_draft_id")
    REFERENCES "partner_booking_drafts" ("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_reschedule_requests_creator_account_fk"
    FOREIGN KEY (
      "created_by_membership_id",
      "partner_account_id"
    )
    REFERENCES "partner_account_memberships" ("id", "partner_account_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "partner_reschedule_requests_account_request_key"
  ON "partner_reschedule_requests" ("partner_account_id", "id");

CREATE UNIQUE INDEX "partner_reschedule_requests_operation_key_hash_key"
  ON "partner_reschedule_requests" ("operation_key_hash");

CREATE UNIQUE INDEX "partner_reschedule_requests_pending_booking_key"
  ON "partner_reschedule_requests" ("partner_account_id", "partner_booking_id")
  WHERE "state" = 'pending';

CREATE INDEX "partner_reschedule_requests_account_state_idx"
  ON "partner_reschedule_requests" (
    "partner_account_id",
    "state",
    "created_at",
    "id"
  );
