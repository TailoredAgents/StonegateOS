-- Keep at least one active human able to administer Team Access after that
-- invariant has first been established. Runtime role slugs are intentionally
-- irrelevant: effective access.manage comes from stored role permissions plus
-- member grants, and a matching member deny always wins.

CREATE OR REPLACE FUNCTION "team_permission_set_manages_access"(
  p_permissions text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(coalesce(p_permissions, ARRAY[]::text[])) AS permission(value)
    WHERE btrim(permission.value) IN ('*', 'access.*', 'access.manage')
  );
$$;

CREATE OR REPLACE FUNCTION "team_member_effectively_manages_access"(
  p_active boolean,
  p_role_permissions text[],
  p_permissions_grant text[],
  p_permissions_deny text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    coalesce(p_active, false)
    AND (
      "team_permission_set_manages_access"(p_role_permissions)
      OR "team_permission_set_manages_access"(p_permissions_grant)
    )
    AND NOT "team_permission_set_manages_access"(p_permissions_deny);
$$;

CREATE OR REPLACE FUNCTION "team_has_effective_access_manager"()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "team_members" AS member
    LEFT JOIN "team_roles" AS role ON role."id" = member."role_id"
    WHERE "team_member_effectively_manages_access"(
      member."active",
      role."permissions",
      member."permissions_grant",
      member."permissions_deny"
    )
  );
$$;

-- The latch distinguishes a new/fixture database, where zero owners must be
-- legal during bootstrap, from a configured database where losing the final
-- effective Access administrator is a constraint violation.
CREATE TABLE IF NOT EXISTS "team_access_continuity_state" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "protection_enabled" boolean DEFAULT false NOT NULL,
  "activated_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_access_continuity_state_singleton"
    CHECK ("singleton" = true)
);

WITH current_access_state AS (
  SELECT "team_has_effective_access_manager"() AS enabled
)
INSERT INTO "team_access_continuity_state" (
  "singleton",
  "protection_enabled",
  "activated_at",
  "updated_at"
)
SELECT
  true,
  enabled,
  CASE WHEN enabled THEN now() ELSE NULL END,
  now()
FROM current_access_state
ON CONFLICT ("singleton") DO UPDATE
SET
  "protection_enabled" =
    "team_access_continuity_state"."protection_enabled"
    OR excluded."protection_enabled",
  "activated_at" = CASE
    WHEN "team_access_continuity_state"."protection_enabled"
      THEN "team_access_continuity_state"."activated_at"
    WHEN excluded."protection_enabled"
      THEN coalesce("team_access_continuity_state"."activated_at", now())
    ELSE "team_access_continuity_state"."activated_at"
  END,
  "updated_at" = now();

CREATE OR REPLACE FUNCTION "lock_team_access_continuity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- This is the same lock key used by the Access API transactions. Taking it
  -- before every statement also serializes direct SQL writers with the app.
  PERFORM pg_advisory_xact_lock(hashtext('team_access_owner_safety_v1'));

  -- Capture the protected pre-mutation state. This upsert deliberately makes
  -- the latch self-healing if a disposable fixture reset removed its row; a
  -- later ordinary member/role UPDATE or DELETE cannot bypass continuity by
  -- clearing the support table first.
  IF "team_has_effective_access_manager"() THEN
    INSERT INTO "team_access_continuity_state" (
      "singleton",
      "protection_enabled",
      "activated_at",
      "updated_at"
    )
    VALUES (true, true, statement_timestamp(), clock_timestamp())
    ON CONFLICT ("singleton") DO UPDATE
    SET
      "protection_enabled" = true,
      "activated_at" = coalesce(
        "team_access_continuity_state"."activated_at",
        excluded."activated_at"
      ),
      "updated_at" = clock_timestamp();
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_team_access_continuity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  continuity_enabled boolean;
  has_access_manager boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('team_access_owner_safety_v1'));

  INSERT INTO "team_access_continuity_state" (
    "singleton",
    "protection_enabled"
  )
  VALUES (true, false)
  ON CONFLICT ("singleton") DO NOTHING;

  SELECT state."protection_enabled"
  INTO continuity_enabled
  FROM "team_access_continuity_state" AS state
  WHERE state."singleton" = true
  FOR UPDATE;

  SELECT "team_has_effective_access_manager"()
  INTO has_access_manager;

  IF has_access_manager THEN
    -- Touching the singleton on every successful check turns a stale
    -- REPEATABLE READ snapshot into a serialization failure rather than a
    -- possible write-skew pass.
    UPDATE "team_access_continuity_state"
    SET
      "protection_enabled" = true,
      "activated_at" = coalesce("activated_at", statement_timestamp()),
      "updated_at" = clock_timestamp()
    WHERE "singleton" = true;
    RETURN NULL;
  END IF;

  IF continuity_enabled THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'at least one active team member must retain effective access.manage',
      CONSTRAINT = 'team_access_continuity_requires_active_owner',
      HINT =
        'Add or promote another active Access administrator before removing the current one.';
  END IF;

  -- Empty and not-yet-configured databases remain valid during bootstrap.
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "reset_team_access_continuity_after_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('team_access_owner_safety_v1'));

  INSERT INTO "team_access_continuity_state" (
    "singleton",
    "protection_enabled",
    "activated_at",
    "updated_at"
  )
  VALUES (true, false, NULL, clock_timestamp())
  ON CONFLICT ("singleton") DO UPDATE
  SET
    "protection_enabled" = false,
    "activated_at" = NULL,
    "updated_at" = clock_timestamp();

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "authorize_team_access_continuity_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('team_access_owner_safety_v1'));

  IF coalesce(
    current_setting('stonegate.allow_team_access_fixture_reset', true),
    'off'
  ) <> 'on' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE =
        'Team Access tables cannot be truncated without an explicit fixture-reset opt-in',
      HINT =
        'In an isolated disposable transaction only, run SET LOCAL stonegate.allow_team_access_fixture_reset = ''on'' before TRUNCATE.';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "team_members_access_continuity_lock"
ON "team_members";

CREATE TRIGGER "team_members_access_continuity_lock"
BEFORE INSERT OR UPDATE OR DELETE
ON "team_members"
FOR EACH STATEMENT
EXECUTE FUNCTION "lock_team_access_continuity"();

DROP TRIGGER IF EXISTS "team_roles_access_continuity_lock"
ON "team_roles";

CREATE TRIGGER "team_roles_access_continuity_lock"
BEFORE INSERT OR UPDATE OR DELETE
ON "team_roles"
FOR EACH STATEMENT
EXECUTE FUNCTION "lock_team_access_continuity"();

DROP TRIGGER IF EXISTS "team_members_access_continuity_guard"
ON "team_members";

CREATE CONSTRAINT TRIGGER "team_members_access_continuity_guard"
AFTER INSERT OR UPDATE OR DELETE
ON "team_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_team_access_continuity"();

DROP TRIGGER IF EXISTS "team_roles_access_continuity_guard"
ON "team_roles";

CREATE CONSTRAINT TRIGGER "team_roles_access_continuity_guard"
AFTER INSERT OR UPDATE OR DELETE
ON "team_roles"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_team_access_continuity"();

-- TRUNCATE is a privileged test/reset boundary and does not fire row-level
-- constraint triggers. It must be explicitly enabled inside the disposable
-- reset transaction; the post-trigger then permits a fresh owner bootstrap.
DROP TRIGGER IF EXISTS "team_members_access_continuity_truncate_authorize"
ON "team_members";

CREATE TRIGGER "team_members_access_continuity_truncate_authorize"
BEFORE TRUNCATE
ON "team_members"
FOR EACH STATEMENT
EXECUTE FUNCTION "authorize_team_access_continuity_truncate"();

DROP TRIGGER IF EXISTS "team_members_access_continuity_truncate_reset"
ON "team_members";

CREATE TRIGGER "team_members_access_continuity_truncate_reset"
AFTER TRUNCATE
ON "team_members"
FOR EACH STATEMENT
EXECUTE FUNCTION "reset_team_access_continuity_after_truncate"();

DROP TRIGGER IF EXISTS "team_roles_access_continuity_truncate_authorize"
ON "team_roles";

CREATE TRIGGER "team_roles_access_continuity_truncate_authorize"
BEFORE TRUNCATE
ON "team_roles"
FOR EACH STATEMENT
EXECUTE FUNCTION "authorize_team_access_continuity_truncate"();

DROP TRIGGER IF EXISTS "team_roles_access_continuity_truncate_reset"
ON "team_roles";

CREATE TRIGGER "team_roles_access_continuity_truncate_reset"
AFTER TRUNCATE
ON "team_roles"
FOR EACH STATEMENT
EXECUTE FUNCTION "reset_team_access_continuity_after_truncate"();

COMMENT ON TABLE "team_access_continuity_state" IS
  'Self-healing latch for the deferred effective Access-administrator invariant; explicitly authorized disposable fixture TRUNCATE resets it for bootstrap.';
