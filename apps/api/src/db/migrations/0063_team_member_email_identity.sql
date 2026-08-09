-- Expand-first email identity migration. The human-facing email remains on
-- team_members.email, while authentication uses email_normalized only after a
-- legacy identity has been proven unique.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "email_normalized" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "email_identity_status" text NOT NULL DEFAULT 'none';

-- Normalize every stored value. Unique identities become login-ready;
-- duplicate identities remain visible but are deliberately quarantined from
-- authentication instead of choosing either account.
WITH normalized_members AS (
  SELECT
    id,
    nullif(lower(btrim(email)), '') AS normalized_email
  FROM "team_members"
), assessed_members AS (
  SELECT
    normalized.id,
    normalized.normalized_email,
    CASE
      WHEN normalized.normalized_email IS NULL THEN 0
      ELSE count(*) OVER (PARTITION BY normalized.normalized_email)
    END AS identity_count
  FROM normalized_members normalized
)
UPDATE "team_members" member
SET
  "email" = assessed.normalized_email,
  "email_normalized" = CASE
    WHEN assessed.normalized_email IS NOT NULL
      AND assessed.identity_count = 1
      THEN assessed.normalized_email
    ELSE NULL
  END,
  "email_identity_status" = CASE
    WHEN assessed.normalized_email IS NULL THEN 'none'
    WHEN assessed.identity_count = 1 THEN 'ready'
    ELSE 'needs_review'
  END
FROM assessed_members assessed
WHERE member.id = assessed.id;

-- Existing sessions and links for ambiguous identities are invalidated. A
-- reviewer must give each affected member a distinct address (or clear it)
-- before that member can authenticate by email again.
UPDATE "team_sessions" session
SET "revoked_at" = now()
FROM "team_members" member
WHERE session.team_member_id = member.id
  AND member.email_identity_status = 'needs_review'
  AND session.revoked_at IS NULL;

DELETE FROM "team_login_tokens" token
USING "team_members" member
WHERE token.team_member_id = member.id
  AND member.email_identity_status = 'needs_review';

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_email_identity_status_valid";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_email_identity_status_valid"
  CHECK ("email_identity_status" IN ('ready', 'needs_review', 'none'))
  NOT VALID;

ALTER TABLE "team_members"
  VALIDATE CONSTRAINT "team_members_email_identity_status_valid";

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_email_canonical";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_email_canonical"
  CHECK (
    "email" IS NULL
    OR (
      "email" = lower(btrim("email"))
      AND length("email") > 0
    )
  ) NOT VALID;

ALTER TABLE "team_members"
  VALIDATE CONSTRAINT "team_members_email_canonical";

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_email_identity_state";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_email_identity_state"
  CHECK (
    (
      "email_identity_status" = 'ready'
      AND "email" IS NOT NULL
      AND "email_normalized" = "email"
    )
    OR (
      "email_identity_status" = 'needs_review'
      AND "email" IS NOT NULL
      AND "email_normalized" IS NULL
    )
    OR (
      "email_identity_status" = 'none'
      AND "email" IS NULL
      AND "email_normalized" IS NULL
    )
  ) NOT VALID;

ALTER TABLE "team_members"
  VALIDATE CONSTRAINT "team_members_email_identity_state";

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_email_normalized_key"
  ON "team_members" ("email_normalized")
  WHERE "email_normalized" IS NOT NULL;

-- Keep every future insert/update canonical even if a caller bypasses the
-- Access route. A quarantined legacy identity reserves its address until a
-- reviewer resolves every member in that duplicate group.
CREATE OR REPLACE FUNCTION enforce_team_member_email_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_email text;
BEGIN
  canonical_email := nullif(lower(btrim(NEW.email)), '');
  NEW.email := canonical_email;

  IF canonical_email IS NULL THEN
    NEW.email_normalized := NULL;
    NEW.email_identity_status := 'none';
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "team_members" existing
    WHERE existing.id IS DISTINCT FROM NEW.id
      AND lower(btrim(existing.email)) = canonical_email
  ) THEN
    RAISE EXCEPTION 'team member email identity is already in use'
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'team_members_email_normalized_key';
  END IF;

  NEW.email_normalized := canonical_email;
  NEW.email_identity_status := 'ready';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "team_members_email_identity_guard" ON "team_members";

CREATE TRIGGER "team_members_email_identity_guard"
BEFORE INSERT OR UPDATE OF "email", "email_normalized", "email_identity_status"
ON "team_members"
FOR EACH ROW
EXECUTE FUNCTION enforce_team_member_email_identity();

COMMENT ON COLUMN "team_members"."email_normalized" IS
  'Canonical unique email used for authentication. NULL while a legacy duplicate needs review.';

COMMENT ON COLUMN "team_members"."email_identity_status" IS
  'Email identity rollout state: ready, needs_review, or none.';
