-- Safe, additive persistence for repeat work. Existing portal rows remain
-- valid; no appointment or hold is created by this migration.

ALTER TABLE "partner_service_templates"
  ADD COLUMN "create_operation_key_hash" varchar(64),
  ADD COLUMN "create_request_hash" varchar(64),
  ADD CONSTRAINT "partner_service_templates_create_operation_hash_check"
    CHECK (
      "create_operation_key_hash" IS NULL
      OR "create_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_service_templates_create_request_hash_check"
    CHECK (
      "create_request_hash" IS NULL
      OR "create_request_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_service_templates_create_hash_pair_check"
    CHECK (
      ("create_operation_key_hash" IS NULL)
      = ("create_request_hash" IS NULL)
    );

CREATE UNIQUE INDEX "partner_service_templates_account_template_key"
  ON "partner_service_templates" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_service_templates_create_operation_key_hash_key"
  ON "partner_service_templates" ("create_operation_key_hash")
  WHERE "create_operation_key_hash" IS NOT NULL;

ALTER TABLE "partner_service_templates"
  ADD CONSTRAINT "partner_service_templates_location_account_fk"
    FOREIGN KEY ("partner_account_id", "location_id")
    REFERENCES "partner_account_locations" ("partner_account_id", "id")
    ON DELETE SET NULL ("location_id"),
  ADD CONSTRAINT "partner_service_templates_creator_account_fk"
    FOREIGN KEY ("created_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships" ("id", "partner_account_id")
    ON DELETE SET NULL ("created_by_membership_id");

ALTER TABLE "partner_recurring_series"
  ADD COLUMN "preferred_window_start" varchar(5),
  ADD COLUMN "create_operation_key_hash" varchar(64),
  ADD COLUMN "create_request_hash" varchar(64),
  ADD CONSTRAINT "partner_recurring_series_preferred_window_start_check"
    CHECK (
      "preferred_window_start" IS NULL
      OR "preferred_window_start" ~ '^([01][0-9]|2[0-3]):(00|30)$'
    ),
  ADD CONSTRAINT "partner_recurring_series_create_operation_hash_check"
    CHECK (
      "create_operation_key_hash" IS NULL
      OR "create_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_recurring_series_create_request_hash_check"
    CHECK (
      "create_request_hash" IS NULL
      OR "create_request_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_recurring_series_create_hash_pair_check"
    CHECK (
      ("create_operation_key_hash" IS NULL)
      = ("create_request_hash" IS NULL)
    );

CREATE UNIQUE INDEX "partner_recurring_series_account_series_key"
  ON "partner_recurring_series" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_recurring_series_create_operation_key_hash_key"
  ON "partner_recurring_series" ("create_operation_key_hash")
  WHERE "create_operation_key_hash" IS NOT NULL;

ALTER TABLE "partner_recurring_series"
  ADD CONSTRAINT "partner_recurring_series_template_account_fk"
    FOREIGN KEY ("partner_account_id", "template_id")
    REFERENCES "partner_service_templates" ("partner_account_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_recurring_series_creator_account_fk"
    FOREIGN KEY ("created_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships" ("id", "partner_account_id")
    ON DELETE RESTRICT;

ALTER TABLE "partner_recurring_occurrences"
  ADD COLUMN "booking_draft_id" uuid,
  ADD COLUMN "evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "partner_recurring_occurrences"
  ADD CONSTRAINT "partner_recurring_occurrences_series_account_fk"
    FOREIGN KEY ("partner_account_id", "recurring_series_id")
    REFERENCES "partner_recurring_series" ("partner_account_id", "id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "partner_recurring_occurrences_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings" ("partner_account_id", "id")
    ON DELETE SET NULL ("partner_booking_id"),
  ADD CONSTRAINT "partner_recurring_occurrences_draft_account_fk"
    FOREIGN KEY ("partner_account_id", "booking_draft_id")
    REFERENCES "partner_booking_drafts" ("partner_account_id", "id")
    ON DELETE SET NULL ("booking_draft_id");

ALTER TABLE "partner_bulk_imports"
  ADD COLUMN "create_operation_key_hash" varchar(64),
  ADD COLUMN "create_request_hash" varchar(64),
  ADD COLUMN "updated_at" timestamptz DEFAULT now() NOT NULL,
  ADD CONSTRAINT "partner_bulk_imports_create_operation_hash_check"
    CHECK (
      "create_operation_key_hash" IS NULL
      OR "create_operation_key_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_bulk_imports_create_request_hash_check"
    CHECK (
      "create_request_hash" IS NULL
      OR "create_request_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "partner_bulk_imports_create_hash_pair_check"
    CHECK (
      ("create_operation_key_hash" IS NULL)
      = ("create_request_hash" IS NULL)
    );

CREATE UNIQUE INDEX "partner_bulk_imports_account_import_key"
  ON "partner_bulk_imports" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_bulk_imports_create_operation_key_hash_key"
  ON "partner_bulk_imports" ("create_operation_key_hash")
  WHERE "create_operation_key_hash" IS NOT NULL;

ALTER TABLE "partner_bulk_imports"
  ADD CONSTRAINT "partner_bulk_imports_creator_account_fk"
    FOREIGN KEY ("created_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships" ("id", "partner_account_id")
    ON DELETE RESTRICT;

ALTER TABLE "partner_bulk_import_rows"
  ADD COLUMN "partner_account_id" uuid;

UPDATE "partner_bulk_import_rows" AS row
SET "partner_account_id" = import."partner_account_id"
FROM "partner_bulk_imports" AS import
WHERE row."partner_bulk_import_id" = import."id";

ALTER TABLE "partner_bulk_import_rows"
  ALTER COLUMN "partner_account_id" SET NOT NULL,
  ADD COLUMN "booking_draft_id" uuid,
  ADD CONSTRAINT "partner_bulk_import_rows_account_fk"
    FOREIGN KEY ("partner_account_id")
    REFERENCES "partner_accounts" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_bulk_import_rows_import_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_bulk_import_id")
    REFERENCES "partner_bulk_imports" ("partner_account_id", "id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "partner_bulk_import_rows_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings" ("partner_account_id", "id")
    ON DELETE SET NULL ("partner_booking_id"),
  ADD CONSTRAINT "partner_bulk_import_rows_draft_account_fk"
    FOREIGN KEY ("partner_account_id", "booking_draft_id")
    REFERENCES "partner_booking_drafts" ("partner_account_id", "id")
    ON DELETE SET NULL ("booking_draft_id");
