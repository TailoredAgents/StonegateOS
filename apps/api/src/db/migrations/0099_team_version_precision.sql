-- These updated_at columns cross the /team HTTP boundary as canonical
-- JavaScript ISO strings and also participate in exact SQL compare-and-swap
-- predicates. The application schema and write paths emit millisecond values.
--
-- Production reporting views depend on these columns. PostgreSQL cannot alter
-- a view-owned source column in place, and performing the required coordinated
-- view recreation is intentionally outside this additive roster rollout.
-- Keep this migration as an explicit, safe checkpoint; a dedicated reporting
-- migration can normalize the stored column precision later.
DO $migration$
BEGIN
  RAISE NOTICE
    'Deferred /team updated_at storage precision changes because production reporting views own dependencies';
END
$migration$;
