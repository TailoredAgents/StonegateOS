-- The original blanket line trigger predates the canonical staff draft writer.
-- Keep the later issued-only guard: issued lines cannot be inserted, edited,
-- deleted, or moved, but an unissued draft may be corrected before review.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'partner_invoice_lines'::regclass
      AND tgname = 'partner_invoice_lines_issued_immutable'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'The issued-invoice line guard must be active before permitting draft edits';
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS partner_invoice_lines_immutable ON partner_invoice_lines;
