CREATE TABLE IF NOT EXISTS "team_pipeline_filter_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL,
  "name" varchar(60) NOT NULL,
  "name_normalized" varchar(60) NOT NULL,
  "search_query" varchar(120) DEFAULT '' NOT NULL,
  "stage" "crm_pipeline_stage",
  "exclude_outbound" boolean DEFAULT true NOT NULL,
  "view" varchar(8) DEFAULT 'board' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_pipeline_filter_presets_member_fk"
    FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id")
    ON DELETE CASCADE,
  CONSTRAINT "team_pipeline_filter_presets_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  CONSTRAINT "team_pipeline_filter_presets_normalized_name_check"
    CHECK (
      char_length(btrim("name_normalized")) BETWEEN 1 AND 60
      AND "name_normalized" = lower("name_normalized")
    ),
  CONSTRAINT "team_pipeline_filter_presets_search_check"
    CHECK (char_length("search_query") <= 120),
  CONSTRAINT "team_pipeline_filter_presets_view_check"
    CHECK ("view" IN ('board', 'list')),
  CONSTRAINT "team_pipeline_filter_presets_version_check"
    CHECK ("version" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_pipeline_filter_presets_member_name_key"
  ON "team_pipeline_filter_presets" ("team_member_id", "name_normalized");

CREATE INDEX IF NOT EXISTS "team_pipeline_filter_presets_member_updated_idx"
  ON "team_pipeline_filter_presets" ("team_member_id", "updated_at", "id");

CREATE INDEX IF NOT EXISTS "outbox_pipeline_movement_contact_created_idx"
  ON "outbox_events" (("payload"->>'contactId'), "created_at" DESC)
  WHERE "type" = 'pipeline.auto_stage_change';
