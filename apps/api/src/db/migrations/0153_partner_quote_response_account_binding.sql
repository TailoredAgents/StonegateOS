-- Partner-member response evidence must bind to the same account as the
-- canonical Quote V2 aggregate. Public, Staff, and system responses retain a
-- null Partner account and are unaffected by MATCH SIMPLE semantics.

ALTER TABLE "quote_responses"
  ADD CONSTRAINT "quote_responses_quote_partner_account_fk"
    FOREIGN KEY ("quote_id", "partner_account_id")
    REFERENCES "quotes"("id", "partner_account_id")
    ON DELETE RESTRICT;

COMMENT ON CONSTRAINT "quote_responses_quote_partner_account_fk"
  ON "quote_responses" IS
  'Prevents Partner account A actor evidence from being attached to Partner account B canonical quote state.';
