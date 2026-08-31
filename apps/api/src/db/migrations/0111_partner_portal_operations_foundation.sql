-- Partner Portal V2 expand migration. All changes are additive or
-- compatibility-preserving; legacy contact-owned readers remain valid.

ALTER TABLE "conversation_threads"
  ADD COLUMN "partner_account_id" uuid,
  ADD COLUMN "partner_booking_id" uuid,
  ADD COLUMN "portal_visible" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_threads"
  ADD CONSTRAINT "conversation_threads_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "conversation_threads"
  ADD CONSTRAINT "conversation_threads_partner_booking_id_partner_bookings_id_fk"
  FOREIGN KEY ("partner_booking_id") REFERENCES "partner_bookings"("id") ON DELETE SET NULL;
CREATE INDEX "conversation_threads_partner_account_idx"
  ON "conversation_threads" ("partner_account_id", "portal_visible", "last_message_at");
CREATE UNIQUE INDEX "conversation_threads_portal_job_thread_key"
  ON "conversation_threads" ("partner_account_id", "partner_booking_id")
  WHERE "partner_account_id" IS NOT NULL AND "partner_booking_id" IS NOT NULL AND "portal_visible" = true;

ALTER TABLE "conversation_participants"
  ADD COLUMN "partner_membership_id" uuid;
ALTER TABLE "conversation_participants"
  ADD CONSTRAINT "conversation_participants_partner_membership_id_partner_account_memberships_id_fk"
  FOREIGN KEY ("partner_membership_id") REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL;
CREATE INDEX "conversation_participants_partner_membership_idx"
  ON "conversation_participants" ("partner_membership_id");

ALTER TABLE "conversation_messages"
  ADD COLUMN "portal_visible" boolean DEFAULT false NOT NULL,
  ADD COLUMN "author_type" text DEFAULT 'staff' NOT NULL,
  ADD COLUMN "idempotency_key_hash" varchar(64);
ALTER TABLE "conversation_messages"
  ADD CONSTRAINT "conversation_messages_author_type_check"
  CHECK ("author_type" IN ('partner', 'staff', 'system', 'provider'));
ALTER TABLE "conversation_messages"
  ADD CONSTRAINT "conversation_messages_idempotency_hash_check"
  CHECK ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$');
CREATE INDEX "conversation_messages_portal_history_idx"
  ON "conversation_messages" ("thread_id", "portal_visible", "created_at", "id");
CREATE UNIQUE INDEX "conversation_messages_idempotency_key"
  ON "conversation_messages" ("thread_id", "idempotency_key_hash")
  WHERE "idempotency_key_hash" IS NOT NULL;

ALTER TABLE "partner_rate_cards"
  ADD COLUMN "partner_account_id" uuid,
  ADD COLUMN "version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "effective_from" timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN "effective_to" timestamptz;
ALTER TABLE "partner_rate_cards"
  ADD CONSTRAINT "partner_rate_cards_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "partner_rate_cards"
  ADD CONSTRAINT "partner_rate_cards_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "partner_rate_cards_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
CREATE UNIQUE INDEX "partner_rate_cards_account_version_key"
  ON "partner_rate_cards" ("partner_account_id", "version") WHERE "partner_account_id" IS NOT NULL;
CREATE INDEX "partner_rate_cards_account_effective_idx"
  ON "partner_rate_cards" ("partner_account_id", "active", "effective_from", "effective_to");
CREATE UNIQUE INDEX "partner_rate_items_card_service_tier_key"
  ON "partner_rate_items" ("rate_card_id", "service_key", "tier_key");
ALTER TABLE "partner_rate_items"
  ADD CONSTRAINT "partner_rate_items_amount_check" CHECK ("amount_cents" >= 0);

ALTER TABLE "appointments"
  ADD COLUMN "partner_account_id" uuid,
  ADD COLUMN "capacity_pool_key" varchar(64) DEFAULT 'field_service' NOT NULL,
  ADD COLUMN "capacity_units" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "promised_arrival_start_at" timestamptz,
  ADD COLUMN "promised_arrival_end_at" timestamptz,
  ADD COLUMN "schedule_policy_revision" text;
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_capacity_units_check" CHECK ("capacity_units" BETWEEN 1 AND 100),
  ADD CONSTRAINT "appointments_arrival_window_check" CHECK (("promised_arrival_start_at" IS NULL AND "promised_arrival_end_at" IS NULL) OR ("promised_arrival_start_at" IS NOT NULL AND "promised_arrival_end_at" > "promised_arrival_start_at"));
CREATE INDEX "appointments_capacity_idx" ON "appointments" ("capacity_pool_key", "start_at", "status");
CREATE INDEX "appointments_partner_account_idx" ON "appointments" ("partner_account_id", "start_at");

ALTER TABLE "appointment_holds"
  ADD COLUMN "partner_account_id" uuid,
  ADD COLUMN "partner_booking_draft_id" uuid,
  ADD COLUMN "requested_by_membership_id" uuid,
  ADD COLUMN "capacity_pool_key" varchar(64) DEFAULT 'field_service' NOT NULL,
  ADD COLUMN "capacity_units" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "arrival_window_start_at" timestamptz,
  ADD COLUMN "arrival_window_end_at" timestamptz,
  ADD COLUMN "policy_revision" text,
  ADD COLUMN "service_profile_revision" integer,
  ADD COLUMN "idempotency_key_hash" varchar(64);
ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_capacity_units_check" CHECK ("capacity_units" BETWEEN 1 AND 100),
  ADD CONSTRAINT "appointment_holds_arrival_window_check" CHECK (("arrival_window_start_at" IS NULL AND "arrival_window_end_at" IS NULL) OR ("arrival_window_start_at" IS NOT NULL AND "arrival_window_end_at" > "arrival_window_start_at")),
  ADD CONSTRAINT "appointment_holds_idempotency_hash_check" CHECK ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$');
CREATE INDEX "appointment_holds_capacity_idx"
  ON "appointment_holds" ("capacity_pool_key", "start_at", "status", "expires_at");
CREATE INDEX "appointment_holds_partner_draft_idx"
  ON "appointment_holds" ("partner_account_id", "partner_booking_draft_id", "status");
CREATE UNIQUE INDEX "appointment_holds_idempotency_key"
  ON "appointment_holds" ("partner_account_id", "idempotency_key_hash")
  WHERE "partner_account_id" IS NOT NULL AND "idempotency_key_hash" IS NOT NULL;

ALTER TABLE "partner_bookings"
  ADD COLUMN "partner_account_id" uuid,
  ADD COLUMN "booking_draft_id" uuid,
  ADD COLUMN "requested_by_membership_id" uuid,
  ADD COLUMN "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  ADD COLUMN "public_status" text DEFAULT 'requested' NOT NULL,
  ADD COLUMN "confirmation_mode" text DEFAULT 'review' NOT NULL,
  ADD COLUMN "arrival_window_start_at" timestamptz,
  ADD COLUMN "arrival_window_end_at" timestamptz,
  ADD COLUMN "scope_snapshot" jsonb,
  ADD COLUMN "rate_snapshot" jsonb,
  ADD COLUMN "proof_requirements_snapshot" jsonb,
  ADD COLUMN "po_number" text,
  ADD COLUMN "cost_center" text,
  ADD COLUMN "project_reference" text,
  ADD COLUMN "billing_contact_snapshot" jsonb,
  ADD COLUMN "requested_review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN "cancel_request_hash" varchar(64),
  ADD COLUMN "updated_at" timestamptz(3) DEFAULT now() NOT NULL;
ALTER TABLE "partner_bookings"
  ADD CONSTRAINT "partner_bookings_partner_account_id_partner_accounts_id_fk"
  FOREIGN KEY ("partner_account_id") REFERENCES "partner_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "partner_bookings"
  ADD CONSTRAINT "partner_bookings_requested_by_membership_id_partner_account_memberships_id_fk"
  FOREIGN KEY ("requested_by_membership_id") REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL;
ALTER TABLE "partner_bookings"
  ADD CONSTRAINT "partner_bookings_amount_check" CHECK ("amount_cents" IS NULL OR "amount_cents" >= 0),
  ADD CONSTRAINT "partner_bookings_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "partner_bookings_public_status_check" CHECK ("public_status" IN ('requested', 'approval_needed', 'under_review', 'confirmed', 'en_route', 'in_progress', 'completed', 'canceled', 'declined')),
  ADD CONSTRAINT "partner_bookings_confirmation_mode_check" CHECK ("confirmation_mode" IN ('instant', 'review', 'approval')),
  ADD CONSTRAINT "partner_bookings_cancel_request_hash_check" CHECK ("cancel_request_hash" IS NULL OR "cancel_request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "partner_bookings_arrival_window_check" CHECK (("arrival_window_start_at" IS NULL AND "arrival_window_end_at" IS NULL) OR ("arrival_window_start_at" IS NOT NULL AND "arrival_window_end_at" > "arrival_window_start_at"));

-- Quarantine duplicate legacy appointment mappings instead of choosing a
-- canonical row silently. The V2 unique index is installed only when safe.
CREATE TABLE "partner_portal_migration_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issue_type" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
INSERT INTO "partner_portal_migration_issues" ("issue_type", "entity_type", "entity_id", "details")
SELECT 'duplicate_appointment_mapping', 'appointment', "appointment_id",
       jsonb_build_object('partnerBookingIds', jsonb_agg("id" ORDER BY "created_at"))
FROM "partner_bookings"
GROUP BY "appointment_id"
HAVING count(*) > 1;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "partner_portal_migration_issues"
    WHERE "issue_type" = 'duplicate_appointment_mapping' AND "resolved_at" IS NULL
  ) THEN
    CREATE UNIQUE INDEX "partner_bookings_appointment_key" ON "partner_bookings" ("appointment_id");
  END IF;
END $$;
CREATE INDEX "partner_portal_migration_issues_open_idx"
  ON "partner_portal_migration_issues" ("issue_type", "created_at") WHERE "resolved_at" IS NULL;
CREATE INDEX "partner_bookings_account_status_idx"
  ON "partner_bookings" ("partner_account_id", "public_status", "created_at", "id");
CREATE UNIQUE INDEX "partner_bookings_account_booking_key"
  ON "partner_bookings" ("partner_account_id", "id");
CREATE INDEX "partner_bookings_account_location_idx"
  ON "partner_bookings" ("partner_account_id", "property_id", "created_at");

CREATE TABLE "partner_account_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "property_id" uuid REFERENCES "properties"("id") ON DELETE RESTRICT,
  "site_name" text NOT NULL,
  "external_property_id" text,
  "address_line1" text NOT NULL,
  "address_line2" text,
  "city" text NOT NULL,
  "state" varchar(2) NOT NULL,
  "postal_code" varchar(16) NOT NULL,
  "timezone" text DEFAULT 'America/New_York' NOT NULL,
  "locale" text DEFAULT 'en-US' NOT NULL,
  "latitude" numeric(9,6),
  "longitude" numeric(9,6),
  "geocode_status" text DEFAULT 'pending' NOT NULL CHECK ("geocode_status" IN ('pending', 'verified', 'failed', 'manual')),
  "service_area_status" text DEFAULT 'unverified' NOT NULL CHECK ("service_area_status" IN ('unverified', 'eligible', 'review', 'outside')),
  "access_instructions" text,
  "parking_instructions" text,
  "loading_instructions" text,
  "access_secret_ciphertext" text,
  "access_secret_key_version" integer,
  "on_site_contact" jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "created_by_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz(3) DEFAULT now() NOT NULL,
  CONSTRAINT "partner_account_locations_secret_state_check"
    CHECK (("access_secret_ciphertext" IS NULL AND "access_secret_key_version" IS NULL) OR ("access_secret_ciphertext" IS NOT NULL AND "access_secret_key_version" > 0))
);
CREATE UNIQUE INDEX "partner_account_locations_account_location_key" ON "partner_account_locations" ("partner_account_id", "id");
CREATE UNIQUE INDEX "partner_account_locations_account_property_key" ON "partner_account_locations" ("partner_account_id", "property_id") WHERE "property_id" IS NOT NULL;
CREATE UNIQUE INDEX "partner_account_locations_account_external_key" ON "partner_account_locations" ("partner_account_id", "external_property_id") WHERE "external_property_id" IS NOT NULL;
CREATE INDEX "partner_account_locations_account_active_idx" ON "partner_account_locations" ("partner_account_id", "active", "site_name");

CREATE TABLE "partner_service_catalog" (
  "key" varchar(80) PRIMARY KEY,
  "label" text NOT NULL,
  "description" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "instant_bookable" boolean DEFAULT false NOT NULL,
  "required_scope_fields" text[] DEFAULT '{}'::text[] NOT NULL,
  "default_proof_requirements" jsonb DEFAULT '{"before":1,"after":1}'::jsonb NOT NULL,
  "automatic_review_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_service_catalog_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_-]{1,79}$')
);
CREATE INDEX "partner_service_catalog_active_idx" ON "partner_service_catalog" ("active", "label");

CREATE TABLE "schedule_resource_pools" (
  "key" varchar(64) PRIMARY KEY,
  "label" text NOT NULL,
  "capacity_units" integer NOT NULL CHECK ("capacity_units" BETWEEN 1 AND 10000),
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "schedule_resource_pools_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_-]{0,63}$')
);

CREATE TABLE "partner_scheduling_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "service_key" varchar(80) NOT NULL REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "duration_minutes" integer NOT NULL CHECK ("duration_minutes" BETWEEN 15 AND 1440),
  "travel_buffer_minutes" integer NOT NULL CHECK ("travel_buffer_minutes" BETWEEN 0 AND 1440),
  "capacity_pool_key" varchar(64) NOT NULL REFERENCES "schedule_resource_pools"("key") ON DELETE RESTRICT,
  "capacity_units" integer DEFAULT 1 NOT NULL CHECK ("capacity_units" BETWEEN 1 AND 100),
  "supported_territories" text[] DEFAULT '{}'::text[] NOT NULL,
  "required_scope_fields" text[] DEFAULT '{}'::text[] NOT NULL,
  "pricing_eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "proof_defaults" jsonb DEFAULT '{"before":1,"after":1}'::jsonb NOT NULL,
  "automatic_review_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "instant_confirmation_enabled" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "effective_from" timestamptz DEFAULT now() NOT NULL,
  "effective_to" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_scheduling_profiles_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);
CREATE UNIQUE INDEX "partner_scheduling_profiles_service_version_key" ON "partner_scheduling_profiles" ("service_key", "version");
CREATE INDEX "partner_scheduling_profiles_effective_idx" ON "partner_scheduling_profiles" ("service_key", "active", "effective_from", "effective_to");

CREATE TABLE "schedule_date_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "local_date" date NOT NULL,
  "timezone" text DEFAULT 'America/New_York' NOT NULL,
  "closed" boolean DEFAULT false NOT NULL,
  "windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "capacity_by_pool" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "schedule_date_overrides_local_date_key" ON "schedule_date_overrides" ("local_date", "timezone");

CREATE TABLE "schedule_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('external_busy', 'blackout', 'resource_unavailable', 'capacity_adjustment')),
  "source" text NOT NULL,
  "source_key" text,
  "capacity_pool_key" varchar(64) NOT NULL REFERENCES "schedule_resource_pools"("key") ON DELETE RESTRICT,
  "capacity_units" integer NOT NULL CHECK ("capacity_units" BETWEEN 1 AND 10000),
  "start_at" timestamptz NOT NULL,
  "end_at" timestamptz NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "mirrored_appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "metadata" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "schedule_blocks_range_check" CHECK ("end_at" > "start_at")
);
CREATE UNIQUE INDEX "schedule_blocks_source_key" ON "schedule_blocks" ("source", "source_key") WHERE "source_key" IS NOT NULL;
CREATE INDEX "schedule_blocks_occupancy_idx" ON "schedule_blocks" ("capacity_pool_key", "active", "start_at", "end_at");

CREATE TABLE "partner_booking_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "created_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "partner_account_locations"("id") ON DELETE RESTRICT,
  "service_key" varchar(80) REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "state" text DEFAULT 'draft' NOT NULL CHECK ("state" IN ('draft', 'ready', 'submitted', 'abandoned', 'expired')),
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "description" text,
  "crew_instructions" text,
  "access_details" text,
  "on_site_contact" jsonb,
  "proof_requirements" jsonb DEFAULT '{"before":1,"after":1}'::jsonb NOT NULL,
  "commercial" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "preferred_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "expires_at" timestamptz,
  "submitted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz(3) DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_booking_drafts_account_draft_key" ON "partner_booking_drafts" ("partner_account_id", "id");
CREATE INDEX "partner_booking_drafts_account_state_idx" ON "partner_booking_drafts" ("partner_account_id", "state", "updated_at", "id");
CREATE INDEX "partner_booking_drafts_creator_idx" ON "partner_booking_drafts" ("created_by_membership_id", "state");

ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_partner_booking_draft_id_partner_booking_drafts_id_fk"
  FOREIGN KEY ("partner_booking_draft_id") REFERENCES "partner_booking_drafts"("id") ON DELETE CASCADE;
ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_requested_by_membership_id_partner_account_memberships_id_fk"
  FOREIGN KEY ("requested_by_membership_id") REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL;
ALTER TABLE "partner_bookings"
  ADD CONSTRAINT "partner_bookings_booking_draft_id_partner_booking_drafts_id_fk"
  FOREIGN KEY ("booking_draft_id") REFERENCES "partner_booking_drafts"("id") ON DELETE SET NULL;

CREATE TABLE "partner_draft_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "booking_draft_id" uuid NOT NULL REFERENCES "partner_booking_drafts"("id") ON DELETE CASCADE,
  "media_asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE RESTRICT,
  "category" text DEFAULT 'intake' NOT NULL CHECK ("category" IN ('intake', 'before', 'after', 'completion', 'issue', 'document')),
  "caption" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "uploaded_by_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "deleted_at" timestamptz,
  "purge_eligible_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_draft_media_deletion_check" CHECK (("deleted_at" IS NULL AND "purge_eligible_at" IS NULL) OR ("deleted_at" IS NOT NULL AND "purge_eligible_at" >= "deleted_at" + interval '30 days'))
);
CREATE UNIQUE INDEX "partner_draft_media_draft_asset_key" ON "partner_draft_media" ("booking_draft_id", "media_asset_id");
CREATE INDEX "partner_draft_media_account_draft_idx" ON "partner_draft_media" ("partner_account_id", "booking_draft_id", "sort_order");

CREATE TABLE "partner_job_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL REFERENCES "partner_bookings"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "public_label" text NOT NULL,
  "public_detail" text,
  "effective_at" timestamptz DEFAULT now() NOT NULL,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('partner', 'staff', 'system')),
  "actor_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "actor_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "metadata" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_job_events_actor_binding_check" CHECK (("actor_type" = 'partner' AND "actor_membership_id" IS NOT NULL AND "actor_team_member_id" IS NULL) OR ("actor_type" = 'staff' AND "actor_team_member_id" IS NOT NULL AND "actor_membership_id" IS NULL) OR ("actor_type" = 'system' AND "actor_membership_id" IS NULL AND "actor_team_member_id" IS NULL))
);
CREATE INDEX "partner_job_events_job_timeline_idx" ON "partner_job_events" ("partner_account_id", "partner_booking_id", "effective_at", "id");

CREATE TABLE "partner_job_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL REFERENCES "partner_bookings"("id") ON DELETE CASCADE,
  "author_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "author_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "body" varchar(5000) NOT NULL,
  "portal_visible" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "deleted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_job_comments_author_check" CHECK (num_nonnulls("author_membership_id", "author_team_member_id") = 1)
);
CREATE INDEX "partner_job_comments_job_history_idx" ON "partner_job_comments" ("partner_account_id", "partner_booking_id", "portal_visible", "created_at", "id");

CREATE TABLE "partner_evidence_requirements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE CASCADE,
  "category" text NOT NULL CHECK ("category" IN ('intake', 'before', 'after', 'completion', 'issue', 'document')),
  "minimum_count" integer DEFAULT 1 NOT NULL CHECK ("minimum_count" BETWEEN 0 AND 40),
  "required" boolean DEFAULT true NOT NULL,
  "source" text DEFAULT 'account_default' NOT NULL,
  "override_reason" text,
  "overridden_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_evidence_requirements_override_check" CHECK (("source" <> 'staff_override' AND "override_reason" IS NULL AND "overridden_by_team_member_id" IS NULL) OR ("source" = 'staff_override' AND char_length(btrim("override_reason")) >= 10 AND "overridden_by_team_member_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "partner_evidence_requirements_account_default_key" ON "partner_evidence_requirements" ("partner_account_id", "category") WHERE "partner_booking_id" IS NULL;
CREATE UNIQUE INDEX "partner_evidence_requirements_job_category_key" ON "partner_evidence_requirements" ("partner_booking_id", "category") WHERE "partner_booking_id" IS NOT NULL;

CREATE TABLE "partner_job_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL REFERENCES "partner_bookings"("id") ON DELETE CASCADE,
  "media_asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE RESTRICT,
  "category" text NOT NULL CHECK ("category" IN ('intake', 'before', 'after', 'completion', 'issue', 'document')),
  "caption" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "uploaded_by_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "uploaded_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "deleted_at" timestamptz,
  "purge_eligible_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_job_evidence_uploader_check" CHECK (num_nonnulls("uploaded_by_membership_id", "uploaded_by_team_member_id") <= 1),
  CONSTRAINT "partner_job_evidence_deletion_check" CHECK (("deleted_at" IS NULL AND "purge_eligible_at" IS NULL) OR ("deleted_at" IS NOT NULL AND "purge_eligible_at" >= "deleted_at" + interval '30 days'))
);
CREATE UNIQUE INDEX "partner_job_evidence_job_asset_key" ON "partner_job_evidence" ("partner_booking_id", "media_asset_id");
CREATE INDEX "partner_job_evidence_job_category_idx" ON "partner_job_evidence" ("partner_account_id", "partner_booking_id", "category", "sort_order");

CREATE TABLE "partner_proof_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "manifest" jsonb NOT NULL,
  "manifest_sha256" varchar(64) NOT NULL CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
  "pdf_document_id" uuid,
  "zip_document_id" uuid,
  "generated_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_proof_packages_job_version_key" ON "partner_proof_packages" ("partner_booking_id", "version");
CREATE INDEX "partner_proof_packages_account_generated_idx" ON "partner_proof_packages" ("partner_account_id", "generated_at");

CREATE TABLE "partner_proof_share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "proof_package_id" uuid NOT NULL REFERENCES "partner_proof_packages"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "last_accessed_at" timestamptz,
  "access_count" integer DEFAULT 0 NOT NULL CHECK ("access_count" >= 0),
  "created_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_proof_share_links_expiry_check" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX "partner_proof_share_links_token_key" ON "partner_proof_share_links" ("token_hash");
CREATE INDEX "partner_proof_share_links_account_expiry_idx" ON "partner_proof_share_links" ("partner_account_id", "expires_at", "revoked_at");

CREATE TABLE "partner_notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE CASCADE,
  "event_key" text NOT NULL,
  "in_app_enabled" boolean DEFAULT true NOT NULL,
  "email_enabled" boolean DEFAULT true NOT NULL,
  "sms_enabled" boolean DEFAULT false NOT NULL,
  "sms_verified_opt_in_at" timestamptz,
  "quiet_hours_start" varchar(5),
  "quiet_hours_end" varchar(5),
  "timezone" text DEFAULT 'America/New_York' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_notification_preferences_sms_consent_check" CHECK ("sms_enabled" = false OR "sms_verified_opt_in_at" IS NOT NULL),
  CONSTRAINT "partner_notification_preferences_quiet_hours_check" CHECK (("quiet_hours_start" IS NULL AND "quiet_hours_end" IS NULL) OR ("quiet_hours_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "quiet_hours_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
CREATE UNIQUE INDEX "partner_notification_preferences_membership_event_key" ON "partner_notification_preferences" ("membership_id", "event_key");
CREATE INDEX "partner_notification_preferences_account_idx" ON "partner_notification_preferences" ("partner_account_id", "membership_id");

CREATE TABLE "partner_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE CASCADE,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE CASCADE,
  "event_key" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "action_path" text,
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "partner_notifications_unread_idx" ON "partner_notifications" ("partner_account_id", "membership_id", "read_at", "created_at", "id");

CREATE TABLE "partner_service_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "service_key" varchar(80) NOT NULL REFERENCES "partner_service_catalog"("key") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "partner_account_locations"("id") ON DELETE SET NULL,
  "template_data" jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "created_by_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_service_templates_account_name_key" ON "partner_service_templates" ("partner_account_id", "name") WHERE "active" = true;
CREATE INDEX "partner_service_templates_account_idx" ON "partner_service_templates" ("partner_account_id", "active", "updated_at");

CREATE TABLE "partner_recurring_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "template_id" uuid REFERENCES "partner_service_templates"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "recurrence_rule" text NOT NULL,
  "timezone" text DEFAULT 'America/New_York' NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date,
  "state" text DEFAULT 'active' NOT NULL CHECK ("state" IN ('active', 'paused', 'completed', 'canceled')),
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "created_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_recurring_series_date_check" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on")
);
CREATE INDEX "partner_recurring_series_account_state_idx" ON "partner_recurring_series" ("partner_account_id", "state", "starts_on");

CREATE TABLE "partner_recurring_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "recurring_series_id" uuid NOT NULL REFERENCES "partner_recurring_series"("id") ON DELETE CASCADE,
  "local_date" date NOT NULL,
  "state" text DEFAULT 'tentative' NOT NULL CHECK ("state" IN ('tentative', 'evaluating', 'confirmed', 'review', 'failed', 'skipped', 'canceled')),
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE SET NULL,
  "failure_code" text,
  "evaluated_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_recurring_occurrences_series_date_key" ON "partner_recurring_occurrences" ("recurring_series_id", "local_date");
CREATE INDEX "partner_recurring_occurrences_action_idx" ON "partner_recurring_occurrences" ("partner_account_id", "state", "local_date");

CREATE TABLE "partner_bulk_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "created_by_membership_id" uuid NOT NULL REFERENCES "partner_account_memberships"("id") ON DELETE RESTRICT,
  "source_filename" text NOT NULL,
  "source_sha256" varchar(64) NOT NULL CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
  "state" text DEFAULT 'validating' NOT NULL CHECK ("state" IN ('validating', 'validated', 'processing', 'completed', 'failed')),
  "dry_run" boolean DEFAULT true NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "valid_count" integer DEFAULT 0 NOT NULL,
  "error_count" integer DEFAULT 0 NOT NULL,
  "correction_document_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "partner_bulk_imports_counts_check" CHECK ("row_count" >= 0 AND "valid_count" >= 0 AND "error_count" >= 0 AND "valid_count" + "error_count" <= "row_count")
);
CREATE INDEX "partner_bulk_imports_account_created_idx" ON "partner_bulk_imports" ("partner_account_id", "created_at", "id");

CREATE TABLE "partner_bulk_import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_bulk_import_id" uuid NOT NULL REFERENCES "partner_bulk_imports"("id") ON DELETE CASCADE,
  "row_number" integer NOT NULL CHECK ("row_number" > 0),
  "normalized_data" jsonb,
  "errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending', 'invalid', 'review', 'created', 'failed')),
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_bulk_import_rows_import_row_key" ON "partner_bulk_import_rows" ("partner_bulk_import_id", "row_number");
CREATE INDEX "partner_bulk_import_rows_state_idx" ON "partner_bulk_import_rows" ("partner_bulk_import_id", "state", "row_number");

CREATE TABLE "partner_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid REFERENCES "partner_bookings"("id") ON DELETE RESTRICT,
  "document_type" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL CHECK ("version" > 0),
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL CHECK ("byte_size" > 0),
  "storage_bucket" text NOT NULL,
  "storage_object_key" text NOT NULL,
  "sha256" varchar(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "metadata" jsonb,
  "generated_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "partner_documents_storage_key" ON "partner_documents" ("storage_bucket", "storage_object_key");
CREATE UNIQUE INDEX "partner_documents_job_type_version_key" ON "partner_documents" ("partner_booking_id", "document_type", "version") WHERE "partner_booking_id" IS NOT NULL;
CREATE INDEX "partner_documents_account_type_idx" ON "partner_documents" ("partner_account_id", "document_type", "generated_at", "id");

ALTER TABLE "partner_proof_packages"
  ADD CONSTRAINT "partner_proof_packages_pdf_document_id_partner_documents_id_fk"
  FOREIGN KEY ("pdf_document_id") REFERENCES "partner_documents"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "partner_proof_packages_zip_document_id_partner_documents_id_fk"
  FOREIGN KEY ("zip_document_id") REFERENCES "partner_documents"("id") ON DELETE SET NULL;
ALTER TABLE "partner_bulk_imports"
  ADD CONSTRAINT "partner_bulk_imports_correction_document_id_partner_documents_id_fk"
  FOREIGN KEY ("correction_document_id") REFERENCES "partner_documents"("id") ON DELETE SET NULL;

CREATE TABLE "partner_document_access_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_document_id" uuid NOT NULL REFERENCES "partner_documents"("id") ON DELETE RESTRICT,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('partner', 'staff', 'share_link', 'system')),
  "actor_membership_id" uuid REFERENCES "partner_account_memberships"("id") ON DELETE SET NULL,
  "actor_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "share_link_id" uuid REFERENCES "partner_proof_share_links"("id") ON DELETE SET NULL,
  "action" text DEFAULT 'download' NOT NULL,
  "correlation_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "partner_document_access_logs_document_history_idx" ON "partner_document_access_logs" ("partner_document_id", "created_at", "id");
CREATE INDEX "partner_document_access_logs_account_idx" ON "partner_document_access_logs" ("partner_account_id", "created_at");

-- Backfill V2 tenant anchors without guessing across ambiguous contacts.
UPDATE "partner_bookings" pb
SET "partner_account_id" = pa."id",
    "updated_at" = now()
FROM "partner_accounts" pa
WHERE pa."portal_contact_id" = pb."org_contact_id"
  AND pb."partner_account_id" IS NULL;
UPDATE "appointments" a
SET "partner_account_id" = pb."partner_account_id"
FROM "partner_bookings" pb
WHERE pb."appointment_id" = a."id"
  AND pb."partner_account_id" IS NOT NULL
  AND a."partner_account_id" IS NULL;
UPDATE "partner_bookings" pb
SET "public_status" = CASE appointment."status"::text
      WHEN 'confirmed' THEN 'confirmed'
      WHEN 'completed' THEN 'completed'
      WHEN 'canceled' THEN 'canceled'
      WHEN 'no_show' THEN 'declined'
      ELSE 'requested'
    END,
    "amount_cents" = coalesce(pb."amount_cents", appointment."quoted_total_cents"),
    "scope_snapshot" = coalesce(
      pb."scope_snapshot",
      appointment."booking_details",
      CASE WHEN appointment."quoted_scope_text" IS NOT NULL
        THEN jsonb_build_object('description', appointment."quoted_scope_text")
        ELSE NULL
      END
    ),
    "updated_at" = now()
FROM "appointments" appointment
WHERE appointment."id" = pb."appointment_id";
UPDATE "partner_rate_cards" rc
SET "partner_account_id" = pa."id"
FROM "partner_accounts" pa
WHERE pa."portal_contact_id" = rc."org_contact_id"
  AND rc."partner_account_id" IS NULL;

INSERT INTO "partner_account_locations" (
  "partner_account_id", "property_id", "site_name", "address_line1",
  "address_line2", "city", "state", "postal_code", "latitude", "longitude",
  "geocode_status", "service_area_status"
)
SELECT DISTINCT ON (pa."id", property."id")
  pa."id", property."id", property."address_line1", property."address_line1",
  property."address_line2", property."city", property."state", property."postal_code",
  property."lat", property."lng",
  CASE WHEN property."lat" IS NOT NULL AND property."lng" IS NOT NULL THEN 'verified' ELSE 'pending' END,
  'unverified'
FROM "partner_accounts" pa
JOIN "contact_properties" cp ON cp."contact_id" = pa."portal_contact_id"
JOIN "properties" property ON property."id" = cp."property_id"
ON CONFLICT ("partner_account_id", "property_id") WHERE "property_id" IS NOT NULL DO NOTHING;

INSERT INTO "partner_job_events" (
  "partner_account_id", "partner_booking_id", "event_type", "public_label",
  "effective_at", "actor_type", "metadata"
)
SELECT pb."partner_account_id", pb."id", 'job.migrated',
  CASE pb."public_status"
    WHEN 'confirmed' THEN 'Confirmed'
    WHEN 'completed' THEN 'Completed'
    WHEN 'canceled' THEN 'Canceled'
    WHEN 'declined' THEN 'Declined'
    ELSE 'Requested'
  END,
  pb."created_at", 'system', jsonb_build_object('source', 'legacy_partner_booking')
FROM "partner_bookings" pb
WHERE pb."partner_account_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "partner_job_events" event
    WHERE event."partner_booking_id" = pb."id"
  );

INSERT INTO "schedule_resource_pools" ("key", "label", "capacity_units")
VALUES ('field_service', 'Field service', greatest(1, least(10000, coalesce(nullif(current_setting('app.booking_capacity', true), '')::integer, 2))))
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "partner_service_catalog" ("key", "label", "description", "active", "instant_bookable")
VALUES ('junk_removal_primary', 'Junk removal', 'Standard Stonegate removal and hauling service.', true, false)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "partner_service_catalog" ("key", "label", "description", "active", "instant_bookable")
SELECT DISTINCT pri."service_key", initcap(replace(pri."service_key", '_', ' ')), 'Legacy negotiated partner service.', true, false
FROM "partner_rate_items" pri
WHERE pri."service_key" ~ '^[a-z][a-z0-9_-]{1,79}$'
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "partner_scheduling_profiles" (
  "service_key", "version", "duration_minutes", "travel_buffer_minutes",
  "capacity_pool_key", "capacity_units", "required_scope_fields",
  "instant_confirmation_enabled", "active"
)
VALUES (
  'junk_removal_primary', 1, 120, 30, 'field_service', 1,
  ARRAY['description', 'location', 'onSiteContact']::text[], false, true
)
ON CONFLICT ("service_key", "version") DO NOTHING;

INSERT INTO "partner_evidence_requirements" ("partner_account_id", "category", "minimum_count", "required", "source")
SELECT pa."id", category, 1, true, 'account_default'
FROM "partner_accounts" pa
CROSS JOIN (VALUES ('before'), ('after')) AS defaults(category)
ON CONFLICT DO NOTHING;

-- Account/resource composite constraints prevent a valid identifier from a
-- different tenant being associated through accidental application bugs.
ALTER TABLE "partner_booking_drafts"
  ADD CONSTRAINT "partner_booking_drafts_account_location_fk"
  FOREIGN KEY ("partner_account_id", "location_id")
  REFERENCES "partner_account_locations"("partner_account_id", "id") ON DELETE RESTRICT;
ALTER TABLE "partner_draft_media"
  ADD CONSTRAINT "partner_draft_media_account_draft_fk"
  FOREIGN KEY ("partner_account_id", "booking_draft_id")
  REFERENCES "partner_booking_drafts"("partner_account_id", "id") ON DELETE CASCADE;
ALTER TABLE "partner_job_events"
  ADD CONSTRAINT "partner_job_events_account_booking_fk"
  FOREIGN KEY ("partner_account_id", "partner_booking_id")
  REFERENCES "partner_bookings"("partner_account_id", "id") ON DELETE CASCADE;
ALTER TABLE "partner_job_comments"
  ADD CONSTRAINT "partner_job_comments_account_booking_fk"
  FOREIGN KEY ("partner_account_id", "partner_booking_id")
  REFERENCES "partner_bookings"("partner_account_id", "id") ON DELETE CASCADE;
ALTER TABLE "partner_job_evidence"
  ADD CONSTRAINT "partner_job_evidence_account_booking_fk"
  FOREIGN KEY ("partner_account_id", "partner_booking_id")
  REFERENCES "partner_bookings"("partner_account_id", "id") ON DELETE CASCADE;
