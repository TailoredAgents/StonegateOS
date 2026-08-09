-- Append-only contact-merge recovery evidence. Contact, suggestion, actor,
-- and session identifiers are snapshots by design: no contact deletion or
-- suggestion cleanup may cascade into this ledger.
CREATE TABLE IF NOT EXISTS "contact_merge_recovery_ledgers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_contact_snapshot_id" uuid NOT NULL,
  "target_contact_snapshot_id" uuid NOT NULL,
  "suggestion_snapshot_id" uuid,
  "preview_hash" varchar(64) NOT NULL,
  "rule_version" text NOT NULL,
  "source_version" timestamp with time zone NOT NULL,
  "target_version" timestamp with time zone NOT NULL,
  "actor_member_snapshot_id" uuid NOT NULL,
  "actor_role_snapshot" text,
  "actor_label_snapshot" text,
  "session_snapshot_id" uuid NOT NULL,
  "auth_method_snapshot" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "idempotency_key_hash" varchar(64) NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "contact_before" jsonb NOT NULL,
  "consolidation_plan" jsonb NOT NULL,
  "dependency_summary" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contact_merge_recovery_preview_hash_check"
    CHECK ("preview_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contact_merge_recovery_idempotency_hash_check"
    CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contact_merge_recovery_status_check"
    CHECK ("status" = 'completed'),
  CONSTRAINT "contact_merge_recovery_rule_version_check"
    CHECK ("rule_version" = 'contact-merge-v3'),
  CONSTRAINT "contact_merge_recovery_auth_method_check"
    CHECK ("auth_method_snapshot" IN ('team_session', 'break_glass')),
  CONSTRAINT "contact_merge_recovery_distinct_contacts_check"
    CHECK ("source_contact_snapshot_id" <> "target_contact_snapshot_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_merge_recovery_operation_key"
  ON "contact_merge_recovery_ledgers" ("operation_id");
CREATE INDEX IF NOT EXISTS "contact_merge_recovery_source_created_idx"
  ON "contact_merge_recovery_ledgers"
  ("source_contact_snapshot_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "contact_merge_recovery_target_created_idx"
  ON "contact_merge_recovery_ledgers"
  ("target_contact_snapshot_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "contact_merge_recovery_suggestion_idx"
  ON "contact_merge_recovery_ledgers" ("suggestion_snapshot_id");

CREATE TABLE IF NOT EXISTS "contact_merge_recovery_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ledger_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "entity_type" text NOT NULL,
  "entity_snapshot_id" text NOT NULL,
  "change_kind" text NOT NULL,
  "before_state" jsonb NOT NULL,
  "after_state" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contact_merge_recovery_entries_ledger_fk"
    FOREIGN KEY ("ledger_id")
    REFERENCES "contact_merge_recovery_ledgers"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "contact_merge_recovery_entry_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "contact_merge_recovery_entry_change_kind_check"
    CHECK ("change_kind" IN (
      'baseline',
      'created',
      'moved',
      'deduplicated',
      'updated',
      'soft_deleted',
      'retained_historical',
      'superseded'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "contact_merge_recovery_entry_ledger_ordinal_key"
  ON "contact_merge_recovery_entries" ("ledger_id", "ordinal");
CREATE INDEX IF NOT EXISTS "contact_merge_recovery_entry_ledger_entity_idx"
  ON "contact_merge_recovery_entries"
  ("ledger_id", "entity_type", "entity_snapshot_id");

-- The only valid lifecycle is INSERT. Recovery assessments are computed from
-- current state and never mutate the original evidence.
-- This deliberately blocks TRUNCATE, including fixture reset attempts. Tests
-- that execute a merge must tear down by dropping their disposable database
-- or schema; there is intentionally no session-setting or test-only bypass.
CREATE OR REPLACE FUNCTION "reject_contact_merge_recovery_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'contact merge recovery evidence is append-only';
END;
$function$;

DROP TRIGGER IF EXISTS "contact_merge_recovery_ledgers_append_only"
  ON "contact_merge_recovery_ledgers";
CREATE TRIGGER "contact_merge_recovery_ledgers_append_only"
BEFORE UPDATE OR DELETE ON "contact_merge_recovery_ledgers"
FOR EACH ROW EXECUTE FUNCTION "reject_contact_merge_recovery_mutation"();
DROP TRIGGER IF EXISTS "contact_merge_recovery_ledgers_no_truncate"
  ON "contact_merge_recovery_ledgers";
CREATE TRIGGER "contact_merge_recovery_ledgers_no_truncate"
BEFORE TRUNCATE ON "contact_merge_recovery_ledgers"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_contact_merge_recovery_mutation"();

DROP TRIGGER IF EXISTS "contact_merge_recovery_entries_append_only"
  ON "contact_merge_recovery_entries";
CREATE TRIGGER "contact_merge_recovery_entries_append_only"
BEFORE UPDATE OR DELETE ON "contact_merge_recovery_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_contact_merge_recovery_mutation"();
DROP TRIGGER IF EXISTS "contact_merge_recovery_entries_no_truncate"
  ON "contact_merge_recovery_entries";
CREATE TRIGGER "contact_merge_recovery_entries_no_truncate"
BEFORE TRUNCATE ON "contact_merge_recovery_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_contact_merge_recovery_mutation"();

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "merged_into_contact_snapshot_id" uuid,
  ADD COLUMN IF NOT EXISTS "merge_recovery_ledger_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_merge_recovery_ledger_fk'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE "contacts"
      ADD CONSTRAINT "contacts_merge_recovery_ledger_fk"
      FOREIGN KEY ("merge_recovery_ledger_id")
      REFERENCES "contact_merge_recovery_ledgers"("id")
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_merge_recovery_state_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE "contacts"
      ADD CONSTRAINT "contacts_merge_recovery_state_check"
      CHECK (
        (
          "merged_into_contact_snapshot_id" IS NULL
          AND "merge_recovery_ledger_id" IS NULL
        ) OR (
          "merged_into_contact_snapshot_id" IS NOT NULL
          AND "merge_recovery_ledger_id" IS NOT NULL
          AND "deleted_at" IS NOT NULL
          AND "merged_into_contact_snapshot_id" <> "id"
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "contacts"
  VALIDATE CONSTRAINT "contacts_merge_recovery_ledger_fk";
ALTER TABLE "contacts"
  VALIDATE CONSTRAINT "contacts_merge_recovery_state_check";

CREATE INDEX IF NOT EXISTS "contacts_merge_recovery_ledger_idx"
  ON "contacts" ("merge_recovery_ledger_id")
  WHERE "merge_recovery_ledger_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "contacts_merged_into_idx"
  ON "contacts" ("merged_into_contact_snapshot_id", "deleted_at")
  WHERE "merged_into_contact_snapshot_id" IS NOT NULL;

COMMENT ON TABLE "contact_merge_recovery_ledgers" IS
  'Append-only merge header whose contact and principal identifiers are immutable snapshots, never cascading owners.';
COMMENT ON TABLE "contact_merge_recovery_entries" IS
  'Ordered append-only before/after evidence plus a complete exact post-merge baseline for both contacts and all reviewed dependencies.';
COMMENT ON COLUMN "contacts"."merged_into_contact_snapshot_id" IS
  'Target contact snapshot for a soft-deleted merged source; intentionally not a contact foreign key.';
