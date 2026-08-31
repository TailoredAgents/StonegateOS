-- Quote V2 is an additive aggregate beside the legacy mutable quote row.
-- Existing rows remain pinned to the legacy engine; no data is backfilled here.

CREATE TABLE "sales_opportunities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE RESTRICT,
  "property_id" uuid REFERENCES "properties"("id") ON DELETE SET NULL,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE SET NULL,
  "owner_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "pipeline_stage" text,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  "estimated_value_cents" integer,
  "revision" integer DEFAULT 1 NOT NULL,
  "closed_at" timestamptz,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "sales_opportunities_status_check" CHECK ("status" IN ('open', 'approved', 'won', 'lost', 'archived')),
  CONSTRAINT "sales_opportunities_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "sales_opportunities_estimated_value_check" CHECK ("estimated_value_cents" IS NULL OR "estimated_value_cents" >= 0),
  CONSTRAINT "sales_opportunities_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "sales_opportunities_closed_check" CHECK ("status" IN ('open', 'approved') OR "closed_at" IS NOT NULL)
);
CREATE INDEX "sales_opportunities_contact_status_idx" ON "sales_opportunities" ("contact_id", "status", "created_at");
CREATE INDEX "sales_opportunities_property_idx" ON "sales_opportunities" ("property_id");
CREATE INDEX "sales_opportunities_owner_status_idx" ON "sales_opportunities" ("owner_team_member_id", "status");

-- Nullable compatibility links let every operational surface share one project
-- context without inventing a destructive legacy backfill.
ALTER TABLE "leads"
  ADD COLUMN "sales_opportunity_id" uuid,
  ADD CONSTRAINT "leads_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE SET NULL;
CREATE INDEX "leads_sales_opportunity_idx" ON "leads" ("sales_opportunity_id");

ALTER TABLE "appointments"
  ADD COLUMN "sales_opportunity_id" uuid,
  ADD CONSTRAINT "appointments_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE SET NULL;
CREATE INDEX "appointments_sales_opportunity_idx" ON "appointments" ("sales_opportunity_id");

ALTER TABLE "crm_tasks"
  ADD COLUMN "sales_opportunity_id" uuid,
  ADD CONSTRAINT "crm_tasks_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE SET NULL;
CREATE INDEX "crm_tasks_sales_opportunity_idx" ON "crm_tasks" ("sales_opportunity_id");

ALTER TABLE "conversation_threads"
  ADD COLUMN "sales_opportunity_id" uuid,
  ADD CONSTRAINT "conversation_threads_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE SET NULL;
CREATE INDEX "conversation_threads_sales_opportunity_idx" ON "conversation_threads" ("sales_opportunity_id");

ALTER TABLE "quotes"
  ADD COLUMN "sales_opportunity_id" uuid,
  ADD COLUMN "current_version_id" uuid,
  ADD COLUMN "published_version_id" uuid,
  ADD COLUMN "engine_version" text DEFAULT 'legacy' NOT NULL,
  ADD COLUMN "aggregate_state" text,
  ADD COLUMN "aggregate_revision" integer,
  ADD CONSTRAINT "quotes_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "quotes_engine_version_check" CHECK ("engine_version" IN ('legacy', 'v2')),
  ADD CONSTRAINT "quotes_aggregate_state_check" CHECK ("aggregate_state" IS NULL OR "aggregate_state" IN ('draft', 'open', 'accepted', 'declined', 'voided', 'archived')),
  ADD CONSTRAINT "quotes_v2_shape_check" CHECK ("engine_version" = 'legacy' OR ("aggregate_state" IS NOT NULL AND "aggregate_revision" IS NOT NULL AND "aggregate_revision" > 0 AND "quote_number" IS NOT NULL));
CREATE INDEX "quotes_sales_opportunity_idx" ON "quotes" ("sales_opportunity_id");
CREATE INDEX "quotes_aggregate_state_idx" ON "quotes" ("engine_version", "aggregate_state", "updated_at");
CREATE UNIQUE INDEX "quotes_v2_quote_number_key" ON "quotes" ("quote_number") WHERE "engine_version" = 'v2' AND "quote_number" IS NOT NULL;

CREATE TABLE "quote_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "version_number" integer NOT NULL,
  "draft_revision" integer DEFAULT 1 NOT NULL,
  "supersedes_version_id" uuid,
  "state" text DEFAULT 'draft' NOT NULL,
  "provenance" text DEFAULT 'native' NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "document_type" text NOT NULL,
  "audience" text NOT NULL,
  "scheduling_mode" text NOT NULL,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  "document_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "party_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "issuer_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "terms_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "canonical_render_json" text,
  "document_schema_hash" varchar(64),
  "pricing_hash" varchar(64),
  "template_hash" varchar(64),
  "content_hash" varchar(64),
  "client_name" text,
  "client_company" text,
  "client_email" text,
  "client_phone" text,
  "project_name" text,
  "purchase_order_number" text,
  "reference_number" text,
  "selected_option_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "subtotal_min_cents" integer DEFAULT 0 NOT NULL,
  "subtotal_max_cents" integer DEFAULT 0 NOT NULL,
  "discount_min_cents" integer DEFAULT 0 NOT NULL,
  "discount_max_cents" integer DEFAULT 0 NOT NULL,
  "fee_min_cents" integer DEFAULT 0 NOT NULL,
  "fee_max_cents" integer DEFAULT 0 NOT NULL,
  "total_min_cents" integer DEFAULT 0 NOT NULL,
  "total_max_cents" integer DEFAULT 0 NOT NULL,
  "deposit_cents" integer DEFAULT 0 NOT NULL,
  "balance_min_cents" integer DEFAULT 0 NOT NULL,
  "balance_max_cents" integer DEFAULT 0 NOT NULL,
  "scope" text,
  "assumptions" text,
  "exclusions" text,
  "terms" text,
  "payment_terms" text,
  "internal_notes" text,
  "valid_from" timestamptz,
  "expires_at" timestamptz,
  "ready_at" timestamptz,
  "issued_at" timestamptz,
  "first_sent_at" timestamptz,
  "superseded_at" timestamptz,
  "created_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_versions_version_check" CHECK ("version_number" > 0 AND "draft_revision" > 0 AND "schema_version" > 0),
  CONSTRAINT "quote_versions_state_check" CHECK ("state" IN ('draft', 'ready', 'issued', 'superseded', 'accepted', 'expired', 'declined', 'voided')),
  CONSTRAINT "quote_versions_provenance_check" CHECK ("provenance" IN ('native', 'legacy_current_state')),
  CONSTRAINT "quote_versions_document_type_check" CHECK ("document_type" IN ('fixed_quote', 'estimate', 'range')),
  CONSTRAINT "quote_versions_audience_check" CHECK ("audience" IN ('residential', 'commercial')),
  CONSTRAINT "quote_versions_scheduling_mode_check" CHECK ("scheduling_mode" IN ('self_schedule', 'staff_followup', 'approval_only')),
  CONSTRAINT "quote_versions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "quote_versions_snapshot_shape_check" CHECK (
    jsonb_typeof("document_snapshot") = 'object' AND jsonb_typeof("party_snapshot") = 'object'
    AND jsonb_typeof("issuer_snapshot") = 'object' AND jsonb_typeof("terms_snapshot") = 'object'
    AND ("canonical_render_json" IS NULL OR jsonb_typeof("canonical_render_json"::jsonb) = 'object')
  ),
  CONSTRAINT "quote_versions_totals_check" CHECK (
    "subtotal_min_cents" >= 0 AND "subtotal_max_cents" >= "subtotal_min_cents"
    AND "discount_min_cents" >= 0 AND "discount_max_cents" >= "discount_min_cents"
    AND "fee_min_cents" >= 0 AND "fee_max_cents" >= "fee_min_cents"
    AND "total_min_cents" = "subtotal_min_cents" - "discount_min_cents" + "fee_min_cents"
    AND "total_max_cents" = "subtotal_max_cents" - "discount_max_cents" + "fee_max_cents"
    AND "total_min_cents" >= 0 AND "total_max_cents" >= "total_min_cents"
  ),
  CONSTRAINT "quote_versions_deposit_check" CHECK (
    "deposit_cents" >= 0 AND "deposit_cents" <= "total_min_cents"
    AND "balance_min_cents" = "total_min_cents" - "deposit_cents"
    AND "balance_max_cents" = "total_max_cents" - "deposit_cents"
  ),
  CONSTRAINT "quote_versions_range_check" CHECK (
    "state" IN ('draft', 'voided')
    OR ("document_type" = 'range' AND "total_min_cents" > 0 AND "total_max_cents" > "total_min_cents")
    OR ("document_type" <> 'range' AND "total_min_cents" > 0 AND "total_max_cents" = "total_min_cents")
  ),
  CONSTRAINT "quote_versions_hashes_check" CHECK (
    ("document_schema_hash" IS NULL OR "document_schema_hash" ~ '^[0-9a-f]{64}$')
    AND ("pricing_hash" IS NULL OR "pricing_hash" ~ '^[0-9a-f]{64}$')
    AND ("template_hash" IS NULL OR "template_hash" ~ '^[0-9a-f]{64}$')
    AND ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "quote_versions_validity_check" CHECK ("expires_at" IS NULL OR "valid_from" IS NULL OR "expires_at" > "valid_from"),
  CONSTRAINT "quote_versions_readiness_check" CHECK (
    "state" IN ('draft', 'voided') OR "ready_at" IS NOT NULL
  ),
  CONSTRAINT "quote_versions_ready_publication_check" CHECK (
    ("state" <> 'draft' OR (
      "valid_from" IS NULL AND "expires_at" IS NULL AND "issued_at" IS NULL AND "first_sent_at" IS NULL
      AND "canonical_render_json" IS NULL AND "document_schema_hash" IS NULL AND "pricing_hash" IS NULL
      AND "template_hash" IS NULL AND "content_hash" IS NULL
    )) AND ("state" <> 'ready' OR (
      "valid_from" IS NULL AND "expires_at" IS NULL AND "issued_at" IS NULL AND "first_sent_at" IS NULL
      AND "canonical_render_json" IS NOT NULL AND "document_schema_hash" IS NOT NULL AND "pricing_hash" IS NOT NULL
      AND "template_hash" IS NOT NULL AND "content_hash" IS NOT NULL
    ))
  ),
  CONSTRAINT "quote_versions_issuance_check" CHECK (
    "state" IN ('draft', 'ready', 'voided') OR (
      "ready_at" IS NOT NULL AND "issued_at" IS NOT NULL AND "expires_at" IS NOT NULL AND "expires_at" > "issued_at"
      AND "canonical_render_json" IS NOT NULL AND "document_schema_hash" IS NOT NULL AND "pricing_hash" IS NOT NULL
      AND "template_hash" IS NOT NULL AND "content_hash" IS NOT NULL
    )
  ),
  CONSTRAINT "quote_versions_timeline_check" CHECK (
    ("issued_at" IS NULL OR ("ready_at" IS NOT NULL AND "issued_at" >= "ready_at"))
    AND ("first_sent_at" IS NULL OR ("issued_at" IS NOT NULL AND "first_sent_at" >= "issued_at"))
    AND ("superseded_at" IS NULL OR ("issued_at" IS NOT NULL AND "superseded_at" >= "issued_at"))
  ),
  CONSTRAINT "quote_versions_superseded_check" CHECK ("state" <> 'superseded' OR "superseded_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "quote_versions_id_quote_key" ON "quote_versions" ("id", "quote_id");
CREATE UNIQUE INDEX "quote_versions_quote_version_key" ON "quote_versions" ("quote_id", "version_number");
CREATE INDEX "quote_versions_quote_state_idx" ON "quote_versions" ("quote_id", "state", "created_at");
CREATE INDEX "quote_versions_expires_idx" ON "quote_versions" ("state", "expires_at");
ALTER TABLE "quote_versions"
  ADD CONSTRAINT "quote_versions_supersedes_id_fk" FOREIGN KEY ("supersedes_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT;

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_current_version_id_fk" FOREIGN KEY ("current_version_id", "id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "quotes_published_version_id_fk" FOREIGN KEY ("published_version_id", "id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT;
CREATE INDEX "quotes_current_version_idx" ON "quotes" ("current_version_id");
CREATE INDEX "quotes_published_version_idx" ON "quotes" ("published_version_id");

ALTER TABLE "appointments"
  ADD COLUMN "quote_version_id" uuid,
  ADD CONSTRAINT "appointments_quote_version_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "quote_versions"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "appointments_quote_version_key" ON "appointments" ("quote_version_id") WHERE "quote_version_id" IS NOT NULL;

ALTER TABLE "appointment_holds"
  ADD COLUMN "quote_version_id" uuid,
  ADD CONSTRAINT "appointment_holds_quote_version_id_fk" FOREIGN KEY ("quote_version_id", "full_quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "appointment_holds_quote_version_link_check" CHECK ("quote_version_id" IS NULL OR "full_quote_id" IS NOT NULL);
CREATE INDEX "appointment_holds_quote_version_idx" ON "appointment_holds" ("quote_version_id", "status", "expires_at");
CREATE UNIQUE INDEX "appointment_holds_active_quote_version_key" ON "appointment_holds" ("quote_version_id") WHERE "quote_version_id" IS NOT NULL AND "status" = 'active';

ALTER TABLE "quote_pdf_downloads"
  ADD COLUMN "quote_version_id" uuid,
  ADD CONSTRAINT "quote_pdf_downloads_version_id_fk" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT;
CREATE INDEX "quote_pdf_downloads_version_idx" ON "quote_pdf_downloads" ("quote_version_id", "created_at");

CREATE TABLE "quote_version_option_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE CASCADE,
  "group_key" varchar(80) NOT NULL,
  "label" varchar(200) NOT NULL,
  "mode" text NOT NULL,
  "minimum_selections" integer DEFAULT 0 NOT NULL,
  "maximum_selections" integer NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_option_groups_mode_check" CHECK ("mode" IN ('single', 'multiple')),
  CONSTRAINT "quote_option_groups_selections_check" CHECK (
    "minimum_selections" BETWEEN 0 AND 100 AND "maximum_selections" BETWEEN 1 AND 100
    AND "minimum_selections" <= "maximum_selections"
    AND ("mode" <> 'single' OR "maximum_selections" = 1)
  ),
  CONSTRAINT "quote_option_groups_display_order_check" CHECK ("display_order" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "quote_option_groups_id_version_key" ON "quote_version_option_groups" ("id", "quote_version_id");
CREATE UNIQUE INDEX "quote_option_groups_version_group_key" ON "quote_version_option_groups" ("quote_version_id", "group_key");
CREATE UNIQUE INDEX "quote_option_groups_version_order_key" ON "quote_version_option_groups" ("quote_version_id", "display_order");

CREATE TABLE "quote_version_line_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE CASCADE,
  "line_key" varchar(80) NOT NULL,
  "catalog_key" varchar(120),
  "name" varchar(240) NOT NULL,
  "description" text,
  "quantity" numeric(12,3) DEFAULT 1 NOT NULL,
  "unit" varchar(40) NOT NULL,
  "unit_price_min_cents" integer NOT NULL,
  "unit_price_max_cents" integer NOT NULL,
  "amount_min_cents" integer NOT NULL,
  "amount_max_cents" integer NOT NULL,
  "option_group_id" uuid,
  "selected_by_default" boolean DEFAULT false NOT NULL,
  "display_order" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_version_line_items_amounts_check" CHECK (
    "quantity" > 0 AND "quantity" <= 1000000
    AND "unit_price_min_cents" >= 0 AND "unit_price_max_cents" >= "unit_price_min_cents"
    AND "amount_min_cents" >= 0 AND "amount_max_cents" >= "amount_min_cents"
  ),
  CONSTRAINT "quote_version_line_items_option_check" CHECK ("option_group_id" IS NOT NULL OR "selected_by_default" = false),
  CONSTRAINT "quote_version_line_items_display_order_check" CHECK ("display_order" BETWEEN 0 AND 10000),
  CONSTRAINT "quote_line_items_option_group_fk" FOREIGN KEY ("option_group_id", "quote_version_id") REFERENCES "quote_version_option_groups"("id", "quote_version_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "quote_line_items_version_line_key" ON "quote_version_line_items" ("quote_version_id", "line_key");
CREATE UNIQUE INDEX "quote_line_items_version_order_key" ON "quote_version_line_items" ("quote_version_id", "display_order");

CREATE TABLE "quote_version_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE CASCADE,
  "adjustment_key" varchar(80) NOT NULL,
  "kind" text NOT NULL,
  "label" varchar(240) NOT NULL,
  "calculation" text NOT NULL,
  "basis" text DEFAULT 'subtotal' NOT NULL,
  "eligible_line_item_keys" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "amount_cents" integer,
  "basis_points" integer,
  "amount_min_cents" integer NOT NULL,
  "amount_max_cents" integer NOT NULL,
  "display_order" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_version_adjustments_kind_check" CHECK ("kind" IN ('discount', 'fee', 'travel')),
  CONSTRAINT "quote_version_adjustments_calculation_check" CHECK (
    ("calculation" = 'fixed' AND "amount_cents" IS NOT NULL AND "amount_cents" >= 0 AND "basis_points" IS NULL)
    OR ("calculation" = 'percentage' AND "amount_cents" IS NULL AND "basis_points" BETWEEN 1 AND 10000)
  ),
  CONSTRAINT "quote_version_adjustments_basis_check" CHECK (
    ("basis" = 'subtotal' AND cardinality("eligible_line_item_keys") = 0)
    OR ("basis" = 'line_items' AND cardinality("eligible_line_item_keys") > 0)
  ),
  CONSTRAINT "quote_version_adjustments_computed_amount_check" CHECK ("amount_min_cents" >= 0 AND "amount_max_cents" >= "amount_min_cents"),
  CONSTRAINT "quote_version_adjustments_display_order_check" CHECK ("display_order" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "quote_adjustments_version_adjustment_key" ON "quote_version_adjustments" ("quote_version_id", "adjustment_key");
CREATE UNIQUE INDEX "quote_adjustments_version_order_key" ON "quote_version_adjustments" ("quote_version_id", "display_order");

CREATE TABLE "quote_version_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE CASCADE,
  "media_asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE RESTRICT,
  "position" integer DEFAULT 0 NOT NULL,
  "label" text,
  "description" text,
  "customer_visible" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attached_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_version_attachments_position_check" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "quote_version_attachments_version_asset_key" ON "quote_version_attachments" ("quote_version_id", "media_asset_id");
CREATE UNIQUE INDEX "quote_version_attachments_version_position_key" ON "quote_version_attachments" ("quote_version_id", "position");

CREATE TABLE "quote_version_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "storage_provider" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_object_key" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "generated_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "generated_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_version_documents_kind_check" CHECK ("kind" IN ('proposal_pdf', 'acceptance_pdf', 'other')),
  CONSTRAINT "quote_version_documents_byte_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "quote_version_documents_hash_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "quote_version_documents_storage_key" ON "quote_version_documents" ("storage_provider", "storage_bucket", "storage_object_key");
CREATE INDEX "quote_version_documents_version_kind_idx" ON "quote_version_documents" ("quote_version_id", "kind", "generated_at");

CREATE TABLE "quote_capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "recipient_role" text NOT NULL,
  "recipient_address_hash" varchar(64) NOT NULL,
  "allowed_actions" text[] DEFAULT ARRAY['view']::text[] NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "read_expires_at" timestamptz NOT NULL,
  "action_expires_at" timestamptz,
  "issued_at" timestamptz DEFAULT now() NOT NULL,
  "issued_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz,
  "revoked_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "revocation_reason" text,
  "superseded_at" timestamptz,
  "superseded_by_capability_id" uuid,
  "last_used_at" timestamptz,
  "use_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_capabilities_quote_version_match" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_capabilities_superseded_by_id_fk" FOREIGN KEY ("superseded_by_capability_id") REFERENCES "quote_capabilities"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_capabilities_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_capabilities_recipient_role_check" CHECK ("recipient_role" IN ('signer', 'cc', 'bcc')),
  CONSTRAINT "quote_capabilities_recipient_hash_check" CHECK ("recipient_address_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_capabilities_status_check" CHECK ("status" IN ('active', 'revoked', 'superseded')),
  CONSTRAINT "quote_capabilities_actions_check" CHECK (
    cardinality("allowed_actions") > 0
    AND "allowed_actions" <@ ARRAY['view', 'pdf', 'change', 'accept', 'decline', 'availability', 'hold', 'checkout', 'book']::text[]
    AND ("recipient_role" = 'signer' OR NOT ("allowed_actions" && ARRAY['change', 'accept', 'decline', 'availability', 'hold', 'checkout', 'book']::text[]))
  ),
  CONSTRAINT "quote_capabilities_use_count_check" CHECK ("use_count" >= 0),
  CONSTRAINT "quote_capabilities_supersession_check" CHECK ("superseded_by_capability_id" IS NULL OR "superseded_by_capability_id" <> "id"),
  CONSTRAINT "quote_capabilities_lifecycle_check" CHECK (
    ("status" <> 'revoked' OR ("revoked_at" IS NOT NULL AND nullif(btrim("revocation_reason"), '') IS NOT NULL))
    AND ("status" <> 'superseded' OR ("superseded_at" IS NOT NULL AND "superseded_by_capability_id" IS NOT NULL))
    AND "read_expires_at" > "issued_at"
    AND ("action_expires_at" IS NULL OR ("action_expires_at" > "issued_at" AND "action_expires_at" <= "read_expires_at"))
  )
);
CREATE UNIQUE INDEX "quote_capabilities_token_hash_key" ON "quote_capabilities" ("token_hash");
CREATE UNIQUE INDEX "quote_capabilities_active_recipient_key" ON "quote_capabilities" ("quote_version_id", "recipient_address_hash") WHERE "status" = 'active';
CREATE INDEX "quote_capabilities_quote_status_idx" ON "quote_capabilities" ("quote_id", "status", "created_at");
CREATE INDEX "quote_capabilities_version_idx" ON "quote_capabilities" ("quote_version_id");
CREATE INDEX "quote_capabilities_read_expires_idx" ON "quote_capabilities" ("read_expires_at");

CREATE TABLE "quote_send_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "capability_id" uuid REFERENCES "quote_capabilities"("id") ON DELETE SET NULL,
  "attempt_number" integer NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "recipient_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "message_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "requested_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "correlation_id" text,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "last_error_code" text,
  "last_error_detail" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_send_attempts_quote_version_match" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_send_attempts_attempt_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "quote_send_attempts_key_hash_check" CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_send_attempts_status_check" CHECK ("status" IN ('requested', 'processing', 'partial', 'succeeded', 'failed', 'reconciliation_required', 'canceled')),
  CONSTRAINT "quote_send_attempts_snapshot_shape_check" CHECK (jsonb_typeof("recipient_manifest") = 'array' AND jsonb_typeof("message_snapshot") = 'object')
);
CREATE UNIQUE INDEX "quote_send_attempts_version_attempt_key" ON "quote_send_attempts" ("quote_version_id", "attempt_number");
CREATE UNIQUE INDEX "quote_send_attempts_version_idempotency_key" ON "quote_send_attempts" ("quote_version_id", "idempotency_key_hash");
CREATE INDEX "quote_send_attempts_status_requested_idx" ON "quote_send_attempts" ("status", "requested_at");

CREATE TABLE "quote_send_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "send_attempt_id" uuid NOT NULL REFERENCES "quote_send_attempts"("id") ON DELETE RESTRICT,
  "channel" text NOT NULL,
  "recipient_role" text NOT NULL,
  "recipient_address_hash" varchar(64) NOT NULL,
  "recipient_display_hint" text,
  "encrypted_provider_payload" text NOT NULL,
  "encryption_key_id" text NOT NULL,
  "channel_attempt_number" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "provider" text,
  "provider_message_id" text,
  "provider_request_key" text,
  "external_message_dispatch_id" uuid REFERENCES "external_message_dispatches"("id") ON DELETE SET NULL,
  "conversation_thread_id" uuid REFERENCES "conversation_threads"("id") ON DELETE SET NULL,
  "conversation_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE SET NULL,
  "error_code" text,
  "error_detail" text,
  "queued_at" timestamptz DEFAULT now() NOT NULL,
  "dispatched_at" timestamptz,
  "delivered_at" timestamptz,
  "failed_at" timestamptz,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_send_deliveries_channel_check" CHECK ("channel" IN ('email', 'sms')),
  CONSTRAINT "quote_send_deliveries_recipient_role_check" CHECK ("recipient_role" IN ('signer', 'cc', 'bcc')),
  CONSTRAINT "quote_send_deliveries_address_hash_check" CHECK ("recipient_address_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_send_deliveries_channel_attempt_check" CHECK ("channel_attempt_number" > 0),
  CONSTRAINT "quote_send_deliveries_status_check" CHECK ("status" IN ('queued', 'dispatched', 'delivered', 'failed', 'reconciliation_required', 'suppressed'))
);
CREATE UNIQUE INDEX "quote_send_deliveries_attempt_channel_address_key" ON "quote_send_deliveries" ("send_attempt_id", "channel", "recipient_address_hash", "channel_attempt_number");
CREATE UNIQUE INDEX "quote_send_deliveries_provider_message_key" ON "quote_send_deliveries" ("provider", "provider_message_id") WHERE "provider" IS NOT NULL AND "provider_message_id" IS NOT NULL;
CREATE UNIQUE INDEX "quote_send_deliveries_dispatch_key" ON "quote_send_deliveries" ("external_message_dispatch_id") WHERE "external_message_dispatch_id" IS NOT NULL;
CREATE INDEX "quote_send_deliveries_conversation_idx" ON "quote_send_deliveries" ("conversation_thread_id", "created_at");
CREATE INDEX "quote_send_deliveries_status_queued_idx" ON "quote_send_deliveries" ("status", "queued_at");

CREATE TABLE "quote_responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "quote_version_id" uuid NOT NULL REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "response_type" text NOT NULL,
  "source" text NOT NULL,
  "team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "change_request_id" uuid REFERENCES "quote_change_requests"("id") ON DELETE SET NULL,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "signer_snapshot" jsonb,
  "configuration_snapshot" jsonb,
  "selected_option_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "reason" text,
  "message" text,
  "consent_text" text,
  "consent_version" text,
  "consent_affirmed" boolean,
  "configuration_hash" varchar(64),
  "consent_hash" varchar(64),
  "content_hash" varchar(64),
  "issued_pdf_hash" varchar(64),
  "accepted_total_min_cents" integer,
  "accepted_total_max_cents" integer,
  "accepted_deposit_cents" integer,
  "accepted_balance_min_cents" integer,
  "accepted_balance_max_cents" integer,
  "idempotency_key_hash" varchar(64),
  "request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "responded_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_responses_quote_version_match" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_responses_type_check" CHECK ("response_type" IN ('accepted', 'declined', 'change_requested', 'refresh_requested')),
  CONSTRAINT "quote_responses_source_check" CHECK ("source" IN ('customer', 'team_member', 'system')),
  CONSTRAINT "quote_responses_actor_check" CHECK ("source" <> 'team_member' OR "team_member_id" IS NOT NULL),
  CONSTRAINT "quote_responses_change_request_check" CHECK ("response_type" <> 'change_requested' OR "change_request_id" IS NOT NULL),
  CONSTRAINT "quote_responses_hashes_check" CHECK (
    ("configuration_hash" IS NULL OR "configuration_hash" ~ '^[0-9a-f]{64}$')
    AND ("consent_hash" IS NULL OR "consent_hash" ~ '^[0-9a-f]{64}$')
    AND ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$')
    AND ("issued_pdf_hash" IS NULL OR "issued_pdf_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "quote_responses_acceptance_evidence_check" CHECK (
    "response_type" <> 'accepted' OR (
      "signer_snapshot" IS NOT NULL AND "configuration_snapshot" IS NOT NULL
      AND "consent_text" IS NOT NULL AND "consent_version" IS NOT NULL AND "consent_affirmed" IS TRUE
      AND "configuration_hash" IS NOT NULL AND "consent_hash" IS NOT NULL
      AND "content_hash" IS NOT NULL AND "issued_pdf_hash" IS NOT NULL
      AND "accepted_total_min_cents" IS NOT NULL AND "accepted_total_max_cents" IS NOT NULL
      AND "accepted_deposit_cents" IS NOT NULL AND "accepted_balance_min_cents" IS NOT NULL
      AND "accepted_balance_max_cents" IS NOT NULL
      AND "accepted_total_min_cents" > 0 AND "accepted_total_max_cents" >= "accepted_total_min_cents"
      AND "accepted_deposit_cents" BETWEEN 0 AND "accepted_total_min_cents"
      AND "accepted_balance_min_cents" = "accepted_total_min_cents" - "accepted_deposit_cents"
      AND "accepted_balance_max_cents" = "accepted_total_max_cents" - "accepted_deposit_cents"
    )
  ),
  CONSTRAINT "quote_responses_decline_evidence_check" CHECK ("response_type" <> 'declined' OR "signer_snapshot" IS NOT NULL),
  CONSTRAINT "quote_responses_snapshot_shape_check" CHECK (
    ("signer_snapshot" IS NULL OR jsonb_typeof("signer_snapshot") = 'object')
    AND ("configuration_snapshot" IS NULL OR jsonb_typeof("configuration_snapshot") = 'object')
  ),
  CONSTRAINT "quote_responses_idempotency_hash_check" CHECK ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "quote_responses_terminal_version_key" ON "quote_responses" ("quote_version_id") WHERE "response_type" IN ('accepted', 'declined');
CREATE UNIQUE INDEX "quote_responses_version_idempotency_key" ON "quote_responses" ("quote_version_id", "idempotency_key_hash") WHERE "idempotency_key_hash" IS NOT NULL;
CREATE INDEX "quote_responses_quote_history_idx" ON "quote_responses" ("quote_id", "responded_at");

CREATE TABLE "quote_activity_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE RESTRICT,
  "quote_version_id" uuid REFERENCES "quote_versions"("id") ON DELETE RESTRICT,
  "event_type" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "outbox_event_id" uuid REFERENCES "outbox_events"("id") ON DELETE SET NULL,
  "correlation_id" text,
  "causation_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_activity_events_quote_version_match" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  CONSTRAINT "quote_activity_events_actor_type_check" CHECK ("actor_type" IN ('customer', 'team_member', 'system', 'worker')),
  CONSTRAINT "quote_activity_events_actor_check" CHECK ("actor_type" <> 'team_member' OR "actor_team_member_id" IS NOT NULL)
);
CREATE INDEX "quote_activity_events_quote_history_idx" ON "quote_activity_events" ("quote_id", "occurred_at", "id");
CREATE INDEX "quote_activity_events_version_history_idx" ON "quote_activity_events" ("quote_version_id", "occurred_at");
CREATE INDEX "quote_activity_events_type_idx" ON "quote_activity_events" ("event_type", "occurred_at");

CREATE TABLE "quote_public_rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL,
  "scope_key_hash" varchar(64) NOT NULL,
  "window_start" timestamptz NOT NULL,
  "window_seconds" integer NOT NULL,
  "request_count" integer DEFAULT 0 NOT NULL,
  "blocked_until" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_public_rate_limits_hash_check" CHECK ("scope_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_public_rate_limits_window_check" CHECK ("window_seconds" > 0 AND "request_count" >= 0)
);
CREATE UNIQUE INDEX "quote_public_rate_limits_scope_key_window_key" ON "quote_public_rate_limits" ("scope", "scope_key_hash", "window_start", "window_seconds");
CREATE INDEX "quote_public_rate_limits_blocked_idx" ON "quote_public_rate_limits" ("blocked_until");

-- Backfill state is resumable and ambiguous legacy records are quarantined.
-- Cursor/details payloads are application-sanitized and must never contain raw
-- share tokens, secrets, provider payloads, or network addresses.
CREATE TABLE "quote_migration_checkpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_key" varchar(120) NOT NULL,
  "checkpoint_key" varchar(120) NOT NULL,
  "cursor" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "scanned_count" integer DEFAULT 0 NOT NULL,
  "migrated_count" integer DEFAULT 0 NOT NULL,
  "review_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error_detail" text,
  "started_at" timestamptz,
  "last_heartbeat_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_migration_checkpoints_status_check" CHECK ("status" IN ('pending', 'running', 'paused', 'completed', 'failed')),
  CONSTRAINT "quote_migration_checkpoints_counts_check" CHECK (
    "scanned_count" >= 0 AND "migrated_count" >= 0 AND "review_count" >= 0 AND "skipped_count" >= 0
    AND "migrated_count" + "review_count" + "skipped_count" <= "scanned_count"
  ),
  CONSTRAINT "quote_migration_checkpoints_lifecycle_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "quote_migration_checkpoints_job_checkpoint_key" ON "quote_migration_checkpoints" ("job_key", "checkpoint_key");
CREATE INDEX "quote_migration_checkpoints_status_heartbeat_idx" ON "quote_migration_checkpoints" ("status", "last_heartbeat_at");

CREATE TABLE "quote_migration_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "legacy_entity_type" varchar(80) NOT NULL,
  "legacy_entity_id" varchar(200) NOT NULL,
  "reason_code" varchar(120) NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolved_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_migration_review_items_status_check" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT "quote_migration_review_items_resolution_check" CHECK ("status" = 'open' OR ("resolved_at" IS NOT NULL AND nullif(btrim("resolution"), '') IS NOT NULL))
);
CREATE UNIQUE INDEX "quote_migration_review_items_entity_reason_key" ON "quote_migration_review_items" ("legacy_entity_type", "legacy_entity_id", "reason_code");
CREATE INDEX "quote_migration_review_items_status_created_idx" ON "quote_migration_review_items" ("status", "created_at");

-- Nullable compatibility links keep all legacy change requests and payments valid.
ALTER TABLE "quote_change_requests"
  ADD COLUMN "quote_version_id" uuid,
  ADD COLUMN "expected_revision" integer,
  ADD COLUMN "request_key_hash" varchar(64),
  ADD COLUMN "status" text,
  ADD COLUMN "resolved_by_team_member_id" uuid,
  ADD COLUMN "resolution_note" text,
  ADD COLUMN "resolved_at" timestamptz,
  ADD CONSTRAINT "quote_change_requests_version_id_fk" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "quote_change_requests_resolved_by_fk" FOREIGN KEY ("resolved_by_team_member_id") REFERENCES "team_members"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "quote_change_requests_expected_revision_check" CHECK ("expected_revision" IS NULL OR "expected_revision" > 0),
  ADD CONSTRAINT "quote_change_requests_request_key_hash_check" CHECK ("request_key_hash" IS NULL OR "request_key_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "quote_change_requests_status_check" CHECK ("status" IS NULL OR "status" IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  ADD CONSTRAINT "quote_change_requests_resolution_check" CHECK (("status" IS NULL OR "status" IN ('open', 'acknowledged')) OR "resolved_at" IS NOT NULL);
CREATE INDEX "quote_change_requests_version_status_idx" ON "quote_change_requests" ("quote_version_id", "status", "created_at");
CREATE UNIQUE INDEX "quote_change_requests_request_key" ON "quote_change_requests" ("quote_version_id", "request_key_hash") WHERE "quote_version_id" IS NOT NULL AND "request_key_hash" IS NOT NULL;

ALTER TABLE "payment_attempts"
  ADD COLUMN "quote_id" uuid,
  ADD COLUMN "quote_version_id" uuid,
  ADD COLUMN "quote_payment_kind" text,
  ADD CONSTRAINT "payment_attempts_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempts_quote_version_id_fk" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempts_quote_link_check" CHECK ("quote_version_id" IS NULL OR "quote_id" IS NOT NULL),
  ADD CONSTRAINT "payment_attempts_quote_payment_kind_check" CHECK ("quote_payment_kind" IS NULL OR ("quote_version_id" IS NOT NULL AND "quote_payment_kind" IN ('deposit', 'balance', 'full', 'adjustment')));
CREATE INDEX "payment_attempts_quote_version_idx" ON "payment_attempts" ("quote_version_id", "quote_payment_kind", "created_at");

ALTER TABLE "payments"
  ADD COLUMN "quote_id" uuid,
  ADD COLUMN "quote_version_id" uuid,
  ADD COLUMN "quote_payment_kind" text,
  ADD CONSTRAINT "payments_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payments_quote_version_id_fk" FOREIGN KEY ("quote_version_id", "quote_id") REFERENCES "quote_versions"("id", "quote_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "payments_quote_link_check" CHECK ("quote_version_id" IS NULL OR "quote_id" IS NOT NULL),
  ADD CONSTRAINT "payments_quote_payment_kind_check" CHECK ("quote_payment_kind" IS NULL OR ("quote_version_id" IS NOT NULL AND "quote_payment_kind" IN ('deposit', 'balance', 'full', 'adjustment')));
CREATE INDEX "payments_quote_version_idx" ON "payments" ("quote_version_id", "quote_payment_kind", "created_at");

CREATE OR REPLACE FUNCTION "quote_v2_guard_opportunity_status"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'approved' AND NEW."status" = 'open' THEN
    RAISE EXCEPTION 'approved opportunity cannot regress to open';
  END IF;
  IF OLD."status" IN ('won', 'lost') AND NEW."status" NOT IN (OLD."status", 'archived') THEN
    RAISE EXCEPTION 'closed opportunity cannot regress from % to %', OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'archived' AND NEW."status" <> 'archived' THEN
    RAISE EXCEPTION 'archived opportunity cannot be reopened';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'opportunity status changes require a higher revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_opportunities_status_transition_guard"
  BEFORE UPDATE ON "sales_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_opportunity_status"();

CREATE OR REPLACE FUNCTION "quote_v2_guard_aggregate_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."engine_version" = 'v2' AND NEW."engine_version" <> 'v2' THEN
    RAISE EXCEPTION 'a V2 quote cannot return to the legacy engine';
  END IF;
  IF OLD."engine_version" <> 'v2' OR NEW."aggregate_state" IS NOT DISTINCT FROM OLD."aggregate_state" THEN
    RETURN NEW;
  END IF;
  IF NEW."aggregate_revision" <= OLD."aggregate_revision" THEN
    RAISE EXCEPTION 'quote aggregate state changes require a higher revision';
  END IF;
  IF (OLD."aggregate_state" = 'draft' AND NEW."aggregate_state" NOT IN ('open', 'voided', 'archived'))
    OR (OLD."aggregate_state" = 'open' AND NEW."aggregate_state" NOT IN ('accepted', 'declined', 'voided', 'archived'))
    OR (OLD."aggregate_state" IN ('accepted', 'declined', 'voided') AND NEW."aggregate_state" <> 'archived')
    OR OLD."aggregate_state" = 'archived' THEN
    RAISE EXCEPTION 'illegal quote aggregate state transition: % -> %', OLD."aggregate_state", NEW."aggregate_state";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quotes_v2_aggregate_transition_guard"
  BEFORE UPDATE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_aggregate_transition"();

-- Drafts are editable. Ready/issued content and its children are immutable; only
-- explicit lifecycle state transitions remain legal on the aggregate root.
CREATE OR REPLACE FUNCTION "quote_v2_guard_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" <> 'draft' THEN
      RAISE EXCEPTION 'non-draft quote version % is immutable', OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(
    NEW."canonical_render_json", NEW."document_schema_hash", NEW."pricing_hash",
    NEW."template_hash", NEW."content_hash"
  ) IS DISTINCT FROM ROW(
    OLD."canonical_render_json", OLD."document_schema_hash", OLD."pricing_hash",
    OLD."template_hash", OLD."content_hash"
  ) AND NOT (
    OLD."state" = 'draft' AND NEW."state" = 'ready'
  ) THEN
    RAISE EXCEPTION 'canonical quote content may only be frozen during draft to ready transition';
  END IF;

  IF OLD."state" = 'draft' THEN
    IF NEW."state" NOT IN ('draft', 'ready', 'voided') THEN
      RAISE EXCEPTION 'draft quote version must become ready before issue';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."quote_id", NEW."version_number", NEW."draft_revision", NEW."supersedes_version_id",
    NEW."provenance", NEW."schema_version", NEW."document_type", NEW."audience",
    NEW."scheduling_mode", NEW."currency", NEW."document_snapshot", NEW."party_snapshot",
    NEW."issuer_snapshot", NEW."terms_snapshot",
    NEW."client_name", NEW."client_company",
    NEW."client_email", NEW."client_phone", NEW."project_name", NEW."purchase_order_number",
    NEW."reference_number", NEW."selected_option_ids", NEW."subtotal_min_cents", NEW."subtotal_max_cents",
    NEW."discount_min_cents", NEW."discount_max_cents", NEW."fee_min_cents", NEW."fee_max_cents",
    NEW."total_min_cents", NEW."total_max_cents", NEW."deposit_cents",
    NEW."balance_min_cents", NEW."balance_max_cents",
    NEW."scope", NEW."assumptions", NEW."exclusions", NEW."terms", NEW."payment_terms",
    NEW."internal_notes", NEW."ready_at",
    NEW."created_by_team_member_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."quote_id", OLD."version_number", OLD."draft_revision", OLD."supersedes_version_id",
    OLD."provenance", OLD."schema_version", OLD."document_type", OLD."audience",
    OLD."scheduling_mode", OLD."currency", OLD."document_snapshot", OLD."party_snapshot",
    OLD."issuer_snapshot", OLD."terms_snapshot",
    OLD."client_name", OLD."client_company",
    OLD."client_email", OLD."client_phone", OLD."project_name", OLD."purchase_order_number",
    OLD."reference_number", OLD."selected_option_ids", OLD."subtotal_min_cents", OLD."subtotal_max_cents",
    OLD."discount_min_cents", OLD."discount_max_cents", OLD."fee_min_cents", OLD."fee_max_cents",
    OLD."total_min_cents", OLD."total_max_cents", OLD."deposit_cents",
    OLD."balance_min_cents", OLD."balance_max_cents",
    OLD."scope", OLD."assumptions", OLD."exclusions", OLD."terms", OLD."payment_terms",
    OLD."internal_notes", OLD."ready_at",
    OLD."created_by_team_member_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'non-draft quote version % content is immutable', OLD."id";
  END IF;

  IF ROW(NEW."valid_from", NEW."expires_at", NEW."issued_at") IS DISTINCT FROM ROW(OLD."valid_from", OLD."expires_at", OLD."issued_at")
    AND NOT (OLD."state" = 'ready' AND NEW."state" = 'issued') THEN
    RAISE EXCEPTION 'quote validity evidence may only be set during ready to issued transition';
  END IF;
  IF OLD."first_sent_at" IS NOT NULL AND NEW."first_sent_at" IS DISTINCT FROM OLD."first_sent_at" THEN
    RAISE EXCEPTION 'first sent timestamp is immutable';
  END IF;

  IF (OLD."state" = 'ready' AND NEW."state" NOT IN ('ready', 'issued', 'voided'))
    OR (OLD."state" = 'issued' AND NEW."state" NOT IN ('issued', 'superseded', 'accepted', 'expired', 'declined', 'voided'))
    OR (OLD."state" IN ('superseded', 'accepted', 'declined', 'expired', 'voided') AND NEW."state" <> OLD."state") THEN
    RAISE EXCEPTION 'illegal quote version state transition: % -> %', OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quote_versions_immutable_after_ready"
  BEFORE UPDATE OR DELETE ON "quote_versions"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_version_mutation"();

CREATE OR REPLACE FUNCTION "quote_v2_guard_version_child_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_version_id uuid;
  target_version_id uuid;
  source_state text;
  target_state text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    source_version_id := OLD."quote_version_id";
    SELECT "state" INTO source_state FROM "quote_versions" WHERE "id" = source_version_id;
    IF source_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'children of non-draft quote version % are immutable', source_version_id;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    target_version_id := NEW."quote_version_id";
    SELECT "state" INTO target_state FROM "quote_versions" WHERE "id" = target_version_id;
    IF target_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'children require a draft quote version: %', target_version_id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quote_version_option_groups_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_version_option_groups"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_version_child_mutation"();
CREATE TRIGGER "quote_version_line_items_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_version_line_items"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_version_child_mutation"();
CREATE TRIGGER "quote_version_adjustments_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_version_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_version_child_mutation"();
CREATE TRIGGER "quote_version_attachments_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_version_attachments"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_version_child_mutation"();

CREATE OR REPLACE FUNCTION "quote_v2_reject_evidence_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable evidence; append a correction instead', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "quote_version_documents_immutable"
  BEFORE UPDATE OR DELETE ON "quote_version_documents"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_reject_evidence_mutation"();
CREATE TRIGGER "quote_responses_immutable"
  BEFORE UPDATE OR DELETE ON "quote_responses"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_reject_evidence_mutation"();
CREATE TRIGGER "quote_activity_events_immutable"
  BEFORE UPDATE OR DELETE ON "quote_activity_events"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_reject_evidence_mutation"();
