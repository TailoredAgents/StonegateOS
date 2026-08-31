-- Existing access applications created before the limited-workspace policy
-- received only account.read. Expand only that exact generated role shape;
-- never overwrite an administrator-customized applicant role.
UPDATE "partner_role_templates"
SET
  "capabilities" = ARRAY[
    'account.read',
    'bookings.read',
    'bookings.create',
    'properties.read',
    'properties.manage',
    'jobs.read',
    'media.read',
    'media.upload',
    'proof.read',
    'proof.request',
    'messages.read',
    'messages.send'
  ]::text[],
  "version" = "version" + 1,
  "updated_at" = statement_timestamp()
WHERE
  "partner_account_id" IS NOT NULL
  AND "key" = 'applicant'
  AND "is_system" = false
  AND "active" = true
  AND "capabilities" = ARRAY['account.read']::text[];
