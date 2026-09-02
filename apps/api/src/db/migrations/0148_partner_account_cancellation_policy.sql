-- Canonical account-specific Partner cancellation constraints. Account policy
-- can only narrow Stonegate's global rule: effective notice uses max
-- precedence and direct-cancellation eligibility uses logical AND. Late
-- requests remain scheduled for staff review and no fee is applied
-- automatically by this policy.

CREATE TABLE "partner_account_cancellation_policies" (
  "partner_account_id" uuid PRIMARY KEY
    REFERENCES "partner_accounts"("id") ON DELETE CASCADE,
  "minimum_notice_minutes" integer NOT NULL DEFAULT 1440,
  "direct_cancellation_enabled" boolean NOT NULL DEFAULT true,
  "late_cancellation_disposition" text NOT NULL DEFAULT 'staff_review',
  "automatic_fee_minor" integer,
  "revision" integer NOT NULL DEFAULT 1,
  "last_changed_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "partner_account_cancellation_policies_notice_check"
    CHECK ("minimum_notice_minutes" BETWEEN 1440 AND 525600),
  CONSTRAINT "partner_account_cancellation_policies_late_disposition_check"
    CHECK ("late_cancellation_disposition" = 'staff_review'),
  CONSTRAINT "partner_account_cancellation_policies_no_automatic_fee_check"
    CHECK ("automatic_fee_minor" IS NULL),
  CONSTRAINT "partner_account_cancellation_policies_revision_check"
    CHECK ("revision" > 0)
);

CREATE INDEX "partner_account_cancellation_policies_changed_by_idx"
  ON "partner_account_cancellation_policies"
  ("last_changed_by_team_member_id", "updated_at");

INSERT INTO "partner_account_cancellation_policies" (
  "partner_account_id",
  "minimum_notice_minutes",
  "direct_cancellation_enabled",
  "late_cancellation_disposition",
  "automatic_fee_minor"
)
SELECT "id", 1440, true, 'staff_review', NULL
FROM "partner_accounts"
ON CONFLICT ("partner_account_id") DO NOTHING;

-- Seed future accounts independently of any one application/approval caller.
CREATE OR REPLACE FUNCTION "seed_partner_account_cancellation_policy"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "partner_account_cancellation_policies" (
    "partner_account_id",
    "minimum_notice_minutes",
    "direct_cancellation_enabled",
    "late_cancellation_disposition",
    "automatic_fee_minor"
  ) VALUES (NEW."id", 1440, true, 'staff_review', NULL)
  ON CONFLICT ("partner_account_id") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "partner_accounts_seed_cancellation_policy"
AFTER INSERT ON "partner_accounts"
FOR EACH ROW
EXECUTE FUNCTION "seed_partner_account_cancellation_policy"();

COMMENT ON TABLE "partner_account_cancellation_policies" IS
  'Account-specific Partner cancellation constraints; may only narrow Stonegate global cancellation policy.';
COMMENT ON COLUMN "partner_account_cancellation_policies"."automatic_fee_minor" IS
  'Reserved for a separately approved fee model; constrained to NULL so this policy never charges automatically.';
