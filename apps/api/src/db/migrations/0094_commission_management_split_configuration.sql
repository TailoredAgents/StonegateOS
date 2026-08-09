-- Move management commission recipients out of application constants and
-- into referentially safe configuration. Existing appointment commissions and
-- locked payout lines are deliberately not rewritten.

CREATE TABLE IF NOT EXISTS "commission_management_splits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "settings_key" text NOT NULL DEFAULT 'default'
    REFERENCES "commission_settings"("key") ON DELETE cascade,
  "member_id" uuid NOT NULL
    REFERENCES "team_members"("id") ON DELETE restrict,
  "split_bps" integer NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_management_splits_split_bps_check"
    CHECK ("split_bps" > 0 AND "split_bps" <= 1000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "commission_management_splits_settings_member_unique"
  ON "commission_management_splits" ("settings_key", "member_id");

CREATE INDEX IF NOT EXISTS
  "commission_management_splits_settings_enabled_idx"
  ON "commission_management_splits" ("settings_key", "enabled");

-- Preserve the established management allocation (12% Jeffrey, 5% Austin)
-- only when the target member already exists and is active. The migration
-- never fabricates a human principal. An incomplete environment therefore
-- remains visibly unconfigured and financial mutations fail closed until an
-- administrator supplies eligible recipients.
INSERT INTO "commission_management_splits" (
  "settings_key",
  "member_id",
  "split_bps",
  "enabled",
  "created_at",
  "updated_at"
)
SELECT
  settings."key",
  member."id",
  legacy."split_bps",
  true,
  now(),
  now()
FROM (
  VALUES
    ('5ac5217e-3905-4ea3-bdeb-65456982f5e3'::uuid, 12000),
    ('239ca36d-e618-4c5c-a283-b6e5d4ccb704'::uuid, 5000)
) AS legacy("member_id", "split_bps")
JOIN "team_members" AS member
  ON member."id" = legacy."member_id"
 AND member."active" = true
JOIN "commission_settings" AS settings
  ON settings."key" = 'default'
ON CONFLICT ("settings_key", "member_id") DO NOTHING;
