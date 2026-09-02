-- Owner-controlled account merge reconciliation. A populated tenant is never
-- rewritten automatically: the preflight records bounded blockers, and only a
-- source with no remaining access or business bindings can be marked merged.

CREATE TABLE "partner_account_merge_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_partner_account_id" uuid NOT NULL,
  "target_partner_account_id" uuid NOT NULL,
  "state" text DEFAULT 'needs_reconciliation' NOT NULL,
  "reason" varchar(1000) NOT NULL,
  "conflict_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "preflight_hash" varchar(64) NOT NULL,
  "source_lifecycle_revision" integer NOT NULL,
  "target_lifecycle_revision" integer NOT NULL,
  "requested_by_team_member_id" uuid NOT NULL,
  "completed_by_team_member_id" uuid,
  "completed_at" timestamptz,
  "cancelled_by_team_member_id" uuid,
  "cancelled_at" timestamptz,
  "resolution_note" varchar(1000),
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_account_merge_cases_source_fk"
    FOREIGN KEY ("source_partner_account_id")
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_merge_cases_target_fk"
    FOREIGN KEY ("target_partner_account_id")
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_merge_cases_requester_fk"
    FOREIGN KEY ("requested_by_team_member_id")
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_merge_cases_completer_fk"
    FOREIGN KEY ("completed_by_team_member_id")
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_merge_cases_canceller_fk"
    FOREIGN KEY ("cancelled_by_team_member_id")
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_account_merge_cases_distinct_accounts_check"
    CHECK ("source_partner_account_id" <> "target_partner_account_id"),
  CONSTRAINT "partner_account_merge_cases_state_check"
    CHECK ("state" IN ('needs_reconciliation', 'ready', 'completed', 'cancelled')),
  CONSTRAINT "partner_account_merge_cases_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 1000),
  CONSTRAINT "partner_account_merge_cases_conflict_check"
    CHECK (
      jsonb_typeof("conflict_summary") = 'object'
      AND octet_length("conflict_summary"::text) <= 8192
      AND "preflight_hash" ~ '^[0-9a-f]{64}$'
      AND "source_lifecycle_revision" > 0
      AND "target_lifecycle_revision" > 0
    ),
  CONSTRAINT "partner_account_merge_cases_lifecycle_check"
    CHECK (
      (
        "state" IN ('needs_reconciliation', 'ready')
        AND "completed_by_team_member_id" IS NULL
        AND "completed_at" IS NULL
        AND "cancelled_by_team_member_id" IS NULL
        AND "cancelled_at" IS NULL
        AND "resolution_note" IS NULL
      )
      OR (
        "state" = 'completed'
        AND "completed_by_team_member_id" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "cancelled_by_team_member_id" IS NULL
        AND "cancelled_at" IS NULL
        AND length(btrim("resolution_note")) BETWEEN 20 AND 1000
      )
      OR (
        "state" = 'cancelled'
        AND "cancelled_by_team_member_id" IS NOT NULL
        AND "cancelled_at" IS NOT NULL
        AND "completed_by_team_member_id" IS NULL
        AND "completed_at" IS NULL
        AND length(btrim("resolution_note")) BETWEEN 20 AND 1000
      )
    ),
  CONSTRAINT "partner_account_merge_cases_version_check"
    CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "partner_account_merge_cases_open_source_key"
  ON "partner_account_merge_cases" ("source_partner_account_id")
  WHERE "state" IN ('needs_reconciliation', 'ready');

CREATE INDEX "partner_account_merge_cases_queue_idx"
  ON "partner_account_merge_cases" ("state", "created_at", "id");

CREATE INDEX "partner_account_merge_cases_target_idx"
  ON "partner_account_merge_cases" (
    "target_partner_account_id",
    "state",
    "created_at",
    "id"
  );

COMMENT ON TABLE "partner_account_merge_cases" IS
  'Bounded Team Owner preflight evidence for safe tenant merges. Populated accounts remain contained until every reported binding is explicitly reconciled.';

CREATE OR REPLACE FUNCTION "partner_account_binding_counts"(
  account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  binding record;
  binding_count bigint;
  result jsonb := '{}'::jsonb;
BEGIN
  FOR binding IN
    SELECT namespace.nspname AS schema_name, relation.relname AS table_name
    FROM pg_catalog.pg_attribute attribute
    INNER JOIN pg_catalog.pg_class relation
      ON relation.oid = attribute.attrelid
    INNER JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attname = 'partner_account_id'
      AND attribute.attnum > 0
      AND attribute.attisdropped IS FALSE
      -- These trigger-created baseline policies remain attached to the disabled
      -- source account as retained configuration evidence; they do not block a
      -- merge. Every other account-owned table continues to block preflight.
      AND relation.relname NOT IN (
        'partner_account_scheduling_policies',
        'partner_account_cancellation_policies'
      )
    ORDER BY relation.relname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE partner_account_id = $1',
      binding.schema_name,
      binding.table_name
    )
    INTO binding_count
    USING account_id;
    IF binding_count > 0 THEN
      result := result || jsonb_build_object(binding.table_name, binding_count);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

COMMENT ON FUNCTION "partner_account_binding_counts"(uuid) IS
  'Returns nonzero account-owned row counts across the live schema for a conservative Partner account-merge preflight. Trigger-created scheduling and cancellation policy rows remain attached to a disabled merged source as retained configuration evidence and do not block preflight; all other account-owned rows do.';
