ALTER TABLE partner_notification_deliveries DROP CONSTRAINT partner_notification_deliveries_event_type_check;
--> statement-breakpoint
ALTER TABLE partner_notification_deliveries ADD CONSTRAINT partner_notification_deliveries_event_type_check CHECK (event_type IN ('booking.created', 'booking.review_received', 'booking.rescheduled', 'booking.reschedule_review_requested', 'booking.reschedule_declined', 'booking.canceled', 'booking.cancellation_review_requested', 'billing.dispute_requested', 'billing.dispute_resolved', 'booking.en_route', 'booking.completed', 'proof.ready', 'message.received', 'approval.requested', 'approval.decided', 'billing.invoice_issued', 'billing.invoice_credited', 'billing.payment_processing', 'billing.payment_settled', 'billing.payment_failed', 'billing.payment_refunded'));
--> statement-breakpoint
ALTER TABLE partner_notification_deliveries DROP CONSTRAINT partner_notification_deliveries_preference_event_key_check;
--> statement-breakpoint
ALTER TABLE partner_notification_deliveries ADD CONSTRAINT partner_notification_deliveries_preference_event_key_check CHECK (preference_event_key IN ('booking_created', 'booking_changed', 'crew_en_route', 'job_completed', 'invoice_issued', 'payment_received', 'message_received', 'proof_ready', 'approval_requested', 'account_access'));
