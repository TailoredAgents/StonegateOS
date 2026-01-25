ALTER TABLE "team_members"
ADD COLUMN IF NOT EXISTS "permissions_grant" text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE "team_members"
ADD COLUMN IF NOT EXISTS "permissions_deny" text[] NOT NULL DEFAULT '{}'::text[];

