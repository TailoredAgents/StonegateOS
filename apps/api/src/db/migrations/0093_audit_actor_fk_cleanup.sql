-- Audit events retain their verified actor snapshot even after a team member is
-- removed. PostgreSQL named the original inline FK `audit_logs_actor_id_fkey`,
-- while the earlier hardening migration removed only Drizzle's generated name.
-- Drop both known names and any equivalent legacy FK so member retirement can
-- never rewrite the append-only audit ledger through ON DELETE SET NULL.

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_fkey";

ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_team_members_id_fk";

DO $migration$
DECLARE
  actor_constraint text;
BEGIN
  FOR actor_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'audit_logs'::regclass
      AND constraint_row.confrelid = 'team_members'::regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = 'audit_logs'::regclass
            AND attribute.attname = 'actor_id'
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE "audit_logs" DROP CONSTRAINT %I',
      actor_constraint
    );
  END LOOP;
END
$migration$;

COMMENT ON COLUMN "audit_logs"."actor_id" IS
  'Historical team member UUID snapshot. Deliberately has no mutable FK.';
