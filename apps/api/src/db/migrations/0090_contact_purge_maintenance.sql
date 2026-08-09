-- Irreversible contact purge is a built-in Owner maintenance capability. It
-- is deliberately explicit instead of inheriting from a bare wildcard, and
-- Access validation keeps it out of custom role/member grants.
UPDATE "team_roles"
SET "permissions" = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce("team_roles"."permissions", ARRAY[]::text[]) ||
          ARRAY['contacts.purge']::text[]
        ) AS permission
        ORDER BY permission
      )
    ),
    "updated_at" = now()
WHERE lower(trim("slug")) = 'owner';

-- Enumerate every live foreign key whose referenced key is contacts(id).
-- Unsupported/composite catalog shapes are returned as supported=false so
-- callers and the delete trigger fail closed instead of guessing.
CREATE OR REPLACE FUNCTION "public"."contact_purge_fk_inventory"(
  p_contact_id uuid
)
RETURNS TABLE (
  constraint_name text,
  schema_name text,
  table_name text,
  column_name text,
  delete_action text,
  reference_count bigint,
  supported boolean
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  fk record;
  counted bigint;
BEGIN
  FOR fk IN
    SELECT
      constraint_row."conname" AS fk_name,
      child_schema."nspname" AS child_schema_name,
      child_table."relname" AS child_table_name,
      child_column."attname" AS child_column_name,
      parent_column."attname" AS parent_column_name,
      cardinality(constraint_row."conkey") AS child_key_count,
      cardinality(constraint_row."confkey") AS parent_key_count,
      CASE constraint_row."confdeltype"
        WHEN 'a' THEN 'no_action'
        WHEN 'r' THEN 'restrict'
        WHEN 'c' THEN 'cascade'
        WHEN 'n' THEN 'set_null'
        WHEN 'd' THEN 'set_default'
        ELSE 'unknown'
      END AS fk_delete_action
    FROM pg_constraint AS constraint_row
    INNER JOIN pg_class AS child_table
      ON child_table."oid" = constraint_row."conrelid"
    INNER JOIN pg_namespace AS child_schema
      ON child_schema."oid" = child_table."relnamespace"
    LEFT JOIN pg_attribute AS child_column
      ON child_column."attrelid" = child_table."oid"
     AND child_column."attnum" = constraint_row."conkey"[1]
    LEFT JOIN pg_attribute AS parent_column
      ON parent_column."attrelid" = constraint_row."confrelid"
     AND parent_column."attnum" = constraint_row."confkey"[1]
    WHERE constraint_row."contype" = 'f'
      AND constraint_row."confrelid" = 'public.contacts'::regclass
      AND child_table."relkind" IN ('r', 'p')
    ORDER BY
      child_schema."nspname",
      child_table."relname",
      child_column."attname",
      constraint_row."conname"
  LOOP
    constraint_name := fk.fk_name;
    schema_name := fk.child_schema_name;
    table_name := fk.child_table_name;
    column_name := coalesce(fk.child_column_name, '<unsupported>');
    delete_action := fk.fk_delete_action;
    reference_count := 0;
    supported :=
      fk.child_key_count = 1
      AND fk.parent_key_count = 1
      AND fk.child_column_name IS NOT NULL
      AND fk.parent_column_name = 'id';

    IF supported THEN
      EXECUTE format(
        'SELECT count(*)::bigint FROM %I.%I WHERE %I = $1',
        fk.child_schema_name,
        fk.child_table_name,
        fk.child_column_name
      )
      INTO counted
      USING p_contact_id;
      reference_count := coalesce(counted, 0);
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$function$;

-- Inventory UUID columns that look like contact references but deliberately
-- have no FK. Known immutable call/merge evidence is retained after purge;
-- every unknown/current or future logical class blocks until it gets a
-- reviewed retention rule.
CREATE OR REPLACE FUNCTION "public"."contact_purge_logical_inventory"(
  p_contact_id uuid
)
RETURNS TABLE (
  schema_name text,
  table_name text,
  column_name text,
  reference_count bigint,
  supported boolean
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  reference_row record;
  counted bigint;
BEGIN
  FOR reference_row IN
    SELECT
      table_schema."nspname" AS logical_schema_name,
      table_row."relname" AS logical_table_name,
      column_row."attname" AS logical_column_name,
      column_row."atttypid" AS logical_type
    FROM pg_class AS table_row
    INNER JOIN pg_namespace AS table_schema
      ON table_schema."oid" = table_row."relnamespace"
    INNER JOIN pg_attribute AS column_row
      ON column_row."attrelid" = table_row."oid"
    WHERE table_row."relkind" IN ('r', 'p')
      AND table_schema."nspname" NOT IN ('pg_catalog', 'information_schema')
      AND column_row."attnum" > 0
      AND NOT column_row."attisdropped"
      AND column_row."attname" ~ '(^|_)contact(_[a-z0-9]+)*_ids?$'
      AND column_row."atttypid" IN ('uuid'::regtype, 'uuid[]'::regtype)
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS fk
        WHERE fk."contype" = 'f'
          AND fk."conrelid" = table_row."oid"
          AND fk."confrelid" = 'public.contacts'::regclass
          AND cardinality(fk."conkey") = 1
          AND fk."conkey"[1] = column_row."attnum"
      )
    ORDER BY
      table_schema."nspname",
      table_row."relname",
      column_row."attname"
  LOOP
    schema_name := reference_row.logical_schema_name;
    table_name := reference_row.logical_table_name;
    column_name := reference_row.logical_column_name;
    reference_count := 0;
    supported := reference_row.logical_type IN (
      'uuid'::regtype,
      'uuid[]'::regtype
    );

    IF reference_row.logical_type = 'uuid'::regtype THEN
      EXECUTE format(
        'SELECT count(*)::bigint FROM %I.%I WHERE %I = $1',
        reference_row.logical_schema_name,
        reference_row.logical_table_name,
        reference_row.logical_column_name
      )
      INTO counted
      USING p_contact_id;
      reference_count := coalesce(counted, 0);
    ELSIF reference_row.logical_type = 'uuid[]'::regtype THEN
      EXECUTE format(
        'SELECT count(*)::bigint FROM %I.%I WHERE $1 = ANY(%I)',
        reference_row.logical_schema_name,
        reference_row.logical_table_name,
        reference_row.logical_column_name
      )
      INTO counted
      USING p_contact_id;
      reference_count := coalesce(counted, 0);
    ELSE
      supported := false;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$function$;

-- Purge execute must freeze tables that can create a relationship while its
-- final inventory is running. A SHARE table lock permits readers and other
-- purge previews while blocking inserts/updates/deletes until this transaction
-- commits. SHARE ROW EXCLUSIVE also prevents two purge transactions from
-- deadlocking while upgrading a shared lock on contacts to a row-changing
-- lock. Tables are discovered and locked in one stable order so later schema
-- additions cannot silently bypass the concurrency boundary.
CREATE OR REPLACE FUNCTION "public"."contact_purge_lock_dependency_tables"()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  dependency_table record;
BEGIN
  FOR dependency_table IN
    SELECT DISTINCT candidates.schema_name, candidates.table_name
    FROM (
      SELECT
        child_schema."nspname" AS schema_name,
        child_table."relname" AS table_name
      FROM pg_constraint AS constraint_row
      INNER JOIN pg_class AS child_table
        ON child_table."oid" = constraint_row."conrelid"
      INNER JOIN pg_namespace AS child_schema
        ON child_schema."oid" = child_table."relnamespace"
      WHERE constraint_row."contype" = 'f'
        AND constraint_row."confrelid" = 'public.contacts'::regclass
        AND child_table."relkind" IN ('r', 'p')

      UNION

      SELECT
        table_schema."nspname" AS schema_name,
        table_row."relname" AS table_name
      FROM pg_class AS table_row
      INNER JOIN pg_namespace AS table_schema
        ON table_schema."oid" = table_row."relnamespace"
      INNER JOIN pg_attribute AS column_row
        ON column_row."attrelid" = table_row."oid"
      WHERE table_row."relkind" IN ('r', 'p')
        AND table_schema."nspname" NOT IN ('pg_catalog', 'information_schema')
        AND column_row."attnum" > 0
        AND NOT column_row."attisdropped"
        AND column_row."attname" ~ '(^|_)contact(_[a-z0-9]+)*_ids?$'
        AND column_row."atttypid" IN ('uuid'::regtype, 'uuid[]'::regtype)

      UNION

      SELECT 'public'::text, 'outbox_events'::text
      WHERE to_regclass('public.outbox_events') IS NOT NULL
    ) AS candidates
    ORDER BY candidates.schema_name, candidates.table_name
  LOOP
    EXECUTE format(
      'LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',
      dependency_table.schema_name,
      dependency_table.table_name
    );
  END LOOP;
END;
$function$;

-- The API must opt one exact row into hard purge inside the current
-- transaction. The trigger independently rechecks the recovery window,
-- schema-wide references, and unresolved external work immediately before
-- PostgreSQL can run any ON DELETE action.
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
        ON operation."id" = intent."operation_id"
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

DROP TRIGGER IF EXISTS "contacts_purge_maintenance_guard" ON "contacts";
CREATE TRIGGER "contacts_purge_maintenance_guard"
BEFORE DELETE ON "contacts"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_contact_purge_maintenance"();

COMMENT ON FUNCTION "public"."contact_purge_fk_inventory"(uuid) IS
  'Schema-wide, fail-closed inventory of foreign keys that reference contacts(id).';
COMMENT ON FUNCTION "public"."contact_purge_logical_inventory"(uuid) IS
  'Fail-closed inventory of UUID-shaped logical contact references without a contact FK.';
COMMENT ON FUNCTION "public"."contact_purge_lock_dependency_tables"() IS
  'Transaction-scoped lock of every table that can create a contact purge dependency.';
COMMENT ON TRIGGER "contacts_purge_maintenance_guard" ON "contacts" IS
  'Prevents hard deletion outside the authorized, retention-expired, dependency-free Owner maintenance process.';
