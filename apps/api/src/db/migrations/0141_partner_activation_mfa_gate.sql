-- Privileged activation remains pre-authenticated until an authenticator is
-- verified. The transaction is membership/account/security-version bound and
-- the bootstrap secret is bound back to that exact one-use transaction.

ALTER TABLE "partner_auth_transactions"
  ADD COLUMN "source_auth_challenge_id" uuid REFERENCES "partner_auth_challenges"("id") ON DELETE RESTRICT;

ALTER TABLE "partner_auth_transactions"
  DROP CONSTRAINT "partner_auth_transactions_purpose_check";

ALTER TABLE "partner_auth_transactions"
  ADD CONSTRAINT "partner_auth_transactions_purpose_check"
  CHECK ("purpose" IN ('password_login_mfa', 'activation_mfa_setup'));

ALTER TABLE "partner_auth_transactions"
  ADD CONSTRAINT "partner_auth_transactions_purpose_source_check"
  CHECK (
    ("purpose" = 'password_login_mfa' AND "source_auth_challenge_id" IS NULL)
    OR
    ("purpose" = 'activation_mfa_setup' AND "source_auth_challenge_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "partner_auth_transactions_source_challenge_key"
  ON "partner_auth_transactions" ("source_auth_challenge_id")
  WHERE "source_auth_challenge_id" IS NOT NULL;

ALTER TABLE "partner_mfa_enrollment_challenges"
  ADD COLUMN "auth_transaction_id" uuid REFERENCES "partner_auth_transactions"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "partner_mfa_enrollment_auth_transaction_key"
  ON "partner_mfa_enrollment_challenges" ("auth_transaction_id")
  WHERE "auth_transaction_id" IS NOT NULL;

COMMENT ON COLUMN "partner_auth_transactions"."source_auth_challenge_id" IS
  'Consumed account-activation challenge that authorized an activation_mfa_setup transaction.';

COMMENT ON COLUMN "partner_mfa_enrollment_challenges"."auth_transaction_id" IS
  'One-use activation pre-authentication transaction authorized to confirm this bootstrap secret.';
