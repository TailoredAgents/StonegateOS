-- Expand-first migration: keep the legacy policy value for rollback while all
-- authentication and new writes move to team_members.phone_e164.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "phone_e164" text;

-- Access has historically stored canonical +E.164 values, but this backfill
-- also accepts common US formatting. Invalid values and any phone shared by
-- more than one member are deliberately left NULL so login fails closed.
WITH legacy_entries AS (
  SELECT
    tm.id AS member_id,
    btrim(entry.value) AS raw_phone
  FROM "policy_settings" ps
  CROSS JOIN LATERAL jsonb_each_text(
    CASE
      WHEN jsonb_typeof(ps.value -> 'phones') = 'object'
        THEN ps.value -> 'phones'
      ELSE '{}'::jsonb
    END
  ) AS entry(key, value)
  INNER JOIN "team_members" tm ON tm.id::text = entry.key
  WHERE ps.key = 'team_member_phones'
), normalized_entries AS (
  SELECT
    member_id,
    CASE
      WHEN raw_phone ~ '^\+[1-9][0-9]{9,14}$'
        THEN raw_phone
      WHEN regexp_replace(raw_phone, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
        THEN '+1' || regexp_replace(raw_phone, '[^0-9]', '', 'g')
      ELSE NULL
    END AS phone_e164
  FROM legacy_entries
), unambiguous_phones AS (
  SELECT phone_e164
  FROM normalized_entries
  WHERE phone_e164 IS NOT NULL
  GROUP BY phone_e164
  HAVING count(*) = 1
)
UPDATE "team_members" tm
SET "phone_e164" = normalized.phone_e164
FROM normalized_entries normalized
INNER JOIN unambiguous_phones unique_phone
  ON unique_phone.phone_e164 = normalized.phone_e164
WHERE tm.id = normalized.member_id
  AND tm.phone_e164 IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "team_members" existing
    WHERE existing.phone_e164 = normalized.phone_e164
      AND existing.id <> normalized.member_id
  );

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_phone_e164_format";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_phone_e164_format"
  CHECK (
    "phone_e164" IS NULL
    OR "phone_e164" ~ '^\+[1-9][0-9]{9,14}$'
  ) NOT VALID;

ALTER TABLE "team_members"
  VALIDATE CONSTRAINT "team_members_phone_e164_format";

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_phone_e164_key"
  ON "team_members" ("phone_e164")
  WHERE "phone_e164" IS NOT NULL;

COMMENT ON COLUMN "team_members"."phone_e164" IS
  'Normalized, unique team login/calling identity. Legacy ambiguous or invalid policy values remain NULL.';
