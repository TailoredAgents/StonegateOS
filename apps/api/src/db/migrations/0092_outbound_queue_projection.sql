-- Expansion-first projection for the outbound operator queue.
--
-- Outbound task metadata historically lives in line-oriented crm_tasks.notes.
-- Keep that format as the compatibility source during rollout, but project the
-- fields needed by filtering/pagination into typed columns that PostgreSQL can
-- filter and index without loading the queue into application memory.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "crm_tasks"
  ADD COLUMN IF NOT EXISTS "outbound_projection_version" integer,
  ADD COLUMN IF NOT EXISTS "outbound_is_outbound" boolean,
  ADD COLUMN IF NOT EXISTS "outbound_campaign" text,
  ADD COLUMN IF NOT EXISTS "outbound_attempt" integer,
  ADD COLUMN IF NOT EXISTS "outbound_last_disposition" text,
  ADD COLUMN IF NOT EXISTS "outbound_company" text,
  ADD COLUMN IF NOT EXISTS "outbound_note_snippet" text,
  ADD COLUMN IF NOT EXISTS "outbound_started_at" timestamptz;

ALTER TABLE "crm_tasks"
  DROP CONSTRAINT IF EXISTS "crm_tasks_outbound_attempt_positive";

ALTER TABLE "crm_tasks"
  DROP CONSTRAINT IF EXISTS "crm_tasks_outbound_projection_version_check";

ALTER TABLE "crm_tasks"
  ADD CONSTRAINT "crm_tasks_outbound_projection_version_check"
  CHECK (
    "outbound_projection_version" IS NULL
    OR "outbound_projection_version" = 1
  );

ALTER TABLE "crm_tasks"
  ADD CONSTRAINT "crm_tasks_outbound_attempt_positive"
  CHECK ("outbound_attempt" IS NULL OR "outbound_attempt" > 0);

CREATE OR REPLACE FUNCTION "crm_task_note_field"(
  note_text text,
  field_name text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT nullif(btrim(substr(line, strpos(line, '=') + 1)), '')
  FROM regexp_split_to_table(replace(coalesce(note_text, ''), E'\r\n', E'\n'), E'\n') AS line
  WHERE strpos(line, '=') > 0
    AND lower(btrim(split_part(line, '=', 1))) = lower(btrim(field_name))
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION "crm_task_note_timestamptz"(
  note_text text,
  field_name text
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  field_value text;
BEGIN
  field_value := "crm_task_note_field"(note_text, field_name);
  IF field_value IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN field_value::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END
$function$;

CREATE OR REPLACE FUNCTION "sync_crm_task_outbound_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  attempt_text text;
BEGIN
  NEW."outbound_projection_version" := 1;
  NEW."outbound_is_outbound" :=
    lower(coalesce("crm_task_note_field"(NEW."notes", 'kind'), '')) = 'outbound';

  IF NEW."outbound_is_outbound" THEN
    NEW."outbound_campaign" := "crm_task_note_field"(NEW."notes", 'campaign');
    NEW."outbound_last_disposition" := lower("crm_task_note_field"(NEW."notes", 'lastDisposition'));
    NEW."outbound_company" := "crm_task_note_field"(NEW."notes", 'company');
    NEW."outbound_note_snippet" := "crm_task_note_field"(NEW."notes", 'notes');

    attempt_text := "crm_task_note_field"(NEW."notes", 'attempt');
    IF attempt_text ~ '^[1-9][0-9]{0,8}$' THEN
      NEW."outbound_attempt" := attempt_text::integer;
    ELSE
      NEW."outbound_attempt" := 1;
    END IF;

    NEW."outbound_started_at" :=
      "crm_task_note_timestamptz"(NEW."notes", 'startedAt');
  ELSE
    NEW."outbound_campaign" := NULL;
    NEW."outbound_attempt" := NULL;
    NEW."outbound_last_disposition" := NULL;
    NEW."outbound_company" := NULL;
    NEW."outbound_note_snippet" := NULL;
    NEW."outbound_started_at" := NULL;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS "crm_tasks_outbound_projection_sync" ON "crm_tasks";

CREATE TRIGGER "crm_tasks_outbound_projection_sync"
BEFORE INSERT OR UPDATE OF "notes"
ON "crm_tasks"
FOR EACH ROW
EXECUTE FUNCTION "sync_crm_task_outbound_projection"();

-- Run the same compatibility parser for all existing rows. The application
-- continues to dual-read notes only when a projection is still NULL, allowing
-- migration-first deployment and safe rolling upgrades.
UPDATE "crm_tasks"
SET "notes" = "notes"
WHERE "outbound_projection_version" IS NULL;

-- The compatibility trigger assigns this flag for old and new writers. Making
-- it non-null after backfill lets PostgreSQL prove the partial-index predicate
-- while the application retains its NULL fallback during rolling deployment.
ALTER TABLE "crm_tasks"
  ALTER COLUMN "outbound_is_outbound" SET DEFAULT false,
  ALTER COLUMN "outbound_is_outbound" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_order_idx"
  ON "crm_tasks" ("assigned_to", "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_due_idx"
  ON "crm_tasks" ("assigned_to", "due_at", "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_account_idx"
  ON "crm_tasks" ("assigned_to", "partner_account_id", "contact_id", "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_campaign_idx"
  ON "crm_tasks" ("assigned_to", lower("outbound_campaign"), "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_attempt_idx"
  ON "crm_tasks" ("assigned_to", "outbound_attempt", "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_disposition_idx"
  ON "crm_tasks" ("assigned_to", lower("outbound_last_disposition"), "created_at", "id")
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "crm_tasks_outbound_queue_text_idx"
  ON "crm_tasks" USING gin (
    lower(coalesce("outbound_company", '') || ' ' || coalesce("outbound_note_snippet", '')) gin_trgm_ops
  )
  WHERE "status" = 'open' AND "outbound_is_outbound" IS TRUE;

CREATE INDEX IF NOT EXISTS "contacts_outbound_search_idx"
  ON "contacts" USING gin (
    lower(
      coalesce("first_name", '') || ' ' ||
      coalesce("last_name", '') || ' ' ||
      coalesce("email", '') || ' ' ||
      coalesce("phone", '') || ' ' ||
      coalesce("phone_e164", '')
    ) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "partner_accounts_outbound_search_idx"
  ON "partner_accounts" USING gin (lower("name") gin_trgm_ops);
