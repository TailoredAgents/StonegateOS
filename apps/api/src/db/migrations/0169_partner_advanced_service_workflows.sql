-- A recurring agreement keeps the approved template version even if a saved shortcut changes.
ALTER TABLE partner_recurring_series ADD COLUMN template_snapshot jsonb, ADD COLUMN occurrences_expanded_at timestamptz, ADD COLUMN location_id uuid REFERENCES partner_account_locations(id) ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE partner_recurring_series s
SET location_id = t.location_id, template_snapshot = jsonb_build_object('id', t.id, 'name', t.name, 'serviceKey', t.service_key, 'locationId', t.location_id, 'reusable', t.template_data, 'version', t.version, 'updatedAt', t.updated_at, 'etag', '"partner-service-template:' || t.id::text || ':' || t.version::text || '"')
FROM partner_service_templates t
WHERE s.template_id = t.id AND s.partner_account_id = t.partner_account_id AND s.template_snapshot IS NULL;
--> statement-breakpoint
ALTER TABLE partner_bulk_import_rows ADD COLUMN raw_data jsonb NOT NULL DEFAULT '{}', ADD COLUMN processing_started_at timestamptz, ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE partner_bulk_import_rows DROP CONSTRAINT partner_bulk_import_rows_state_check;
--> statement-breakpoint
ALTER TABLE partner_bulk_import_rows ADD CONSTRAINT partner_bulk_import_rows_state_check CHECK (state IN ('pending', 'processing', 'invalid', 'review', 'created', 'failed'));
--> statement-breakpoint
ALTER TABLE partner_recurring_series ADD CONSTRAINT partner_recurring_series_location_account_fk FOREIGN KEY (partner_account_id, location_id) REFERENCES partner_account_locations(partner_account_id, id) ON DELETE RESTRICT;
