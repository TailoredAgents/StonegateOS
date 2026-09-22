ALTER TABLE partner_owner_alert_groups ADD CONSTRAINT partner_owner_alert_groups_stage_key UNIQUE(partner_account_id,id,owner_team_member_id,stage);
ALTER TABLE partner_owner_alert_members ADD CONSTRAINT partner_owner_alert_members_stage_fk FOREIGN KEY(partner_account_id,group_id,owner_team_member_id,stage) REFERENCES partner_owner_alert_groups(partner_account_id,id,owner_team_member_id,stage) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION protect_partner_owner_alert_members() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.group_id,NEW.partner_account_id,NEW.partner_booking_id,NEW.owner_team_member_id,NEW.stage) IS DISTINCT FROM ROW(OLD.group_id,OLD.partner_account_id,OLD.partner_booking_id,OLD.owner_team_member_id,OLD.stage) THEN RAISE EXCEPTION 'Owner alert membership is immutable'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_partner_owner_alert_groups() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.partner_account_id,NEW.bulk_import_id,NEW.owner_team_member_id,NEW.settings_revision,NEW.member_count,NEW.created_at,NEW.stage) IS DISTINCT FROM ROW(OLD.id,OLD.partner_account_id,OLD.bulk_import_id,OLD.owner_team_member_id,OLD.settings_revision,OLD.member_count,OLD.created_at,OLD.stage) THEN RAISE EXCEPTION 'Owner alert group is immutable'; END IF;
 RETURN NEW;
END $$;
