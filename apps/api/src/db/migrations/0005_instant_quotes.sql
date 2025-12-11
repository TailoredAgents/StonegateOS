CREATE TABLE IF NOT EXISTS instant_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'public_site',
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  zip TEXT NOT NULL,
  job_types TEXT[] NOT NULL DEFAULT '{}',
  perceived_size TEXT NOT NULL,
  notes TEXT,
  photo_urls TEXT[] NOT NULL DEFAULT '{}',
  ai_result JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS instant_quotes_created_idx ON instant_quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS instant_quotes_source_idx ON instant_quotes (source);
