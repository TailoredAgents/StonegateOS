-- Staff-authored, account-scoped Partner approval-rule administration.
-- Existing Partner-created rules retain their creator. New Staff-created rules
-- carry explicit Team provenance, and captured approval-request evidence is
-- protected from later rule administration.

ALTER TABLE "partner_approval_rules"
  ADD COLUMN "created_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  ADD COLUMN "updated_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT;

ALTER TABLE "partner_approval_rules"
  ALTER COLUMN "created_by_membership_id" DROP NOT NULL;

ALTER TABLE "partner_approval_rules"
  DROP CONSTRAINT IF EXISTS "partner_approval_rules_created_by_membership_id_fkey";

ALTER TABLE "partner_approval_rules"
  ADD CONSTRAINT "partner_approval_rules_creator_membership_account_fk"
    FOREIGN KEY ("created_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_approval_rules_creator_provenance_check"
    CHECK (
      num_nonnulls(
        "created_by_membership_id",
        "created_by_team_member_id"
      ) = 1
    );

-- Launch authorization is capability-based. Historical role-name selectors
-- were display-only and must not remain an alternate authorization path.
UPDATE "partner_approval_rules"
SET
  "required_approver_role_keys" = ARRAY[]::text[],
  "required_approver_capabilities" = ARRAY['approvals.decide']::text[];

ALTER TABLE "partner_approval_rules"
  ADD CONSTRAINT "partner_approval_rules_name_check"
    CHECK (
      "name" = btrim("name")
      AND length("name") BETWEEN 1 AND 160
    ),
  ADD CONSTRAINT "partner_approval_rules_conditions_object_check"
    CHECK (jsonb_typeof("conditions") = 'object'),
  ADD CONSTRAINT "partner_approval_rules_fixed_capability_check"
    CHECK (
      "required_approver_capabilities" = ARRAY['approvals.decide']::text[]
      AND "required_approver_role_keys" = ARRAY[]::text[]
    );

CREATE UNIQUE INDEX "partner_approval_rules_account_rule_key"
  ON "partner_approval_rules" ("partner_account_id", "id");

CREATE INDEX "partner_approval_rules_team_creator_idx"
  ON "partner_approval_rules" ("created_by_team_member_id", "created_at")
  WHERE "created_by_team_member_id" IS NOT NULL;

CREATE INDEX "partner_approval_rules_team_updater_idx"
  ON "partner_approval_rules" ("updated_by_team_member_id", "updated_at")
  WHERE "updated_by_team_member_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "enforce_partner_approval_request_evidence_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."partner_account_id" IS DISTINCT FROM OLD."partner_account_id"
    OR NEW."partner_booking_id" IS DISTINCT FROM OLD."partner_booking_id"
    OR NEW."booking_draft_id" IS DISTINCT FROM OLD."booking_draft_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."rule_snapshot" IS DISTINCT FROM OLD."rule_snapshot"
    OR NEW."request_snapshot" IS DISTINCT FROM OLD."request_snapshot"
    OR NEW."required_decision_count" IS DISTINCT FROM OLD."required_decision_count"
    OR NEW."approval_hold_id" IS DISTINCT FROM OLD."approval_hold_id"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'partner_approval_request_evidence_immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_approval_requests_evidence_immutable"
BEFORE UPDATE ON "partner_approval_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_partner_approval_request_evidence_immutable"();

COMMENT ON COLUMN "partner_approval_rules"."created_by_team_member_id" IS
  'Stonegate Team actor that created a Staff-authored rule; mutually exclusive with Partner membership creator.';
COMMENT ON COLUMN "partner_approval_rules"."updated_by_team_member_id" IS
  'Most recent Stonegate Team actor to revise or deactivate the rule.';
COMMENT ON TRIGGER "partner_approval_requests_evidence_immutable"
  ON "partner_approval_requests" IS
  'Prevents approval-rule administration from rewriting captured request evidence.';
