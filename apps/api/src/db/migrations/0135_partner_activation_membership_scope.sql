DROP INDEX IF EXISTS "partner_auth_challenges_active_purpose_email_key";

CREATE UNIQUE INDEX "partner_auth_challenges_active_mailbox_purpose_email_key"
  ON "partner_auth_challenges" ("purpose", "normalized_email")
  WHERE "status" = 'pending' AND "purpose" <> 'account_activation';

CREATE UNIQUE INDEX "partner_auth_challenges_active_activation_membership_key"
  ON "partner_auth_challenges" ("purpose", "partner_account_id", "partner_membership_id")
  WHERE "status" = 'pending' AND "purpose" = 'account_activation';

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
      )
    );
