ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_auth_method_check";

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_auth_method_check"
  CHECK (
    "auth_method" IS NULL
    OR "auth_method" IN (
      'team_session',
      'break_glass',
      'partner_session',
      'partner_pre_auth',
      'magic_link',
      'password',
      'mfa_step_up',
      'verified_email_session',
      'service'
    )
  ) NOT VALID;

ALTER TABLE "audit_logs"
  VALIDATE CONSTRAINT "audit_logs_auth_method_check";

COMMENT ON COLUMN "audit_logs"."auth_method" IS
  'Verified authentication context for the actor or purpose-bound applicant flow; constrained to application-emitted methods.';
