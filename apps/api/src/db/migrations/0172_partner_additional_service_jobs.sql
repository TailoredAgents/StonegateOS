-- Extra work is a NEW job, never a rewrite of an original invoice or payout.
ALTER TABLE partner_booking_drafts ADD COLUMN additional_service_from_partner_booking_id uuid;
ALTER TABLE partner_bookings ADD COLUMN additional_service_from_partner_booking_id uuid;
ALTER TABLE partner_booking_drafts ADD CONSTRAINT partner_additional_draft_source_fk
  FOREIGN KEY (partner_account_id, additional_service_from_partner_booking_id)
  REFERENCES partner_bookings(partner_account_id, id) ON DELETE RESTRICT;
ALTER TABLE partner_bookings ADD CONSTRAINT partner_additional_job_source_fk
  FOREIGN KEY (partner_account_id, additional_service_from_partner_booking_id)
  REFERENCES partner_bookings(partner_account_id, id) ON DELETE RESTRICT;
ALTER TABLE partner_booking_drafts ADD CONSTRAINT partner_additional_draft_not_reschedule
  CHECK (additional_service_from_partner_booking_id IS NULL OR reschedule_from_partner_booking_id IS NULL);
ALTER TABLE partner_bookings ADD CONSTRAINT partner_additional_job_not_self
  CHECK (additional_service_from_partner_booking_id IS NULL OR
    (partner_account_id IS NOT NULL AND additional_service_from_partner_booking_id <> id));
CREATE INDEX partner_additional_jobs_source_idx ON partner_bookings
  (partner_account_id, additional_service_from_partner_booking_id, created_at, id)
  WHERE additional_service_from_partner_booking_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION partner_additional_service_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE draft_source uuid; source_appointment uuid;
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
      SELECT appointment_id INTO source_appointment FROM partner_bookings
        WHERE id = NEW.additional_service_from_partner_booking_id AND partner_account_id = NEW.partner_account_id;
      IF source_appointment IS NULL OR source_appointment = NEW.appointment_id THEN
        RAISE EXCEPTION 'partner_additional_service_requires_new_appointment';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_additional_service_draft_link BEFORE INSERT OR UPDATE ON partner_booking_drafts
  FOR EACH ROW EXECUTE FUNCTION partner_additional_service_link_guard();
CREATE TRIGGER partner_additional_service_job_link BEFORE INSERT OR UPDATE ON partner_bookings
  FOR EACH ROW EXECUTE FUNCTION partner_additional_service_link_guard();
