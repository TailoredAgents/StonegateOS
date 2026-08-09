-- These updated_at columns cross the /team HTTP boundary as canonical
-- JavaScript ISO strings and also participate in exact SQL compare-and-swap
-- predicates. JavaScript Date preserves milliseconds, while PostgreSQL's
-- default now() preserves microseconds. Without a shared precision, an
-- unchanged row inserted or updated by SQL can fail its own CAS predicate.
--
-- Normalize existing values exactly as the Node PostgreSQL driver already
-- exposes them and constrain defaults, raw SQL, and ORM writes to that same
-- precision going forward.
ALTER TABLE "contacts"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "crm_pipeline"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "crm_tasks"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "team_roles"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "team_members"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "merge_suggestions"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "partner_users"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "partner_rate_cards"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "google_ads_analyst_recommendations"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "staff_notification_operations"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "payment_attempts"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "payments"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

ALTER TABLE "payment_refunds"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

COMMENT ON COLUMN "contacts"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "crm_pipeline"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "crm_tasks"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "team_roles"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "team_members"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "merge_suggestions"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "partner_users"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "partner_rate_cards"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "google_ads_analyst_recommendations"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "staff_notification_operations"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "payment_attempts"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "payments"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
COMMENT ON COLUMN "payment_refunds"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed through /team.';
