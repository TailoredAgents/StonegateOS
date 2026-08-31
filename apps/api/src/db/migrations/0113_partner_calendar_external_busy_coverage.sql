ALTER TABLE "calendar_sync_state"
  ADD COLUMN "external_busy_coverage_synced_at" timestamp with time zone;

COMMENT ON COLUMN "calendar_sync_state"."external_busy_coverage_synced_at" IS
  'Last successful authoritative Google Calendar external-busy reconciliation. NULL means external busy coverage has never been established.';
