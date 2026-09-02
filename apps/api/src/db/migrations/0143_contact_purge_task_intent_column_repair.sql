-- Repair the contact-purge active-operation guard after the task-intent
-- ledger standardized its parent reference as call_operation_id. Migration
-- 0090 referenced the nonexistent operation_id name inside PL/pgSQL, which is
-- resolved only when the trigger executes. Keep the original migration and
-- every fail-closed purge rule intact; replace only the affected trigger
-- function on already-migrated databases.

DO $repair_preflight$
BEGIN
  IF to_regclass('public.team_call_operation_task_intents') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE "attrelid" = 'public.team_call_operation_task_intents'::regclass
         AND "attname" = 'call_operation_id'
         AND "attnum" > 0
         AND NOT "attisdropped"
     ) THEN
    RAISE EXCEPTION
      'contact purge repair requires team_call_operation_task_intents.call_operation_id';
  END IF;
END;
$repair_preflight$;

CREATE OR REPLACE FUNCTION "public"."enforce_contact_purge_maintenance"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF current_setting('app.contact_purge_authorized_id', true)
       IS DISTINCT FROM OLD."id"::text THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'contacts may only be hard-deleted by the authorized purge maintenance process',
      HINT = 'Use the Owner contact purge preview and execute API.';
  END IF;

  IF OLD."deleted_at" IS NULL
     OR OLD."purge_eligible_at" IS NULL
     OR OLD."purge_eligible_at" < OLD."deleted_at" + interval '30 days'
     OR OLD."purge_eligible_at" > statement_timestamp() THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'contact_purge_recovery_window_guard',
      MESSAGE = 'the contact recovery window has not safely elapsed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."contact_purge_fk_inventory"(OLD."id") AS dependency
    WHERE NOT dependency.supported
       OR dependency.reference_count > 0
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'contact_purge_foreign_key_dependency_guard',
      MESSAGE = 'contact purge is blocked by a foreign-key dependency or incomplete inventory';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."contact_purge_logical_inventory"(OLD."id") AS dependency
    WHERE dependency.reference_count > 0
      AND NOT (
        dependency.schema_name = 'public'
        AND (
          (dependency.table_name = 'team_call_operations'
            AND dependency.column_name = 'contact_id')
          OR (dependency.table_name = 'team_call_operation_task_intents'
            AND dependency.column_name = 'expected_contact_id')
          OR (dependency.table_name = 'sales_escalation_call_operations'
            AND dependency.column_name = 'contact_id')
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'contact_purge_logical_dependency_guard',
      MESSAGE = 'contact purge is blocked by an unresolved logical dependency';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM "team_call_operations"
      WHERE "contact_id" = OLD."id"
        AND "guard_released_at" IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM "team_call_operation_task_intents" AS intent
      INNER JOIN "team_call_operations" AS operation
        ON operation."id" = intent."call_operation_id"
      WHERE intent."expected_contact_id" = OLD."id"
        AND operation."guard_released_at" IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM "sales_escalation_call_operations"
      WHERE "contact_id" = OLD."id"
        AND "guard_released_at" IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM "outbox_events"
      WHERE "processed_at" IS NULL
        AND "payload" ->> 'contactId' = OLD."id"::text
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'contact_purge_active_operation_guard',
      MESSAGE = 'contact purge is blocked by unresolved external or queued work';
  END IF;

  RETURN OLD;
END;
$function$;

COMMENT ON FUNCTION "public"."enforce_contact_purge_maintenance"() IS
  'Fail-closed contact purge guard using the canonical task-intent call_operation_id relationship.';
