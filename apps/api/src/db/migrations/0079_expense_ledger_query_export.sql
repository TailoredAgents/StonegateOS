-- Support deterministic keyset pagination in the same order used by the
-- ledger and export routes. The id tie-breaker prevents equal timestamps from
-- creating gaps or duplicate rows between pages.
CREATE INDEX IF NOT EXISTS "expenses_ledger_cursor_idx"
  ON "expenses" ("paid_at" DESC, "created_at" DESC, "id" DESC);

-- Exporting the financial ledger is deliberately separate from reading it in
-- the UI. Preserve the established office workflow while keeping crew,
-- read-only, and custom roles opt-in. Owner roles retain their explicit `*`.
UPDATE team_roles
SET permissions = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(permissions, ARRAY[]::text[]) || ARRAY['expenses.export']
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
WHERE lower(trim(slug)) = 'office';
