-- Account-owned Partner location portfolio controls. This migration adds one
-- active account default, same-account acyclic hierarchy, membership-private
-- favorites, and a bounded import evidence ledger. It stores no raw CSV or
-- gate/access secret material.

ALTER TABLE "partner_accounts"
  ADD COLUMN "default_partner_location_id" uuid,
  ADD COLUMN "location_directory_version" integer DEFAULT 1 NOT NULL,
  ADD CONSTRAINT "partner_accounts_location_directory_version_check"
    CHECK ("location_directory_version" > 0);

ALTER TABLE "partner_account_locations"
  ADD COLUMN "parent_location_id" uuid,
  ADD CONSTRAINT "partner_account_locations_parent_not_self_check"
    CHECK ("parent_location_id" IS NULL OR "parent_location_id" <> "id"),
  ADD CONSTRAINT "partner_account_locations_parent_account_fk"
    FOREIGN KEY ("partner_account_id", "parent_location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX "partner_accounts_default_location_idx"
  ON "partner_accounts" ("default_partner_location_id")
  WHERE "default_partner_location_id" IS NOT NULL;

CREATE INDEX "partner_account_locations_parent_idx"
  ON "partner_account_locations" (
    "partner_account_id",
    "parent_location_id",
    "active",
    "site_name",
    "id"
  );

UPDATE "partner_accounts" AS account
SET "default_partner_location_id" = (
  SELECT location."id"
  FROM "partner_account_locations" AS location
  WHERE location."partner_account_id" = account."id"
    AND location."active" IS TRUE
  ORDER BY location."created_at", location."id"
  LIMIT 1
)
WHERE account."default_partner_location_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "partner_account_locations" AS location
    WHERE location."partner_account_id" = account."id"
      AND location."active" IS TRUE
  );

ALTER TABLE "partner_accounts"
  ADD CONSTRAINT "partner_accounts_default_location_account_fk"
    FOREIGN KEY ("id", "default_partner_location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "assign_first_partner_account_default_location"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."active" IS TRUE
    AND (TG_OP = 'INSERT' OR OLD."active" IS FALSE)
  THEN
    UPDATE "partner_accounts"
    SET "default_partner_location_id" = NEW."id"
    WHERE "id" = NEW."partner_account_id"
      AND "default_partner_location_id" IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_account_locations_assign_first_default"
AFTER INSERT OR UPDATE OF "active" ON "partner_account_locations"
FOR EACH ROW
EXECUTE FUNCTION "assign_first_partner_account_default_location"();

CREATE OR REPLACE FUNCTION "enforce_partner_account_active_default"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  account_id uuid;
  configured_default uuid;
  active_count integer;
  default_is_active boolean;
BEGIN
  IF TG_TABLE_NAME = 'partner_accounts' THEN
    account_id := (to_jsonb(NEW) ->> 'id')::uuid;
  ELSIF TG_OP = 'DELETE' THEN
    account_id := (to_jsonb(OLD) ->> 'partner_account_id')::uuid;
  ELSE
    account_id := (to_jsonb(NEW) ->> 'partner_account_id')::uuid;
  END IF;

  SELECT account."default_partner_location_id"
  INTO configured_default
  FROM "partner_accounts" AS account
  WHERE account."id" = account_id;

  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO active_count
  FROM "partner_account_locations" AS location
  WHERE location."partner_account_id" = account_id
    AND location."active" IS TRUE;

  SELECT EXISTS (
    SELECT 1
    FROM "partner_account_locations" AS location
    WHERE location."partner_account_id" = account_id
      AND location."id" = configured_default
      AND location."active" IS TRUE
  )
  INTO default_is_active;

  IF active_count = 0 AND configured_default IS NOT NULL THEN
    RAISE EXCEPTION 'partner_account_default_requires_active_location'
      USING ERRCODE = '23514';
  END IF;
  IF active_count > 0
    AND (configured_default IS NULL OR default_is_active IS NOT TRUE)
  THEN
    RAISE EXCEPTION 'partner_account_active_location_requires_default'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "partner_accounts_active_default_consistency"
AFTER INSERT OR UPDATE ON "partner_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_account_active_default"();

CREATE CONSTRAINT TRIGGER "partner_account_locations_active_default_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "partner_account_locations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_account_active_default"();

CREATE OR REPLACE FUNCTION "enforce_partner_location_hierarchy"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."parent_location_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."parent_location_id" = NEW."id" THEN
    RAISE EXCEPTION 'partner_location_cannot_parent_itself'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "partner_account_locations" AS parent
    WHERE parent."partner_account_id" = NEW."partner_account_id"
      AND parent."id" = NEW."parent_location_id"
      AND parent."active" IS TRUE
  ) THEN
    RAISE EXCEPTION 'partner_location_parent_must_be_active_in_account'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors("id", "parent_location_id") AS (
      SELECT candidate."id", candidate."parent_location_id"
      FROM "partner_account_locations" AS candidate
      WHERE candidate."partner_account_id" = NEW."partner_account_id"
        AND candidate."id" = NEW."parent_location_id"
      UNION
      SELECT candidate."id", candidate."parent_location_id"
      FROM "partner_account_locations" AS candidate
      INNER JOIN ancestors
        ON candidate."id" = ancestors."parent_location_id"
      WHERE candidate."partner_account_id" = NEW."partner_account_id"
    )
    SELECT 1
    FROM ancestors
    WHERE ancestors."id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'partner_location_hierarchy_cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_account_locations_hierarchy_guard"
BEFORE INSERT OR UPDATE OF
  "partner_account_id",
  "parent_location_id"
ON "partner_account_locations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_location_hierarchy"();

CREATE OR REPLACE FUNCTION "enforce_partner_location_archive_hierarchy"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD."active" IS TRUE
    AND NEW."active" IS FALSE
    AND EXISTS (
      SELECT 1
      FROM "partner_account_locations" AS child
      WHERE child."partner_account_id" = OLD."partner_account_id"
        AND child."parent_location_id" = OLD."id"
        AND child."active" IS TRUE
    )
  THEN
    RAISE EXCEPTION 'partner_location_active_children_require_reassignment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_account_locations_archive_hierarchy_guard"
BEFORE UPDATE OF "active" ON "partner_account_locations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_location_archive_hierarchy"();

CREATE TABLE "partner_location_favorites" (
  "partner_account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_location_favorites_pk"
    PRIMARY KEY ("membership_id", "location_id"),
  CONSTRAINT "partner_location_favorites_membership_account_fk"
    FOREIGN KEY ("membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_location_favorites_location_account_fk"
    FOREIGN KEY ("partner_account_id", "location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "partner_location_favorites_account_location_idx"
  ON "partner_location_favorites" (
    "partner_account_id",
    "location_id",
    "membership_id"
  );

CREATE TABLE "partner_location_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "requested_by_membership_id" uuid NOT NULL,
  "committed_by_membership_id" uuid,
  "dry_run_idempotency_key_hash" varchar(64) NOT NULL,
  "commit_idempotency_key_hash" varchar(64),
  "request_hash" varchar(64) NOT NULL,
  "commit_request_hash" varchar(64),
  "state" text DEFAULT 'validated' NOT NULL,
  "directory_version" integer NOT NULL,
  "row_count" integer NOT NULL,
  "valid_row_count" integer NOT NULL,
  "invalid_row_count" integer NOT NULL,
  "normalized_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "row_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "purge_after" timestamptz NOT NULL,
  "committed_at" timestamptz,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "partner_location_imports_account_fk"
    FOREIGN KEY ("partner_account_id")
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  CONSTRAINT "partner_location_imports_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_location_imports_committer_account_fk"
    FOREIGN KEY ("committed_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_location_imports_state_check"
    CHECK ("state" IN ('validated', 'invalid', 'committed', 'expired')),
  CONSTRAINT "partner_location_imports_hash_check"
    CHECK (
      "dry_run_idempotency_key_hash" ~ '^[0-9a-f]{64}$'
      AND "request_hash" ~ '^[0-9a-f]{64}$'
      AND (
        "commit_idempotency_key_hash" IS NULL
        OR "commit_idempotency_key_hash" ~ '^[0-9a-f]{64}$'
      )
      AND (
        "commit_request_hash" IS NULL
        OR "commit_request_hash" ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT "partner_location_imports_counts_check"
    CHECK (
      "row_count" BETWEEN 1 AND 500
      AND "valid_row_count" BETWEEN 0 AND "row_count"
      AND "invalid_row_count" BETWEEN 0 AND "row_count"
      AND "valid_row_count" + "invalid_row_count" = "row_count"
      AND jsonb_typeof("normalized_rows") = 'array'
      AND jsonb_array_length("normalized_rows") = "valid_row_count"
      AND jsonb_typeof("row_results") = 'array'
      AND jsonb_array_length("row_results") = "row_count"
    ),
  CONSTRAINT "partner_location_imports_version_check"
    CHECK ("directory_version" > 0 AND "revision" > 0),
  CONSTRAINT "partner_location_imports_lifecycle_check"
    CHECK (
      "expires_at" > "created_at"
      AND "expires_at" <= "created_at" + interval '24 hours'
      AND "purge_after" > "expires_at"
      AND "purge_after" <= "created_at" + interval '30 days'
      AND (
        ("state" = 'committed' AND "committed_at" IS NOT NULL
          AND "committed_by_membership_id" IS NOT NULL
          AND "commit_idempotency_key_hash" IS NOT NULL
          AND "commit_request_hash" IS NOT NULL)
        OR
        ("state" <> 'committed' AND "committed_at" IS NULL)
      )
    ),
  CONSTRAINT "partner_location_imports_no_secret_keys_check"
    CHECK (
      "normalized_rows"::text !~* '"(accesssecret|gatecode|accesscode|doorcode)"[[:space:]]*:'
      AND "row_results"::text !~* '"(accesssecret|gatecode|accesscode|doorcode)"[[:space:]]*:'
    )
);

CREATE UNIQUE INDEX "partner_location_imports_account_dry_key"
  ON "partner_location_imports" (
    "partner_account_id",
    "dry_run_idempotency_key_hash"
  );

CREATE UNIQUE INDEX "partner_location_imports_account_commit_key"
  ON "partner_location_imports" (
    "partner_account_id",
    "commit_idempotency_key_hash"
  )
  WHERE "commit_idempotency_key_hash" IS NOT NULL;

CREATE INDEX "partner_location_imports_account_history_idx"
  ON "partner_location_imports" (
    "partner_account_id",
    "created_at" DESC,
    "id" DESC
  );

CREATE INDEX "partner_location_imports_cleanup_idx"
  ON "partner_location_imports" ("purge_after", "id");

CREATE OR REPLACE FUNCTION "prune_partner_location_imports"(
  prune_at timestamptz DEFAULT now(),
  prune_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expired_count integer := 0;
  deleted_count integer := 0;
BEGIN
  IF prune_limit < 1 OR prune_limit > 5000 THEN
    RAISE EXCEPTION 'partner_location_import_prune_limit_invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_location_imports"
    WHERE "state" IN ('validated', 'invalid')
      AND "expires_at" <= prune_at
    ORDER BY "expires_at", "id"
    LIMIT prune_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE "partner_location_imports" AS operation
  SET
    "state" = 'expired',
    "revision" = operation."revision" + 1,
    "updated_at" = prune_at
  FROM candidates
  WHERE operation."id" = candidates."id";
  GET DIAGNOSTICS expired_count = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_location_imports"
    WHERE "purge_after" <= prune_at
    ORDER BY "purge_after", "id"
    LIMIT GREATEST(prune_limit - expired_count, 0)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM "partner_location_imports" AS operation
  USING candidates
  WHERE operation."id" = candidates."id";
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN expired_count + deleted_count;
END;
$$;

COMMENT ON COLUMN "partner_accounts"."default_partner_location_id" IS
  'Exactly one active default when the account has active locations; enforced at transaction commit.';
COMMENT ON COLUMN "partner_account_locations"."parent_location_id" IS
  'Optional same-account active parent used for an acyclic portfolio/site hierarchy.';
COMMENT ON TABLE "partner_location_favorites" IS
  'Membership-private display preference that never grants location access.';
COMMENT ON TABLE "partner_location_imports" IS
  'Short-lived dry-run/commit evidence. Raw CSV and gate/access secrets are never stored; prune after at most 30 days.';
