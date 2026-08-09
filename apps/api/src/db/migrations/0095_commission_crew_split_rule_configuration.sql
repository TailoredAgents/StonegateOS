-- Move the live crew-combination override out of application UUID constants.
-- Completed appointments and locked payout lines already contain their
-- resolved immutable weights and are deliberately not rewritten.

CREATE TABLE IF NOT EXISTS "commission_crew_split_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "settings_key" text NOT NULL DEFAULT 'default'
    REFERENCES "commission_settings"("key") ON DELETE cascade,
  "rule_key" text NOT NULL,
  "member_id" uuid NOT NULL
    REFERENCES "team_members"("id") ON DELETE restrict,
  "split_bps" integer NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_crew_split_rules_rule_key_check"
    CHECK (char_length(btrim("rule_key")) BETWEEN 1 AND 120),
  CONSTRAINT "commission_crew_split_rules_split_bps_check"
    CHECK ("split_bps" > 0 AND "split_bps" <= 1000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "commission_crew_split_rules_settings_rule_member_unique"
  ON "commission_crew_split_rules" ("settings_key", "rule_key", "member_id");

CREATE INDEX IF NOT EXISTS
  "commission_crew_split_rules_settings_enabled_idx"
  ON "commission_crew_split_rules" ("settings_key", "enabled", "rule_key");

-- Preserve the established three-person allocation only when the complete,
-- active principal set already exists. The literals live solely in this
-- one-time data migration; runtime financial behavior reads referentially safe
-- configuration and never recognizes a person by an application constant.
WITH legacy_rule("member_id", "split_bps") AS (
  VALUES
    ('5ac5217e-3905-4ea3-bdeb-65456982f5e3'::uuid, 300),
    ('239ca36d-e618-4c5c-a283-b6e5d4ccb704'::uuid, 1000),
    ('b45988bb-7417-48c5-af6d-fcdf71088282'::uuid, 700)
), eligible_rule AS (
  SELECT legacy."member_id", legacy."split_bps"
  FROM legacy_rule AS legacy
  JOIN "team_members" AS member
    ON member."id" = legacy."member_id"
   AND member."active" = true
), complete_rule AS (
  SELECT count(*) = 3 AS "ready" FROM eligible_rule
)
INSERT INTO "commission_crew_split_rules" (
  "settings_key",
  "rule_key",
  "member_id",
  "split_bps",
  "enabled",
  "created_at",
  "updated_at"
)
SELECT
  settings."key",
  'launch-adjusted-three-person',
  eligible."member_id",
  eligible."split_bps",
  true,
  now(),
  now()
FROM eligible_rule AS eligible
CROSS JOIN complete_rule
JOIN "commission_settings" AS settings
  ON settings."key" = 'default'
WHERE complete_rule."ready"
ON CONFLICT ("settings_key", "rule_key", "member_id") DO NOTHING;
