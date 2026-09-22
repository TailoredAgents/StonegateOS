-- Additive commercial-parent model. Historical bookings retain their appointment.
ALTER TABLE partner_accounts
  ADD COLUMN portal_setup_status text NOT NULL DEFAULT 'complete' CHECK (portal_setup_status IN ('complete','rates_required')),
  ADD COLUMN portal_rate_revision integer NOT NULL DEFAULT 1 CHECK (portal_rate_revision > 0),
  ADD COLUMN portal_rate_draft jsonb,
  ADD COLUMN portal_rates_visible boolean NOT NULL DEFAULT true;
ALTER TABLE partner_rate_card_versions
  ADD COLUMN pricing_model_version integer NOT NULL DEFAULT 1 CHECK (pricing_model_version IN (1,2)),
  ADD COLUMN visit_minimum_amount text CHECK (visit_minimum_amount IS NULL OR visit_minimum_amount ~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$'),
  ADD COLUMN portal_visible boolean NOT NULL DEFAULT true;
ALTER TABLE partner_booking_drafts
  ADD COLUMN model_version integer NOT NULL DEFAULT 1 CHECK (model_version IN (1,2)),
  ADD COLUMN service_lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(service_lines) = 'array' AND jsonb_array_length(service_lines) <= 8);
ALTER TABLE partner_bookings ALTER COLUMN appointment_id DROP NOT NULL;
ALTER TABLE partner_bookings
  ADD COLUMN model_version integer NOT NULL DEFAULT 1,
  ADD COLUMN quoted_total_cents integer CHECK (quoted_total_cents >= 0),
  ADD COLUMN final_total_cents integer CHECK (final_total_cents >= 0),
  ADD COLUMN pricing_version integer NOT NULL DEFAULT 1 CHECK (pricing_version > 0),
  ADD COLUMN priced_at timestamptz,
  ADD COLUMN priced_by_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD CONSTRAINT partner_bookings_model_shape_check CHECK (
    (model_version = 1 AND appointment_id IS NOT NULL) OR
    (model_version = 2 AND appointment_id IS NULL AND partner_account_id IS NOT NULL AND service_key IS NULL AND tier_key IS NULL)
  );
--> statement-breakpoint
CREATE TABLE partner_booking_service_lines (
  id uuid NOT NULL, partner_booking_id uuid NOT NULL, partner_account_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0 AND position < 8),
  service_label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','canceled')),
  completed_at timestamptz,
  service_key varchar(80) NOT NULL REFERENCES partner_service_catalog(key) ON DELETE RESTRICT,
  description text NOT NULL, scope jsonb NOT NULL DEFAULT '{}',
  selected_add_ons jsonb NOT NULL DEFAULT '[]', proof_requirements jsonb NOT NULL,
  rate_snapshot jsonb, quoted_amount_cents integer CHECK (quoted_amount_cents >= 0),
  price_description text, pricing_snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_booking_id,id),
  CONSTRAINT partner_service_lines_account_booking_id_key UNIQUE (partner_account_id,partner_booking_id,id),
  CONSTRAINT partner_service_lines_account_booking_fk FOREIGN KEY (partner_account_id,partner_booking_id)
    REFERENCES partner_bookings(partner_account_id,id) ON DELETE CASCADE
);
CREATE TABLE partner_booking_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_account_id uuid NOT NULL, partner_booking_id uuid NOT NULL,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','canceled')),
  minimum_amount_cents integer NOT NULL DEFAULT 0 CHECK (minimum_amount_cents >= 0),
  rate_snapshot jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_booking_visits_appointment_key UNIQUE (appointment_id),
  CONSTRAINT partner_booking_visits_account_booking_id_key UNIQUE (partner_account_id,partner_booking_id,id),
  CONSTRAINT partner_booking_visits_account_booking_fk FOREIGN KEY (partner_account_id,partner_booking_id)
    REFERENCES partner_bookings(partner_account_id,id) ON DELETE CASCADE
);
CREATE TABLE partner_booking_visit_lines (
  partner_account_id uuid NOT NULL, partner_booking_id uuid NOT NULL, visit_id uuid NOT NULL, service_line_id uuid NOT NULL,
  PRIMARY KEY (visit_id,service_line_id),
  CONSTRAINT partner_visit_lines_visit_fk FOREIGN KEY (partner_account_id,partner_booking_id,visit_id)
    REFERENCES partner_booking_visits(partner_account_id,partner_booking_id,id) ON DELETE CASCADE,
  CONSTRAINT partner_visit_lines_service_line_fk FOREIGN KEY (partner_account_id,partner_booking_id,service_line_id)
    REFERENCES partner_booking_service_lines(partner_account_id,partner_booking_id,id) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO partner_service_catalog (key,label,description,active,instant_bookable) VALUES
 ('pressure-washing','Pressure washing','Clean suitable outdoor surfaces with pressurized water.',true,false),
 ('soft-washing','Soft washing','Clean building exteriors or roofs with a low-pressure treatment.',true,false),
 ('brush-clearing','Brush clearing','Clear unwanted brush and remove the cut material.',true,false),
 ('demolition-only','Demolition','Take down the agreed structure; debris remains on-site.',true,false),
 ('painting','Painting','Repaint or touch up interior or exterior surfaces.',true,false),
 ('drywall-repair-paint','Drywall repair and painting','Repair drywall and paint the agreed area.',true,false),
 ('junk-removal','Junk removal','Remove unwanted items and materials.',true,false),
 ('demo-hauloff','Demolition and hauloff','Take down the agreed structure and remove its debris.',true,false)
 ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Keep the immutable additional-work relationship for both request shapes.
CREATE OR REPLACE FUNCTION partner_additional_service_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE draft_source uuid; source_appointment uuid; source_found boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.additional_service_from_partner_booking_id IS DISTINCT FROM OLD.additional_service_from_partner_booking_id
    OR (OLD.additional_service_from_partner_booking_id IS NOT NULL AND NEW.partner_account_id IS DISTINCT FROM OLD.partner_account_id)
  ) THEN RAISE EXCEPTION 'partner_additional_service_link_immutable'; END IF;
  IF TG_TABLE_NAME = 'partner_bookings' THEN
    IF TG_OP = 'UPDATE' AND OLD.additional_service_from_partner_booking_id IS NOT NULL AND (
      NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.booking_draft_id IS DISTINCT FROM OLD.booking_draft_id
    ) THEN RAISE EXCEPTION 'partner_additional_service_identity_immutable'; END IF;
    IF NEW.booking_draft_id IS NOT NULL THEN
      SELECT additional_service_from_partner_booking_id INTO draft_source FROM partner_booking_drafts
        WHERE id = NEW.booking_draft_id AND partner_account_id = NEW.partner_account_id;
      IF draft_source IS DISTINCT FROM NEW.additional_service_from_partner_booking_id THEN
        RAISE EXCEPTION 'partner_additional_service_draft_mismatch';
      END IF;
    END IF;
    IF NEW.additional_service_from_partner_booking_id IS NOT NULL THEN
      SELECT appointment_id,true INTO source_appointment,source_found FROM partner_bookings
        WHERE id = NEW.additional_service_from_partner_booking_id AND partner_account_id = NEW.partner_account_id;
      IF source_found IS DISTINCT FROM true OR NEW.id = NEW.additional_service_from_partner_booking_id
        OR (NEW.appointment_id IS NOT NULL AND NEW.appointment_id = source_appointment) THEN
        RAISE EXCEPTION 'partner_additional_service_requires_new_job';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
ALTER TABLE payment_attempts
 ADD COLUMN partner_booking_id uuid, ADD COLUMN partner_account_id uuid,
 ADD CONSTRAINT payment_attempts_partner_booking_fk FOREIGN KEY (partner_account_id,partner_booking_id) REFERENCES partner_bookings(partner_account_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT payment_attempts_partner_subject_check CHECK ((partner_booking_id IS NULL AND partner_account_id IS NULL) OR (partner_booking_id IS NOT NULL AND partner_account_id IS NOT NULL AND appointment_id IS NULL));
CREATE INDEX payment_attempts_partner_booking_idx ON payment_attempts(partner_account_id,partner_booking_id);
ALTER TABLE payments
 ADD COLUMN partner_booking_id uuid, ADD COLUMN partner_account_id uuid,
 ADD CONSTRAINT payments_partner_booking_fk FOREIGN KEY (partner_account_id,partner_booking_id) REFERENCES partner_bookings(partner_account_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT payments_partner_subject_check CHECK ((partner_booking_id IS NULL AND partner_account_id IS NULL) OR (partner_booking_id IS NOT NULL AND partner_account_id IS NOT NULL AND appointment_id IS NULL));
CREATE INDEX payments_partner_booking_idx ON payments(partner_account_id,partner_booking_id);
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_subject_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_subject_check CHECK (appointment_id IS NOT NULL OR quote_response_id IS NOT NULL OR partner_booking_id IS NOT NULL);

--> statement-breakpoint
ALTER TABLE partner_service_templates ALTER COLUMN service_key DROP NOT NULL;
