-- Appointment concurrency tokens cross the HTTP boundary as JavaScript ISO
-- strings, whose precision is milliseconds. PostgreSQL's default now() keeps
-- microseconds, so a freshly inserted row could pass the HTTP If-Match check
-- and then fail the transaction's exact updated_at compare-and-swap.
--
-- Truncate existing values (matching JavaScript Date parsing) and constrain
-- future database defaults/raw SQL writes to the precision the API exposes.
ALTER TABLE "appointments"
  ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone
  USING date_trunc('milliseconds', "updated_at");

COMMENT ON COLUMN "appointments"."updated_at" IS
  'Millisecond-precision optimistic concurrency token exposed as an ISO timestamp.';
