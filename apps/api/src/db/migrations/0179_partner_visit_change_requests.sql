-- Real visits own date changes; commercial parents remain appointment-free.
ALTER TABLE partner_reschedule_requests ADD COLUMN partner_booking_visit_id uuid;
--> statement-breakpoint
ALTER TABLE partner_reschedule_requests ADD CONSTRAINT partner_reschedule_requests_visit_fk
  FOREIGN KEY (partner_account_id, partner_booking_id, partner_booking_visit_id)
  REFERENCES partner_booking_visits (partner_account_id, partner_booking_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX partner_reschedule_requests_visit_idx ON partner_reschedule_requests (partner_booking_visit_id) WHERE partner_booking_visit_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE partner_bookings DROP CONSTRAINT partner_bookings_public_status_check;
--> statement-breakpoint
ALTER TABLE partner_bookings ADD CONSTRAINT partner_bookings_public_status_check
  CHECK (public_status IN ('requested', 'approval_needed', 'under_review', 'partially_scheduled', 'confirmed', 'en_route', 'in_progress', 'completed', 'canceled', 'declined'));
