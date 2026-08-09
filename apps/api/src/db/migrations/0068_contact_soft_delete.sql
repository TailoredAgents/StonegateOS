-- Expand-first contact retention. Deletion becomes a reversible state change;
-- no linked appointment, quote, thread, task, property association, payment,
-- or partner record is removed by this migration.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deleted_by" uuid,
  ADD COLUMN IF NOT EXISTS "purge_eligible_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contacts_deleted_by_team_member_fk'
  ) THEN
    ALTER TABLE "contacts"
      ADD CONSTRAINT "contacts_deleted_by_team_member_fk"
      FOREIGN KEY ("deleted_by") REFERENCES "team_members"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE "contacts"
  VALIDATE CONSTRAINT "contacts_deleted_by_team_member_fk";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contacts_soft_delete_state_check'
  ) THEN
    ALTER TABLE "contacts"
      ADD CONSTRAINT "contacts_soft_delete_state_check"
      CHECK (
        (
          "deleted_at" IS NULL
          AND "deleted_by" IS NULL
          AND "purge_eligible_at" IS NULL
        )
        OR
        (
          "deleted_at" IS NOT NULL
          AND "purge_eligible_at" IS NOT NULL
          AND "purge_eligible_at" >= "deleted_at" + interval '30 days'
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "contacts"
  VALIDATE CONSTRAINT "contacts_soft_delete_state_check";

CREATE INDEX IF NOT EXISTS "contacts_active_updated_idx"
  ON "contacts" ("updated_at" DESC)
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "contacts_purge_eligibility_idx"
  ON "contacts" ("purge_eligible_at")
  WHERE "deleted_at" IS NOT NULL;

-- Queued work for a deleted contact must remain visible and recoverable, but
-- it must never be dispatched. Restore deliberately does not clear this state;
-- a later, explicit operator review may decide whether individual operations
-- are still appropriate.
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "quarantined_by" uuid,
  ADD COLUMN IF NOT EXISTS "quarantine_reason" text,
  ADD COLUMN IF NOT EXISTS "quarantined_contact_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbox_quarantined_by_team_member_fk'
  ) THEN
    ALTER TABLE "outbox_events"
      ADD CONSTRAINT "outbox_quarantined_by_team_member_fk"
      FOREIGN KEY ("quarantined_by") REFERENCES "team_members"("id")
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbox_quarantined_contact_fk'
  ) THEN
    ALTER TABLE "outbox_events"
      ADD CONSTRAINT "outbox_quarantined_contact_fk"
      FOREIGN KEY ("quarantined_contact_id") REFERENCES "contacts"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outbox_quarantine_state_check'
  ) THEN
    ALTER TABLE "outbox_events"
      ADD CONSTRAINT "outbox_quarantine_state_check"
      CHECK (
        (
          "quarantined_at" IS NULL
          AND "quarantine_reason" IS NULL
          AND "quarantined_contact_id" IS NULL
        )
        OR
        (
          "quarantined_at" IS NOT NULL
          AND "quarantine_reason" IS NOT NULL
          AND "quarantined_contact_id" IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "outbox_events"
  VALIDATE CONSTRAINT "outbox_quarantined_by_team_member_fk";
ALTER TABLE "outbox_events"
  VALIDATE CONSTRAINT "outbox_quarantined_contact_fk";
ALTER TABLE "outbox_events"
  VALIDATE CONSTRAINT "outbox_quarantine_state_check";

CREATE INDEX IF NOT EXISTS "outbox_dispatchable_idx"
  ON "outbox_events" ("next_attempt_at", "created_at")
  WHERE "processed_at" IS NULL AND "quarantined_at" IS NULL;

CREATE INDEX IF NOT EXISTS "outbox_quarantined_contact_idx"
  ON "outbox_events" ("quarantined_contact_id", "quarantined_at")
  WHERE "quarantined_at" IS NOT NULL;

-- Close the race where another worker schedules or updates automation after
-- the delete transaction scanned existing state. This is intentionally a
-- one-way safety rule: restoring the contact does not alter automation rows.
CREATE OR REPLACE FUNCTION enforce_deleted_contact_automation_pause()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  contact_deleted_at timestamp with time zone;
  contact_deleted_by uuid;
BEGIN
  SELECT contact_row."deleted_at", contact_row."deleted_by"
  INTO contact_deleted_at, contact_deleted_by
  FROM "leads" AS lead_row
  INNER JOIN "contacts" AS contact_row
    ON contact_row."id" = lead_row."contact_id"
  WHERE lead_row."id" = NEW."lead_id"
    AND contact_row."deleted_at" IS NOT NULL
  LIMIT 1;

  IF FOUND THEN
    NEW."paused" := true;
    NEW."paused_at" := coalesce(NEW."paused_at", contact_deleted_at, now());
    NEW."paused_by" := coalesce(NEW."paused_by", contact_deleted_by);
    NEW."followup_state" := 'contact_deleted';
    NEW."next_followup_at" := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "lead_automation_deleted_contact_pause"
  ON "lead_automation_state";
CREATE TRIGGER "lead_automation_deleted_contact_pause"
BEFORE INSERT OR UPDATE ON "lead_automation_state"
FOR EACH ROW
EXECUTE FUNCTION enforce_deleted_contact_automation_pause();

COMMENT ON COLUMN "contacts"."deleted_at" IS
  'Soft-delete timestamp. Default CRM reads must exclude rows where this is set.';

COMMENT ON COLUMN "contacts"."purge_eligible_at" IS
  'Earliest review date after the 30-day recovery window; this does not authorize automatic purge.';

-- Stored permissions are authoritative after 0065. Materialize restore for
-- existing built-in owners even though their normal baseline also contains
-- the global owner capability.
UPDATE "team_roles"
SET "permissions" = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce("team_roles"."permissions", ARRAY[]::text[]) ||
          ARRAY['contacts.restore']::text[]
        ) AS permission
        ORDER BY permission
      )
    ),
    "updated_at" = now()
WHERE lower(trim("slug")) = 'owner';
