ALTER TABLE "commission_settings"
  ALTER COLUMN "marketing_rate_bps" SET DEFAULT 1500;

ALTER TABLE "commission_settings"
  ALTER COLUMN "crew_pool_rate_bps" SET DEFAULT 2250;

UPDATE "commission_settings"
SET
  "sales_rate_bps" = 0,
  "marketing_rate_bps" = 1500,
  "crew_pool_rate_bps" = 2250,
  "marketing_member_id" = NULL,
  "updated_at" = NOW()
WHERE "key" = 'default';

WITH crew_counts AS (
  SELECT "appointment_id", COUNT(*) AS "crew_count"
  FROM "appointment_crew_members"
  GROUP BY "appointment_id"
)
UPDATE "appointment_crew_members" AS acm
SET "split_bps" = CASE
  WHEN crew_counts."crew_count" = 1 THEN 10000
  ELSE 1
END
FROM crew_counts
WHERE acm."appointment_id" = crew_counts."appointment_id";
