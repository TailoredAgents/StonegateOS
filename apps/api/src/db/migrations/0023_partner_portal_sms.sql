ALTER TABLE "partner_users"
  ADD COLUMN IF NOT EXISTS "phone" text;

ALTER TABLE "partner_users"
  ADD COLUMN IF NOT EXISTS "phone_e164" text;

CREATE UNIQUE INDEX IF NOT EXISTS "partner_users_phone_e164_key" ON "partner_users" ("phone_e164");

