ALTER TABLE partner_owner_alert_groups ADD COLUMN stage text NOT NULL DEFAULT 'ready_to_schedule' CHECK(stage IN ('pricing_review','ready_to_schedule'));
ALTER TABLE partner_owner_alert_members ADD COLUMN stage text NOT NULL DEFAULT 'ready_to_schedule' CHECK(stage IN ('pricing_review','ready_to_schedule'));
ALTER TABLE partner_owner_request_opens ADD COLUMN stage text NOT NULL DEFAULT 'ready_to_schedule' CHECK(stage IN ('pricing_review','ready_to_schedule'));
ALTER TABLE partner_owner_alert_members DROP CONSTRAINT partner_owner_alert_members_job_owner_key;
CREATE UNIQUE INDEX partner_owner_alert_members_job_owner_key ON partner_owner_alert_members(partner_booking_id,owner_team_member_id,stage);
ALTER TABLE partner_owner_request_opens DROP CONSTRAINT partner_owner_request_opens_pkey;
ALTER TABLE partner_owner_request_opens ADD PRIMARY KEY(partner_booking_id,owner_team_member_id,stage);
