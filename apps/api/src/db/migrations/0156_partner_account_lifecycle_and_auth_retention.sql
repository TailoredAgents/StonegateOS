-- Canonical Partner account lifecycle controls and bounded authentication
-- metadata retention. Account closure never deletes operational or financial
-- records; it only removes portal eligibility and active sessions.

ALTER TABLE "partner_accounts"
  ADD COLUMN "portal_lifecycle_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN "portal_lifecycle_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "portal_lifecycle_changed_at" timestamptz,
  ADD COLUMN "portal_lifecycle_changed_by_team_member_id" uuid,
  ADD COLUMN "portal_lifecycle_reason" varchar(1000),
  ADD COLUMN "portal_lifecycle_prior_access_enabled" boolean,
  ADD COLUMN "merged_into_partner_account_id" uuid;

ALTER TABLE "partner_accounts"
  ADD CONSTRAINT "partner_accounts_portal_lifecycle_status_check"
    CHECK ("portal_lifecycle_status" IN ('active', 'suspended', 'closed', 'merged')),
  ADD CONSTRAINT "partner_accounts_portal_lifecycle_revision_check"
    CHECK ("portal_lifecycle_revision" > 0),
  ADD CONSTRAINT "partner_accounts_portal_lifecycle_evidence_check"
    CHECK (
      "portal_lifecycle_status" = 'active'
      OR (
        "portal_lifecycle_changed_at" IS NOT NULL
        AND "portal_lifecycle_changed_by_team_member_id" IS NOT NULL
        AND length(btrim("portal_lifecycle_reason")) BETWEEN 20 AND 1000
      )
    ),
  ADD CONSTRAINT "partner_accounts_portal_lifecycle_access_check"
    CHECK (
      "portal_lifecycle_status" = 'active'
      OR (
        "portal_access_enabled" IS false
        AND "portal_lifecycle_prior_access_enabled" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "partner_accounts_merge_shape_check"
    CHECK (
      ("portal_lifecycle_status" = 'merged') =
      ("merged_into_partner_account_id" IS NOT NULL)
      AND "merged_into_partner_account_id" IS DISTINCT FROM "id"
    ),
  ADD CONSTRAINT "partner_accounts_portal_lifecycle_actor_fk"
    FOREIGN KEY ("portal_lifecycle_changed_by_team_member_id")
    REFERENCES "team_members"("id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_accounts_merge_target_fk"
    FOREIGN KEY ("merged_into_partner_account_id")
    REFERENCES "partner_accounts"("id")
    ON DELETE RESTRICT;

CREATE INDEX "partner_accounts_portal_lifecycle_idx"
  ON "partner_accounts" ("portal_lifecycle_status", "updated_at", "id");

CREATE INDEX "partner_accounts_merge_target_idx"
  ON "partner_accounts" ("merged_into_partner_account_id")
  WHERE "merged_into_partner_account_id" IS NOT NULL;

COMMENT ON COLUMN "partner_accounts"."portal_lifecycle_status" IS
  'Portal tenant lifecycle independent of CRM relationship status. Closed or merged accounts retain all business records but cannot authenticate.';

COMMENT ON COLUMN "partner_accounts"."merged_into_partner_account_id" IS
  'Owner-reviewed merge target. A source is marked merged only after the dedicated merge service proves every tenant binding can move safely.';

-- This procedure intentionally preserves security audit rows and business
-- records while removing expired credentials and detailed IP/user-agent/draft
-- metadata after 90 days. It is bounded and safe for recurring worker use.
CREATE OR REPLACE FUNCTION "prune_partner_authentication_metadata"(
  prune_at timestamptz DEFAULT now(),
  prune_limit integer DEFAULT 500
)
RETURNS TABLE (
  challenges_expired integer,
  challenges_sanitized integer,
  applicant_sessions_sanitized integer,
  auth_transactions_deleted integer,
  sessions_sanitized integer,
  login_tokens_deleted integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  retention_cutoff timestamptz := prune_at - interval '90 days';
BEGIN
  IF prune_limit < 1 OR prune_limit > 5000 THEN
    RAISE EXCEPTION 'partner_auth_retention_limit_invalid';
  END IF;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_auth_challenges"
    WHERE "status" = 'pending'
      AND "expires_at" <= prune_at
    ORDER BY "expires_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  UPDATE "partner_auth_challenges" challenge
  SET "status" = 'expired',
      "token_hash" = NULL,
      "expired_at" = prune_at,
      "updated_at" = prune_at
  FROM candidates
  WHERE challenge."id" = candidates."id";
  GET DIAGNOSTICS challenges_expired = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_auth_challenges"
    WHERE "status" IN ('consumed', 'revoked', 'expired')
      AND COALESCE("consumed_at", "revoked_at", "expired_at", "updated_at") < retention_cutoff
      AND (
        "requested_ip" IS NOT NULL
        OR "requested_user_agent" IS NOT NULL
        OR "consumed_ip" IS NOT NULL
        OR "consumed_user_agent" IS NOT NULL
        OR "delivery_detail" IS NOT NULL
        OR "normalized_email" NOT LIKE 'archived+%@invalid.example'
      )
    ORDER BY "updated_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  UPDATE "partner_auth_challenges" challenge
  SET "normalized_email" = 'archived+' || replace(challenge."id"::text, '-', '') || '@invalid.example',
      "requested_ip" = NULL,
      "requested_user_agent" = NULL,
      "consumed_ip" = NULL,
      "consumed_user_agent" = NULL,
      "delivery_detail" = NULL,
      "updated_at" = prune_at
  FROM candidates
  WHERE challenge."id" = candidates."id";
  GET DIAGNOSTICS challenges_sanitized = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_applicant_sessions"
    WHERE "expires_at" < retention_cutoff
      AND (
        "ip" IS NOT NULL
        OR "user_agent" IS NOT NULL
        OR "draft_payload" <> '{}'::jsonb
        OR "normalized_email" NOT LIKE 'archived+%@invalid.example'
      )
    ORDER BY "expires_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  UPDATE "partner_applicant_sessions" applicant_session
  SET "normalized_email" = 'archived+' || replace(applicant_session."id"::text, '-', '') || '@invalid.example',
      "session_hash" = md5('archived:applicant:' || applicant_session."id"::text) || md5('archived:applicant:2:' || applicant_session."id"::text),
      "draft_payload" = '{}'::jsonb,
      "ip" = NULL,
      "user_agent" = NULL,
      "revoked_at" = COALESCE(applicant_session."revoked_at", applicant_session."expires_at"),
      "updated_at" = prune_at
  FROM candidates
  WHERE applicant_session."id" = candidates."id";
  GET DIAGNOSTICS applicant_sessions_sanitized = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_auth_transactions"
    WHERE COALESCE("consumed_at", "expires_at") < retention_cutoff
    ORDER BY "expires_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  DELETE FROM "partner_auth_transactions" auth_transaction
  USING candidates
  WHERE auth_transaction."id" = candidates."id";
  GET DIAGNOSTICS auth_transactions_deleted = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_sessions"
    WHERE "expires_at" < retention_cutoff
      AND ("revoked_at" IS NOT NULL OR "expires_at" <= prune_at)
      AND (
        "ip" IS NOT NULL
        OR "user_agent" IS NOT NULL
        OR "device_name" IS NOT NULL
        OR "session_hash" NOT LIKE 'archived:%'
      )
    ORDER BY "expires_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  UPDATE "partner_sessions" partner_session
  SET "session_hash" = 'archived:' || md5('partner-session:' || partner_session."id"::text) || md5('partner-session:2:' || partner_session."id"::text),
      "ip" = NULL,
      "user_agent" = NULL,
      "device_name" = NULL,
      "revoked_at" = COALESCE(partner_session."revoked_at", partner_session."expires_at")
  FROM candidates
  WHERE partner_session."id" = candidates."id";
  GET DIAGNOSTICS sessions_sanitized = ROW_COUNT;

  WITH candidates AS (
    SELECT "id"
    FROM "partner_login_tokens"
    WHERE COALESCE("used_at", "expires_at") < retention_cutoff
    ORDER BY "expires_at", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT prune_limit
  )
  DELETE FROM "partner_login_tokens" login_token
  USING candidates
  WHERE login_token."id" = candidates."id";
  GET DIAGNOSTICS login_tokens_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION "prune_partner_authentication_metadata"(timestamptz, integer) IS
  'Expires outstanding purpose challenges, removes obsolete one-use auth transactions/tokens, and pseudonymizes detailed Partner authentication metadata after 90 days while retaining account/security audit evidence.';
