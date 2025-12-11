ALTER TABLE leads
ADD COLUMN IF NOT EXISTS instant_quote_id UUID REFERENCES instant_quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_instant_quote_idx ON leads(instant_quote_id);
