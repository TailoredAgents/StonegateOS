CREATE TABLE sms_marketing_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
 phone text NOT NULL, status text NOT NULL CHECK (status IN ('granted','revoked')),
 source text NOT NULL, evidence text NOT NULL, time_zone text NOT NULL,
 captured_at timestamptz NOT NULL, recorded_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_marketing_consents_phone_idx ON sms_marketing_consents(phone,created_at);
CREATE TABLE sms_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed','cancelled')),
 terms jsonb NOT NULL, sender text, activated_at timestamptz, next_send_at timestamptz, created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sms_campaign_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES sms_campaigns(id),
 version integer NOT NULL, recipients jsonb NOT NULL, sender text,
 expires_at timestamptz NOT NULL, created_by uuid NOT NULL, consumed_at timestamptz
);
CREATE TABLE sms_campaign_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES sms_campaigns(id),
 review_id uuid NOT NULL REFERENCES sms_campaign_reviews(id), released_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sms_campaign_batches_review_key ON sms_campaign_batches(review_id);
CREATE TABLE sms_campaign_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES sms_campaigns(id),
 batch_id uuid REFERENCES sms_campaign_batches(id), contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
 phone text NOT NULL, name text NOT NULL, consent_id uuid REFERENCES sms_marketing_consents(id), body text NOT NULL,
 message_id uuid REFERENCES conversation_messages(id) ON DELETE RESTRICT, is_test boolean NOT NULL DEFAULT false,
 suppression_reason text, claimed_at timestamptz, replied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sms_campaign_recipients_destination_key ON sms_campaign_recipients(campaign_id,phone) WHERE is_test = false;
CREATE UNIQUE INDEX sms_campaign_recipients_message_key ON sms_campaign_recipients(message_id);
CREATE INDEX sms_campaign_recipients_phone_idx ON sms_campaign_recipients(phone);
