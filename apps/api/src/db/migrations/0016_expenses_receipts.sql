ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "coverage_start_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "coverage_end_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "receipt_filename" text,
  ADD COLUMN IF NOT EXISTS "receipt_url" text,
  ADD COLUMN IF NOT EXISTS "receipt_content_type" text;

-- Ensure default roles gain expense permissions (without overwriting custom perms).
UPDATE "team_roles"
SET "permissions" = (
  SELECT ARRAY(
    SELECT DISTINCT UNNEST("permissions" || ARRAY['expenses.read','expenses.write'])
  )
)
WHERE "slug" IN ('office', 'crew');
