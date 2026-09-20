CREATE TABLE partner_owner_alert_settings (
 id text PRIMARY KEY DEFAULT 'owner' CHECK (id = 'owner'), enabled boolean NOT NULL DEFAULT false,
 owner_team_member_id uuid REFERENCES team_members(id) ON DELETE RESTRICT,
 phone_snapshot text, enabled_since timestamptz, revision integer NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_owner_alert_settings_enabled CHECK (NOT enabled OR (owner_team_member_id IS NOT NULL AND phone_snapshot IS NOT NULL AND phone_snapshot ~ '^\+[1-9][0-9]{9,14}$' AND enabled_since IS NOT NULL))
);
INSERT INTO partner_owner_alert_settings(id) VALUES ('owner');
CREATE TABLE partner_owner_alert_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_account_id uuid NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
 bulk_import_id uuid REFERENCES partner_bulk_imports(id) ON DELETE RESTRICT,
 owner_team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
 settings_revision integer NOT NULL, member_count integer NOT NULL CHECK(member_count>0),
 opened_at timestamptz, initial_accepted_at timestamptz, reminder_due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_owner_alert_groups_account_owner_key UNIQUE(partner_account_id,id,owner_team_member_id),
 CHECK ((initial_accepted_at IS NULL AND reminder_due_at IS NULL) OR (initial_accepted_at IS NOT NULL AND reminder_due_at IS NOT NULL AND reminder_due_at = initial_accepted_at + interval '30 minutes'))
);
CREATE INDEX partner_owner_alert_groups_owner_created ON partner_owner_alert_groups(owner_team_member_id,created_at);
CREATE TABLE partner_owner_alert_members (
 group_id uuid NOT NULL, partner_account_id uuid NOT NULL, partner_booking_id uuid NOT NULL, owner_team_member_id uuid NOT NULL, opened_at timestamptz,
 PRIMARY KEY(group_id,partner_booking_id),
 CONSTRAINT partner_owner_alert_members_job_owner_key UNIQUE(partner_booking_id,owner_team_member_id),
 CONSTRAINT partner_owner_alert_members_group_fk FOREIGN KEY(partner_account_id,group_id,owner_team_member_id) REFERENCES partner_owner_alert_groups(partner_account_id,id,owner_team_member_id) ON DELETE CASCADE,
 CONSTRAINT partner_owner_alert_members_job_fk FOREIGN KEY(partner_account_id,partner_booking_id) REFERENCES partner_bookings(partner_account_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION protect_partner_owner_alert_members() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.group_id,NEW.partner_account_id,NEW.partner_booking_id,NEW.owner_team_member_id) IS DISTINCT FROM ROW(OLD.group_id,OLD.partner_account_id,OLD.partner_booking_id,OLD.owner_team_member_id) THEN RAISE EXCEPTION 'Owner alert membership is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER partner_owner_alert_members_immutable BEFORE UPDATE ON partner_owner_alert_members FOR EACH ROW EXECUTE FUNCTION protect_partner_owner_alert_members();
ALTER TABLE staff_notification_operations ALTER COLUMN appointment_id DROP NOT NULL;
ALTER TABLE staff_notification_operations ADD COLUMN subject_type text, ADD COLUMN subject_id uuid;
ALTER TABLE staff_notification_operations ADD CONSTRAINT staff_notification_subject_check CHECK (
 (appointment_id IS NOT NULL AND subject_type IS NULL AND subject_id IS NULL) OR
 (appointment_id IS NULL AND subject_type IN ('partner_owner_group','partner_owner_test') AND subject_id IS NOT NULL));
CREATE UNIQUE INDEX staff_notification_subject_recipient_key ON staff_notification_operations(subject_type,subject_id,kind,recipient_team_member_id);
CREATE UNIQUE INDEX staff_notification_subject_address_key ON staff_notification_operations(subject_type,subject_id,kind,recipient_address);
ALTER TABLE staff_notification_operations DROP CONSTRAINT staff_notification_operations_kind_check;
ALTER TABLE staff_notification_operations ADD CONSTRAINT staff_notification_operations_kind_check CHECK(kind IN ('partner_booking_created','partner_booking_canceled','partner_billing_dispute_requested','partner_request_initial','partner_request_reminder','partner_request_test'));
ALTER TABLE staff_notification_operations DROP CONSTRAINT staff_notification_operations_state_check;
ALTER TABLE staff_notification_operations ADD CONSTRAINT staff_notification_operations_state_check CHECK(state IN ('requested','dispatched','succeeded','failed','reconciliation_required','suppressed'));
ALTER TABLE staff_notification_operations DROP CONSTRAINT staff_notification_operations_lifecycle_check;
ALTER TABLE staff_notification_operations ADD CONSTRAINT staff_notification_operations_lifecycle_check CHECK(
 (state='requested' AND succeeded_at IS NULL AND failed_at IS NULL) OR
 (state='dispatched' AND dispatched_at IS NOT NULL AND uncertainty_at IS NOT NULL AND succeeded_at IS NULL AND failed_at IS NULL) OR
 (state='succeeded' AND succeeded_at IS NOT NULL AND failed_at IS NULL) OR
 (state IN ('failed','reconciliation_required','suppressed') AND failed_at IS NOT NULL AND succeeded_at IS NULL));

CREATE FUNCTION protect_partner_owner_alert_groups() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.partner_account_id,NEW.bulk_import_id,NEW.owner_team_member_id,NEW.settings_revision,NEW.member_count,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.partner_account_id,OLD.bulk_import_id,OLD.owner_team_member_id,OLD.settings_revision,OLD.member_count,OLD.created_at) THEN RAISE EXCEPTION 'Owner alert group is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER partner_owner_alert_groups_immutable BEFORE UPDATE ON partner_owner_alert_groups FOR EACH ROW EXECUTE FUNCTION protect_partner_owner_alert_groups();
CREATE FUNCTION validate_partner_owner_alert_member_count() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target_id uuid; expected integer; actual integer; BEGIN
 IF TG_TABLE_NAME='partner_owner_alert_groups' THEN target_id=NEW.id; ELSE target_id=coalesce(NEW.group_id,OLD.group_id); END IF;
 SELECT member_count INTO expected FROM partner_owner_alert_groups WHERE id=target_id;
 IF expected IS NULL THEN RETURN NULL; END IF;
 SELECT count(*) INTO actual FROM partner_owner_alert_members WHERE group_id=target_id;
 IF actual<>expected THEN RAISE EXCEPTION 'Owner alert membership count must remain fixed'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER partner_owner_alert_group_members_fixed AFTER INSERT OR UPDATE ON partner_owner_alert_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_partner_owner_alert_member_count();
CREATE CONSTRAINT TRIGGER partner_owner_alert_members_fixed AFTER INSERT OR UPDATE OR DELETE ON partner_owner_alert_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_partner_owner_alert_member_count();

CREATE TABLE partner_owner_request_opens (
 partner_account_id uuid NOT NULL, partner_booking_id uuid NOT NULL,
 owner_team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
 opened_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(partner_booking_id,owner_team_member_id),
 CONSTRAINT partner_owner_request_opens_booking_fk FOREIGN KEY(partner_account_id,partner_booking_id) REFERENCES partner_bookings(partner_account_id,id) ON DELETE RESTRICT
);

-- BEGIN approved manual-review handoff repair (no notification backfill)
WITH repaired AS (
 UPDATE partner_bookings b
 SET public_status='under_review', confirmation_mode='review', arrival_window_start_at=NULL,
     arrival_window_end_at=NULL, version=b.version+1, updated_at=now()
 FROM appointments a
 WHERE a.id=b.appointment_id AND a.partner_account_id=b.partner_account_id
   AND a.status='requested' AND a.start_at IS NULL
   AND b.public_status='approval_needed' AND b.confirmation_mode='approval'
   AND EXISTS (SELECT 1 FROM partner_approval_requests ar WHERE ar.partner_account_id=b.partner_account_id AND ar.partner_booking_id=b.id AND ar.state='approved_needs_reschedule')
   AND NOT EXISTS (SELECT 1 FROM partner_approval_requests ar WHERE ar.partner_account_id=b.partner_account_id AND ar.partner_booking_id=b.id AND ar.state IN ('pending','declined','expired'))
 RETURNING b.id,b.partner_account_id,b.booking_draft_id,b.appointment_id
), cleared_promises AS (
 UPDATE appointments a SET promised_arrival_start_at=NULL, promised_arrival_end_at=NULL,
   schedule_policy_revision=NULL, updated_at=now()
 FROM repaired b
 WHERE a.id=b.appointment_id AND a.partner_account_id=b.partner_account_id
   AND a.status='requested' AND a.start_at IS NULL
 RETURNING a.id
), released AS (
 UPDATE appointment_holds h SET status='released', consumed_at=NULL, updated_at=now()
 FROM repaired b, partner_approval_requests ar
 WHERE ar.partner_account_id=b.partner_account_id AND ar.partner_booking_id=b.id
   AND ar.state='approved_needs_reschedule' AND ar.approval_hold_id=h.id
   AND h.partner_account_id=b.partner_account_id AND h.partner_booking_draft_id=b.booking_draft_id
   AND h.requested_by_membership_id=ar.requested_by_membership_id AND h.status='active'
 RETURNING h.id
)
INSERT INTO partner_job_events(partner_account_id,partner_booking_id,event_type,public_label,public_detail,actor_type,metadata)
SELECT partner_account_id,id,'job.company_approved','Company approval complete',
 'Stonegate will review and confirm the service time. No arrival window is reserved.',
 'system','{"reason":"restore_approved_staff_review_handoff","migration":"0175"}'::jsonb
FROM repaired;
-- END approved manual-review handoff repair
