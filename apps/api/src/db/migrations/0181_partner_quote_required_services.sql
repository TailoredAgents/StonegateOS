-- Quote-required services are explicit, versioned choices, never zero-priced rates.
ALTER TABLE partner_rate_card_versions
  ADD COLUMN quote_required_service_keys text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT partner_rate_card_versions_quote_services_check CHECK (
    cardinality(quote_required_service_keys) <= 8
    AND array_position(quote_required_service_keys, NULL) IS NULL
    AND quote_required_service_keys <@ ARRAY['junk-removal', 'pressure-washing', 'soft-washing', 'brush-clearing', 'demolition-only', 'demo-hauloff', 'painting', 'drywall-repair-paint']::text[]
  );
