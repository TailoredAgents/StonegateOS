-- Canonical account-specific Partner scheduling constraints. Account policy
-- can only narrow the global Stonegate Partner channel; effective precedence
-- is max notice, max local-calendar lead, min horizon, and logical AND for
-- instant confirmation. Hours and capacity remain global-only inputs.

CREATE TABLE "partner_account_scheduling_policies" (
  "partner_account_id" uuid PRIMARY KEY
    REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "minimum_notice_minutes" integer NOT NULL DEFAULT 0,
  "minimum_calendar_lead_days" integer NOT NULL DEFAULT 1,
  "maximum_booking_horizon_days" integer NOT NULL DEFAULT 30,
  "instant_confirmation_enabled" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 1,
  "last_changed_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_account_scheduling_policies_notice_check"
    CHECK ("minimum_notice_minutes" BETWEEN 0 AND 10080),
  CONSTRAINT "partner_account_scheduling_policies_lead_days_check"
    CHECK ("minimum_calendar_lead_days" BETWEEN 1 AND 30),
  CONSTRAINT "partner_account_scheduling_policies_horizon_check"
    CHECK ("maximum_booking_horizon_days" BETWEEN 1 AND 30),
  CONSTRAINT "partner_account_scheduling_policies_revision_check"
    CHECK ("revision" > 0)
);

CREATE INDEX "partner_account_scheduling_policies_changed_by_idx"
  ON "partner_account_scheduling_policies"
  ("last_changed_by_team_member_id", "updated_at");

-- Existing accounts start conservatively: their global notice/lead/horizon
-- remain unchanged, but instant confirmation requires an explicit staff
-- enablement after this migration.
INSERT INTO "partner_account_scheduling_policies" (
  "partner_account_id",
  "minimum_notice_minutes",
  "minimum_calendar_lead_days",
  "maximum_booking_horizon_days",
  "instant_confirmation_enabled"
)
SELECT "id", 0, 1, 30, false
FROM "partner_accounts"
ON CONFLICT ("partner_account_id") DO NOTHING;

-- Keep every future account fail-closed and persisted without relying on each
-- account-creation caller to remember a security-sensitive companion write.
CREATE OR REPLACE FUNCTION "seed_partner_account_scheduling_policy"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "partner_account_scheduling_policies" (
    "partner_account_id",
    "minimum_notice_minutes",
    "minimum_calendar_lead_days",
    "maximum_booking_horizon_days",
    "instant_confirmation_enabled"
  ) VALUES (NEW."id", 0, 1, 30, false)
  ON CONFLICT ("partner_account_id") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_accounts_seed_scheduling_policy"
AFTER INSERT ON "partner_accounts"
FOR EACH ROW
EXECUTE FUNCTION "seed_partner_account_scheduling_policy"();

COMMENT ON TABLE "partner_account_scheduling_policies" IS
  'Account-specific Partner self-service constraints; may only narrow Stonegate global scheduling policy.';
COMMENT ON COLUMN "partner_account_scheduling_policies"."instant_confirmation_enabled" IS
  'Fail-closed account gate combined with global, feature, service, pricing, approval, calendar, and capacity gates.';
