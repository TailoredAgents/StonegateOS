-- Purpose-bound Partner Portal email changes prove possession of the new
-- mailbox without turning that link into a login credential. Exactly one
-- pending change may exist per canonical identity.

ALTER TABLE "partner_auth_challenges"
  DROP CONSTRAINT "partner_auth_challenges_purpose_check",
  ADD CONSTRAINT "partner_auth_challenges_purpose_check"
    CHECK ("purpose" IN ('email_verification', 'account_activation', 'password_reset', 'email_change'));

ALTER TABLE "partner_auth_challenges"
  DROP CONSTRAINT "partner_auth_challenges_subject_check",
  ADD CONSTRAINT "partner_auth_challenges_subject_check"
    CHECK (
      (
        "purpose" = 'email_verification'
        AND "partner_user_id" IS NULL
        AND "partner_account_id" IS NULL
        AND "partner_membership_id" IS NULL
        AND "security_version_snapshot" IS NULL
      ) OR (
        "purpose" = 'account_activation'
        AND "partner_user_id" IS NOT NULL
        AND "partner_account_id" IS NOT NULL
        AND "partner_membership_id" IS NOT NULL
        AND "security_version_snapshot" IS NOT NULL
      ) OR (
        "purpose" = 'password_reset'
        AND "partner_user_id" IS NOT NULL
        AND "partner_account_id" IS NULL
        AND "partner_membership_id" IS NULL
        AND "application_id" IS NULL
        AND "security_version_snapshot" IS NOT NULL
      ) OR (
        "purpose" = 'email_change'
        AND "partner_user_id" IS NOT NULL
        AND "partner_account_id" IS NOT NULL
        AND "partner_membership_id" IS NOT NULL
        AND "application_id" IS NULL
        AND "security_version_snapshot" IS NOT NULL
      )
    );

CREATE UNIQUE INDEX "partner_auth_challenges_active_email_change_user_key"
  ON "partner_auth_challenges" ("partner_user_id")
  WHERE "status" = 'pending' AND "purpose" = 'email_change';

COMMENT ON INDEX "partner_auth_challenges_active_email_change_user_key" IS
  'Prevents concurrent or ambiguous pending email changes for one identity.';
