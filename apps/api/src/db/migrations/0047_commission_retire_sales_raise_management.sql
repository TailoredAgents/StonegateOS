ALTER TABLE "commission_settings"
  ALTER COLUMN "sales_rate_bps" SET DEFAULT 0;

ALTER TABLE "commission_settings"
  ALTER COLUMN "marketing_rate_bps" SET DEFAULT 2000;

ALTER TABLE "commission_settings"
  ALTER COLUMN "crew_pool_rate_bps" SET DEFAULT 2500;

UPDATE "commission_settings"
SET
  "sales_rate_bps" = 0,
  "marketing_rate_bps" = 2000,
  "crew_pool_rate_bps" = 2500,
  "marketing_member_id" = NULL,
  "updated_at" = NOW()
WHERE "key" = 'default';
