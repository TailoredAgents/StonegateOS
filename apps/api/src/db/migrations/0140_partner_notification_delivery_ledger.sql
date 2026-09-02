-- Durable, account-scoped Partner Portal notification intent and provider
-- dispatch ledger. Provider-bound outbox payloads contain only this opaque ID.

CREATE TABLE "partner_notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "partner_booking_id" uuid NOT NULL,
  "partner_notification_id" uuid
    REFERENCES "partner_notifications"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "preference_event_key" text NOT NULL,
  "channel" text NOT NULL,
  "state" text NOT NULL,
  "urgency" text NOT NULL DEFAULT 'ordinary',
  "dedupe_key_hash" varchar(64) NOT NULL,
  "title" varchar(120) NOT NULL,
  "body" varchar(500) NOT NULL,
  "action_path" varchar(200) NOT NULL,
  "endpoint_id" uuid
    REFERENCES "partner_notification_endpoints"("id") ON DELETE SET NULL,
  "provider_request_key" varchar(200),
  "outbox_event_id" uuid
    REFERENCES "outbox_events"("id") ON DELETE RESTRICT,
  "scheduled_for" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "dispatch_attempt_id" uuid,
  "dispatch_started_at" timestamptz,
  "provider" varchar(64),
  "provider_message_id" varchar(255),
  "provider_idempotency_supported" boolean,
  "delivery_certainty" text,
  "detail" varchar(500),
  "correlation_id" varchar(128),
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_notification_deliveries_membership_account_fk"
    FOREIGN KEY ("membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_notification_deliveries_booking_account_fk"
    FOREIGN KEY ("partner_booking_id", "partner_account_id")
    REFERENCES "partner_bookings"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_notification_deliveries_event_type_check"
    CHECK ("event_type" IN (
      'booking.created',
      'booking.review_received',
      'booking.rescheduled',
      'booking.reschedule_review_requested',
      'booking.canceled',
      'booking.cancellation_review_requested'
    )),
  CONSTRAINT "partner_notification_deliveries_preference_event_key_check"
    CHECK ("preference_event_key" IN ('booking_created', 'booking_changed')),
  CONSTRAINT "partner_notification_deliveries_channel_check"
    CHECK ("channel" IN ('in_app', 'email', 'sms')),
  CONSTRAINT "partner_notification_deliveries_state_check"
    CHECK ("state" IN (
      'suppressed',
      'queued',
      'dispatching',
      'accepted',
      'failed',
      'reconciliation_required'
    )),
  CONSTRAINT "partner_notification_deliveries_urgency_check"
    CHECK ("urgency" IN ('ordinary', 'urgent_same_day')),
  CONSTRAINT "partner_notification_deliveries_attempt_count_check"
    CHECK ("attempt_count" BETWEEN 0 AND 3),
  CONSTRAINT "partner_notification_deliveries_dedupe_hash_check"
    CHECK ("dedupe_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_notification_deliveries_action_path_check"
    CHECK ("action_path" ~ '^/partners/bookings/[0-9a-f-]{36}$'),
  CONSTRAINT "partner_notification_deliveries_lifecycle_check" CHECK (
    (
      "channel" = 'in_app'
      AND "outbox_event_id" IS NULL
      AND "provider_request_key" IS NULL
      AND "endpoint_id" IS NULL
      AND "state" IN ('suppressed', 'accepted')
    ) OR (
      "channel" IN ('email', 'sms')
      AND (("outbox_event_id" IS NULL) = ("provider_request_key" IS NULL))
      AND ("state" = 'suppressed' OR "outbox_event_id" IS NOT NULL)
      AND (
        "channel" <> 'sms'
        OR "state" = 'suppressed'
        OR "endpoint_id" IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX "partner_notification_deliveries_channel_dedupe_key"
  ON "partner_notification_deliveries" (
    "membership_id",
    "event_type",
    "dedupe_key_hash",
    "channel"
  );
CREATE UNIQUE INDEX "partner_notification_deliveries_outbox_key"
  ON "partner_notification_deliveries" ("outbox_event_id")
  WHERE "outbox_event_id" IS NOT NULL;
CREATE INDEX "partner_notification_deliveries_dispatch_idx"
  ON "partner_notification_deliveries" (
    "state",
    "scheduled_for",
    "created_at"
  );
CREATE INDEX "partner_notification_deliveries_account_booking_idx"
  ON "partner_notification_deliveries" (
    "partner_account_id",
    "partner_booking_id",
    "created_at"
  );
