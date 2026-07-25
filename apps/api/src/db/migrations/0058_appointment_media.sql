-- Quoted-work media foundation. This release is independent of payments.
ALTER TABLE "appointments"
  ADD COLUMN "quoted_scope_text" varchar(4000);
--> statement-breakpoint

CREATE TABLE "media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "storage_provider" text DEFAULT 'r2' NOT NULL,
  "storage_bucket" text NOT NULL,
  "original_object_key" text NOT NULL,
  "display_object_key" text,
  "thumbnail_object_key" text,
  "source" text DEFAULT 'manual' NOT NULL,
  "source_key" text,
  "status" text DEFAULT 'staging' NOT NULL,
  "original_filename" text,
  "content_type" text,
  "byte_size" integer,
  "width" integer,
  "height" integer,
  "sha256" varchar(64),
  "uploaded_by_member_id" uuid,
  "contact_id" uuid,
  "source_message_id" uuid,
  "source_media_index" integer,
  "source_metadata" jsonb,
  "staging_expires_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "processing_error" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "appointment_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "appointment_id" uuid NOT NULL,
  "media_asset_id" uuid NOT NULL,
  "purpose" text DEFAULT 'quoted_work' NOT NULL,
  "caption" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_cover" boolean DEFAULT false NOT NULL,
  "attached_by_member_id" uuid,
  "attachment_source" text DEFAULT 'manual' NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "instant_quote_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instant_quote_id" uuid NOT NULL,
  "media_asset_id" uuid NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "mobile_offline_media_queue_health" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL,
  "client_device_id" uuid NOT NULL,
  "queued_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "oldest_queued_at" timestamp with time zone,
  "client_reported_at" timestamp with time zone NOT NULL,
  "last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mobile_offline_media_queue_health_queued_count_check"
    CHECK ("queued_count" BETWEEN 0 AND 10000),
  CONSTRAINT "mobile_offline_media_queue_health_failed_count_check"
    CHECK ("failed_count" BETWEEN 0 AND "queued_count"),
  CONSTRAINT "mobile_offline_media_queue_health_queue_state_check"
    CHECK (
      ("queued_count" = 0 AND "failed_count" = 0 AND "oldest_queued_at" IS NULL)
      OR
      ("queued_count" > 0 AND "oldest_queued_at" IS NOT NULL)
    )
);
--> statement-breakpoint

ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_uploaded_by_member_id_team_members_id_fk"
  FOREIGN KEY ("uploaded_by_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_source_message_id_conversation_messages_id_fk"
  FOREIGN KEY ("source_message_id") REFERENCES "public"."conversation_messages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_media"
  ADD CONSTRAINT "appointment_media_appointment_id_appointments_id_fk"
  FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_media"
  ADD CONSTRAINT "appointment_media_media_asset_id_media_assets_id_fk"
  FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_media"
  ADD CONSTRAINT "appointment_media_attached_by_member_id_team_members_id_fk"
  FOREIGN KEY ("attached_by_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instant_quote_media"
  ADD CONSTRAINT "instant_quote_media_instant_quote_id_instant_quotes_id_fk"
  FOREIGN KEY ("instant_quote_id") REFERENCES "public"."instant_quotes"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instant_quote_media"
  ADD CONSTRAINT "instant_quote_media_media_asset_id_media_assets_id_fk"
  FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mobile_offline_media_queue_health"
  ADD CONSTRAINT "mobile_offline_media_queue_health_team_member_id_team_members_id_fk"
  FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "media_assets_source_key_key"
  ON "media_assets" USING btree ("source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_original_object_key_key"
  ON "media_assets" USING btree ("storage_bucket", "original_object_key");
--> statement-breakpoint
CREATE INDEX "media_assets_contact_idx"
  ON "media_assets" USING btree ("contact_id", "created_at");
--> statement-breakpoint
CREATE INDEX "media_assets_source_message_idx"
  ON "media_assets" USING btree ("source_message_id");
--> statement-breakpoint
CREATE INDEX "media_assets_uploader_idx"
  ON "media_assets" USING btree ("uploaded_by_member_id", "created_at");
--> statement-breakpoint
CREATE INDEX "media_assets_status_idx"
  ON "media_assets" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "media_assets_staging_expires_idx"
  ON "media_assets" USING btree ("staging_expires_at");
--> statement-breakpoint
CREATE INDEX "media_assets_deleted_idx"
  ON "media_assets" USING btree ("deleted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_media_appointment_asset_key"
  ON "appointment_media" USING btree ("appointment_id", "media_asset_id");
--> statement-breakpoint
CREATE INDEX "appointment_media_appointment_idx"
  ON "appointment_media" USING btree ("appointment_id", "purpose", "sort_order");
--> statement-breakpoint
CREATE INDEX "appointment_media_asset_idx"
  ON "appointment_media" USING btree ("media_asset_id");
--> statement-breakpoint
CREATE INDEX "appointment_media_deleted_idx"
  ON "appointment_media" USING btree ("deleted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_media_active_cover_key"
  ON "appointment_media" USING btree ("appointment_id")
  WHERE "is_cover" = true AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "instant_quote_media_quote_asset_key"
  ON "instant_quote_media" USING btree ("instant_quote_id", "media_asset_id");
--> statement-breakpoint
CREATE INDEX "instant_quote_media_quote_idx"
  ON "instant_quote_media" USING btree ("instant_quote_id", "sort_order");
--> statement-breakpoint
CREATE INDEX "instant_quote_media_asset_idx"
  ON "instant_quote_media" USING btree ("media_asset_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_offline_media_queue_health_member_device_key"
  ON "mobile_offline_media_queue_health" USING btree ("team_member_id", "client_device_id");
--> statement-breakpoint
CREATE INDEX "mobile_offline_media_queue_health_stale_idx"
  ON "mobile_offline_media_queue_health" USING btree ("oldest_queued_at")
  WHERE "queued_count" > 0;
--> statement-breakpoint
CREATE INDEX "mobile_offline_media_queue_health_last_reported_idx"
  ON "mobile_offline_media_queue_health" USING btree ("last_reported_at");
--> statement-breakpoint
