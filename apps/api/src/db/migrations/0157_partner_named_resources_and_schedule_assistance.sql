-- Named scheduling resources, skill-aware profile requirements, immutable
-- assignment snapshots, and durable Partner waitlist/callback requests.

CREATE TABLE "schedule_resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "capacity_pool_key" varchar(64) NOT NULL
    REFERENCES "schedule_resource_pools"("key") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "capacity_units" integer NOT NULL,
  "skill_keys" text[] NOT NULL DEFAULT '{}'::text[],
  "active" boolean NOT NULL DEFAULT true,
  "source" text NOT NULL DEFAULT 'staff',
  "source_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "schedule_resources_kind_check"
    CHECK ("kind" IN ('crew', 'truck', 'equipment')),
  CONSTRAINT "schedule_resources_label_check"
    CHECK ("label" = btrim("label") AND length("label") BETWEEN 1 AND 160),
  CONSTRAINT "schedule_resources_capacity_check"
    CHECK ("capacity_units" BETWEEN 1 AND 10000),
  CONSTRAINT "schedule_resources_source_check"
    CHECK ("source" IN ('staff', 'compatibility_pool')),
  CONSTRAINT "schedule_resources_source_key_check"
    CHECK (
      ("source" = 'staff' AND "source_key" IS NULL)
      OR (
        "source" = 'compatibility_pool'
        AND "source_key" ~ '^pool:[a-z][a-z0-9_-]{0,63}:(crew|truck)$'
      )
    ),
  CONSTRAINT "schedule_resources_skill_keys_check"
    CHECK (
      cardinality("skill_keys") <= 50
      AND array_position("skill_keys", NULL) IS NULL
    )
);

CREATE UNIQUE INDEX "schedule_resources_source_key"
  ON "schedule_resources" ("source_key")
  WHERE "source_key" IS NOT NULL;
CREATE INDEX "schedule_resources_pool_kind_active_idx"
  ON "schedule_resources" ("capacity_pool_key", "kind", "active", "label", "id");

CREATE TABLE "partner_scheduling_profile_resource_requirements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scheduling_profile_id" uuid NOT NULL
    REFERENCES "partner_scheduling_profiles"("id") ON DELETE CASCADE,
  "resource_kind" text NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "capacity_units" integer NOT NULL DEFAULT 1,
  "required_skill_keys" text[] NOT NULL DEFAULT '{}'::text[],
  "source" text NOT NULL DEFAULT 'staff',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_profile_resource_requirements_kind_check"
    CHECK ("resource_kind" IN ('crew', 'truck', 'equipment')),
  CONSTRAINT "partner_profile_resource_requirements_quantity_check"
    CHECK ("quantity" BETWEEN 1 AND 20),
  CONSTRAINT "partner_profile_resource_requirements_capacity_check"
    CHECK ("capacity_units" BETWEEN 1 AND 100),
  CONSTRAINT "partner_profile_resource_requirements_source_check"
    CHECK ("source" IN ('staff', 'compatibility_pool')),
  CONSTRAINT "partner_profile_resource_requirements_skill_keys_check"
    CHECK (
      cardinality("required_skill_keys") <= 50
      AND array_position("required_skill_keys", NULL) IS NULL
    )
);

CREATE UNIQUE INDEX "partner_profile_resource_requirements_kind_key"
  ON "partner_scheduling_profile_resource_requirements"
  ("scheduling_profile_id", "resource_kind");
CREATE INDEX "partner_profile_resource_requirements_profile_idx"
  ON "partner_scheduling_profile_resource_requirements"
  ("scheduling_profile_id", "resource_kind", "id");

ALTER TABLE "appointment_holds"
  ADD COLUMN "resource_assignment_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "appointment_holds_resource_assignment_snapshot_check"
    CHECK (jsonb_typeof("resource_assignment_snapshot") = 'array');

ALTER TABLE "appointments"
  ADD COLUMN "resource_assignment_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "appointments_resource_assignment_snapshot_check"
    CHECK (jsonb_typeof("resource_assignment_snapshot") = 'array');

ALTER TABLE "partner_booking_drafts"
  ADD COLUMN "schedule_assistance_preference" text NOT NULL DEFAULT 'none',
  ADD CONSTRAINT "partner_booking_drafts_schedule_assistance_check"
    CHECK ("schedule_assistance_preference" IN ('none', 'waitlist', 'callback'));

CREATE TABLE "partner_schedule_assistance_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "partner_booking_id" uuid NOT NULL,
  "booking_draft_id" uuid NOT NULL,
  "requested_by_membership_id" uuid NOT NULL,
  "preference" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "preferred_windows_snapshot" jsonb NOT NULL,
  "operation_key_hash" varchar(64) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "resolved_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "resolution_note" text,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_schedule_assistance_preference_check"
    CHECK ("preference" IN ('waitlist', 'callback')),
  CONSTRAINT "partner_schedule_assistance_state_check"
    CHECK ("state" IN ('pending', 'contacted', 'fulfilled', 'canceled')),
  CONSTRAINT "partner_schedule_assistance_windows_check"
    CHECK (
      jsonb_typeof("preferred_windows_snapshot") = 'object'
      AND "preferred_windows_snapshot" ->> 'version' = '1'
      AND jsonb_typeof("preferred_windows_snapshot" -> 'windows') = 'array'
      AND jsonb_array_length("preferred_windows_snapshot" -> 'windows') BETWEEN 1 AND 3
    ),
  CONSTRAINT "partner_schedule_assistance_operation_hash_check"
    CHECK ("operation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_schedule_assistance_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_schedule_assistance_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "partner_schedule_assistance_resolution_check"
    CHECK (
      ("state" = 'pending' AND "resolved_by_team_member_id" IS NULL AND "resolution_note" IS NULL AND "resolved_at" IS NULL)
      OR
      ("state" <> 'pending' AND "resolved_by_team_member_id" IS NOT NULL AND length(btrim("resolution_note")) BETWEEN 5 AND 1000 AND "resolved_at" IS NOT NULL)
    ),
  CONSTRAINT "partner_schedule_assistance_booking_account_fk"
    FOREIGN KEY ("partner_account_id", "partner_booking_id")
    REFERENCES "partner_bookings"("partner_account_id", "id") ON DELETE CASCADE,
  CONSTRAINT "partner_schedule_assistance_draft_account_fk"
    FOREIGN KEY ("partner_account_id", "booking_draft_id")
    REFERENCES "partner_booking_drafts"("partner_account_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "partner_schedule_assistance_requester_account_fk"
    FOREIGN KEY ("requested_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "partner_schedule_assistance_booking_key"
  ON "partner_schedule_assistance_requests" ("partner_account_id", "partner_booking_id");
CREATE UNIQUE INDEX "partner_schedule_assistance_operation_key"
  ON "partner_schedule_assistance_requests" ("partner_account_id", "operation_key_hash");
CREATE INDEX "partner_schedule_assistance_queue_idx"
  ON "partner_schedule_assistance_requests" ("state", "created_at", "id");

CREATE OR REPLACE FUNCTION "ensure_compatibility_schedule_resources"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  compatibility_kind text;
BEGIN
  FOREACH compatibility_kind IN ARRAY ARRAY['crew', 'truck']::text[] LOOP
    INSERT INTO "schedule_resources" (
      "capacity_pool_key", "kind", "label", "capacity_units", "skill_keys",
      "active", "source", "source_key", "created_at", "updated_at"
    ) VALUES (
      NEW."key", compatibility_kind,
      NEW."label" || CASE WHEN compatibility_kind = 'crew' THEN ' crew' ELSE ' fleet' END,
      NEW."capacity_units", ARRAY['general_field_service']::text[],
      NEW."active", 'compatibility_pool',
      'pool:' || NEW."key" || ':' || compatibility_kind, now(), now()
    )
    ON CONFLICT ("source_key") WHERE "source_key" IS NOT NULL
    DO UPDATE SET
      "capacity_pool_key" = EXCLUDED."capacity_pool_key",
      "label" = EXCLUDED."label",
      "capacity_units" = EXCLUDED."capacity_units",
      "active" = EXCLUDED."active",
      "updated_at" = now()
    WHERE "schedule_resources"."source" = 'compatibility_pool';
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "schedule_resource_pools_compatibility_resources"
AFTER INSERT OR UPDATE OF "label", "capacity_units", "active"
ON "schedule_resource_pools"
FOR EACH ROW EXECUTE FUNCTION "ensure_compatibility_schedule_resources"();

INSERT INTO "schedule_resources" (
  "capacity_pool_key", "kind", "label", "capacity_units", "skill_keys",
  "active", "source", "source_key"
)
SELECT pool."key", kind.value,
  pool."label" || CASE WHEN kind.value = 'crew' THEN ' crew' ELSE ' fleet' END,
  pool."capacity_units", ARRAY['general_field_service']::text[], pool."active",
  'compatibility_pool', 'pool:' || pool."key" || ':' || kind.value
FROM "schedule_resource_pools" pool
CROSS JOIN (VALUES ('crew'), ('truck')) AS kind(value)
ON CONFLICT ("source_key") WHERE "source_key" IS NOT NULL DO NOTHING;

UPDATE "appointments" appointment
SET "resource_assignment_snapshot" = assignment.snapshot
FROM (
  SELECT candidate."id",
    jsonb_agg(
      jsonb_build_object(
        'resourceId', resource."id",
        'kind', resource."kind",
        'label', resource."label",
        'capacityUnits', candidate."capacity_units"
      )
      ORDER BY resource."kind", resource."id"
    ) AS snapshot
  FROM "appointments" candidate
  JOIN "schedule_resources" resource
    ON resource."capacity_pool_key" = candidate."capacity_pool_key"
   AND resource."source" = 'compatibility_pool'
   AND resource."active" = true
  WHERE candidate."start_at" IS NOT NULL
    AND candidate."status" NOT IN ('canceled', 'completed', 'no_show')
  GROUP BY candidate."id"
) assignment
WHERE appointment."id" = assignment."id";

UPDATE "appointment_holds" hold
SET "resource_assignment_snapshot" = assignment.snapshot
FROM (
  SELECT candidate."id",
    jsonb_agg(
      jsonb_build_object(
        'resourceId', resource."id",
        'kind', resource."kind",
        'label', resource."label",
        'capacityUnits', candidate."capacity_units"
      )
      ORDER BY resource."kind", resource."id"
    ) AS snapshot
  FROM "appointment_holds" candidate
  JOIN "schedule_resources" resource
    ON resource."capacity_pool_key" = candidate."capacity_pool_key"
   AND resource."source" = 'compatibility_pool'
   AND resource."active" = true
  WHERE candidate."status" = 'active'
  GROUP BY candidate."id"
) assignment
WHERE hold."id" = assignment."id";

CREATE OR REPLACE FUNCTION "ensure_compatibility_profile_resources"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  compatibility_kind text;
BEGIN
  FOREACH compatibility_kind IN ARRAY ARRAY['crew', 'truck']::text[] LOOP
    INSERT INTO "partner_scheduling_profile_resource_requirements" (
      "scheduling_profile_id", "resource_kind", "quantity", "capacity_units",
      "required_skill_keys", "source", "created_at", "updated_at"
    ) VALUES (
      NEW."id", compatibility_kind, 1, NEW."capacity_units",
      ARRAY['general_field_service']::text[], 'compatibility_pool', now(), now()
    )
    ON CONFLICT ("scheduling_profile_id", "resource_kind")
    DO UPDATE SET "capacity_units" = EXCLUDED."capacity_units", "updated_at" = now()
    WHERE "partner_scheduling_profile_resource_requirements"."source" = 'compatibility_pool';
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_scheduling_profiles_compatibility_resources"
AFTER INSERT OR UPDATE OF "capacity_units"
ON "partner_scheduling_profiles"
FOR EACH ROW EXECUTE FUNCTION "ensure_compatibility_profile_resources"();

INSERT INTO "partner_scheduling_profile_resource_requirements" (
  "scheduling_profile_id", "resource_kind", "quantity", "capacity_units",
  "required_skill_keys", "source"
)
SELECT profile."id", kind.value, 1, profile."capacity_units",
  ARRAY['general_field_service']::text[], 'compatibility_pool'
FROM "partner_scheduling_profiles" profile
CROSS JOIN (VALUES ('crew'), ('truck')) AS kind(value)
ON CONFLICT ("scheduling_profile_id", "resource_kind") DO NOTHING;

CREATE OR REPLACE FUNCTION "enforce_partner_schedule_assistance_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."booking_draft_id" IS DISTINCT FROM OLD."booking_draft_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."preference" IS DISTINCT FROM OLD."preference"
    OR NEW."preferred_windows_snapshot" IS DISTINCT FROM OLD."preferred_windows_snapshot"
    OR NEW."operation_key_hash" IS DISTINCT FROM OLD."operation_key_hash"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_schedule_assistance_evidence_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."state" NOT IN ('contacted', 'fulfilled', 'canceled')
    OR (OLD."state" = 'pending' AND NEW."state" NOT IN ('contacted', 'fulfilled', 'canceled'))
    OR (OLD."state" = 'contacted' AND NEW."state" NOT IN ('fulfilled', 'canceled'))
    OR OLD."state" IN ('fulfilled', 'canceled')
    OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'partner_schedule_assistance_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_schedule_assistance_evidence_immutable"
BEFORE UPDATE ON "partner_schedule_assistance_requests"
FOR EACH ROW EXECUTE FUNCTION "enforce_partner_schedule_assistance_evidence"();

COMMENT ON TABLE "schedule_resources" IS
  'Named crew, truck, and equipment capacity with explicit skills; compatibility resources preserve existing weighted-pool behavior until Staff configures physical resources.';
COMMENT ON TABLE "partner_schedule_assistance_requests" IS
  'Durable, account-owned Partner waitlist or scheduling-callback intent created atomically with an unscheduled review booking.';
