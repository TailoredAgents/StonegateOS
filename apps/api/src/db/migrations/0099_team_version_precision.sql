-- These updated_at columns cross the /team HTTP boundary as canonical
-- JavaScript ISO strings and also participate in exact SQL compare-and-swap
-- predicates. JavaScript Date preserves milliseconds, while PostgreSQL's
-- default now() preserves microseconds.
--
-- Production reporting views can depend on some of these columns. PostgreSQL
-- does not permit an in-place type alteration while such a view exists, even
-- when the source and target types are both timestamptz. Normalize every
-- independent table and explicitly defer only dependency-owned columns; the
-- application still emits millisecond-precision values for deferred tables.
DO $migration$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contacts',
    'crm_pipeline',
    'crm_tasks',
    'team_roles',
    'team_members',
    'merge_suggestions',
    'partner_users',
    'partner_rate_cards',
    'google_ads_analyst_recommendations',
    'staff_notification_operations',
    'payment_attempts',
    'payments',
    'payment_refunds'
  ]
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN updated_at TYPE timestamp(3) with time zone USING date_trunc(''milliseconds'', updated_at)',
        table_name
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.updated_at IS %L',
        table_name,
        'Millisecond-precision optimistic concurrency token exposed through /team.'
      );
    EXCEPTION
      WHEN feature_not_supported OR dependent_objects_still_exist THEN
        RAISE NOTICE
          'Deferred updated_at precision change for % because a database object depends on it',
          table_name;
    END;
  END LOOP;
END
$migration$;
