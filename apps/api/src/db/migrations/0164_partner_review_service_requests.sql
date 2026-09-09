-- Review requests must never manufacture a planned start or reserve capacity.
ALTER TABLE partner_reschedule_requests
  ADD COLUMN request_kind text NOT NULL DEFAULT 'held_window',
  ADD COLUMN preferred_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN withdrawal_operation_key_hash varchar(64),
  ADD COLUMN withdrawal_request_hash varchar(64),
  ALTER COLUMN proposed_start_at DROP NOT NULL,
  ALTER COLUMN requested_arrival_start_at DROP NOT NULL,
  ALTER COLUMN requested_arrival_end_at DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE partner_reschedule_requests ADD CONSTRAINT partner_reschedule_requests_shape_check CHECK (
  (request_kind = 'held_window' AND proposed_start_at IS NOT NULL AND requested_arrival_start_at IS NOT NULL AND requested_arrival_end_at IS NOT NULL AND preferred_windows = '[]'::jsonb)
  OR (request_kind = 'preferred_dates' AND proposed_start_at IS NULL AND requested_arrival_start_at IS NULL AND requested_arrival_end_at IS NULL AND jsonb_typeof(preferred_windows) = 'array' AND jsonb_array_length(preferred_windows) BETWEEN 1 AND 3)
);
--> statement-breakpoint
INSERT INTO partner_service_catalog (key, label, description, active, instant_bookable, required_scope_fields, default_proof_requirements, automatic_review_rules)
VALUES ('service_request', 'Request service', 'Tell us what you need removed or taken care of. Stonegate will confirm the details, price, and time with you.', true, false, ARRAY['description'], '{"before":1,"after":1}'::jsonb, '{}')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX partner_reschedule_requests_withdrawal_operation_key ON partner_reschedule_requests(withdrawal_operation_key_hash) WHERE withdrawal_operation_key_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE partner_notification_deliveries DROP CONSTRAINT partner_notification_deliveries_event_type_check;
--> statement-breakpoint
ALTER TABLE partner_notification_deliveries ADD CONSTRAINT partner_notification_deliveries_event_type_check CHECK (event_type IN ('booking.created', 'booking.review_received', 'booking.rescheduled', 'booking.reschedule_review_requested', 'booking.reschedule_declined', 'booking.canceled', 'booking.cancellation_review_requested', 'billing.dispute_requested', 'billing.dispute_resolved'));
