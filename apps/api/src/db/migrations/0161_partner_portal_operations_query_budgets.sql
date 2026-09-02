-- Bounded query support for privacy-safe Partner Portal operations reporting
-- and large account job/location keyset scans. No data or authority changes.

CREATE INDEX "web_event_counts_daily_partner_funnel_date_key_idx"
  ON "web_event_counts_daily" ("date_start", "key")
  WHERE "event" = 'partner_funnel';

CREATE INDEX "partner_bookings_account_created_id_idx"
  ON "partner_bookings" ("partner_account_id", "created_at", "id")
  WHERE "partner_account_id" IS NOT NULL;

CREATE INDEX "partner_bookings_account_service_created_id_idx"
  ON "partner_bookings" (
    "partner_account_id",
    "service_key",
    "created_at",
    "id"
  )
  WHERE "partner_account_id" IS NOT NULL;

CREATE INDEX "partner_bookings_account_property_created_id_idx"
  ON "partner_bookings" (
    "partner_account_id",
    "property_id",
    "created_at",
    "id"
  )
  WHERE "partner_account_id" IS NOT NULL;

CREATE INDEX "partner_account_locations_account_active_site_id_idx"
  ON "partner_account_locations" (
    "partner_account_id",
    "active",
    "site_name",
    "id"
  );

CREATE INDEX "partner_account_locations_account_site_id_idx"
  ON "partner_account_locations" ("partner_account_id", "site_name", "id");
