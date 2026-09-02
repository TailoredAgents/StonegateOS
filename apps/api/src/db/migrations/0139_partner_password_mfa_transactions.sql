-- Purpose-bound pre-authentication state for password logins that require MFA.
-- No row in this table is accepted by portal session authorization.

CREATE UNIQUE INDEX "partner_account_memberships_id_account_user_key"
  ON "partner_account_memberships" (
    "id",
    "partner_account_id",
    "partner_user_id"
  );

CREATE TABLE "partner_auth_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_user_id" uuid NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "partner_membership_id" uuid NOT NULL,
  "token_hash" varchar(43) NOT NULL,
  "purpose" text DEFAULT 'password_login_mfa' NOT NULL,
  "security_version" integer NOT NULL,
  "remember_me" boolean DEFAULT false NOT NULL,
  "requested_ip" text,
  "requested_user_agent" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "completed_session_id" uuid REFERENCES "partner_sessions"("id")
    ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_auth_transactions_membership_binding_fk"
    FOREIGN KEY (
      "partner_membership_id",
      "partner_account_id",
      "partner_user_id"
    ) REFERENCES "partner_account_memberships" (
      "id",
      "partner_account_id",
      "partner_user_id"
    ) ON DELETE CASCADE,
  CONSTRAINT "partner_auth_transactions_purpose_check"
    CHECK ("purpose" = 'password_login_mfa'),
  CONSTRAINT "partner_auth_transactions_token_hash_check"
    CHECK ("token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "partner_auth_transactions_security_version_check"
    CHECK ("security_version" > 0),
  CONSTRAINT "partner_auth_transactions_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 8),
  CONSTRAINT "partner_auth_transactions_expiry_check"
    CHECK (
      "expires_at" > "created_at"
      AND "expires_at" <= "created_at" + interval '10 minutes'
    ),
  CONSTRAINT "partner_auth_transactions_completion_check"
    CHECK (
      "completed_session_id" IS NULL
      OR "consumed_at" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "partner_auth_transactions_token_hash_key"
  ON "partner_auth_transactions" ("token_hash");

CREATE UNIQUE INDEX "partner_auth_transactions_active_user_key"
  ON "partner_auth_transactions" ("partner_user_id")
  WHERE "consumed_at" IS NULL;

CREATE INDEX "partner_auth_transactions_expiry_idx"
  ON "partner_auth_transactions" ("expires_at", "consumed_at");

ALTER TABLE "audit_logs"
  DROP CONSTRAINT "audit_logs_auth_method_check";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_auth_method_check"
  CHECK (
    "auth_method" IS NULL
    OR "auth_method" IN (
      'team_session',
      'break_glass',
      'partner_session',
      'partner_pre_auth',
      'service'
    )
  );

COMMENT ON TABLE "partner_auth_transactions" IS
  'One-use, hashed password pre-authentication transactions that grant only MFA completion authority.';
