CREATE TABLE sms_campaign_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES sms_campaigns(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  version integer NOT NULL CHECK (version > 0),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1600),
  body_hash text NOT NULL,
  source_reference text NOT NULL,
  source_hash text NOT NULL,
  imported_by uuid NOT NULL REFERENCES team_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id, version),
  UNIQUE (campaign_id, contact_id, body_hash)
);
--> statement-breakpoint
CREATE TABLE sms_outreach_qualifications (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id),
  version integer NOT NULL DEFAULT 1,
  qualification text NOT NULL CHECK (qualification IN ('past_customer','prior_inquiry','quote_only','unverified')),
  facebook_status text NOT NULL CHECK (facebook_status IN ('clear','excluded','uncertain')),
  holds jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(holds) = 'array'),
  external_last_activity_at timestamptz,
  evidence_reference text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES team_members(id)
);
--> statement-breakpoint
ALTER TABLE sms_campaign_recipients ADD COLUMN draft_id uuid REFERENCES sms_campaign_drafts(id);
CREATE UNIQUE INDEX sms_campaign_recipients_draft_key ON sms_campaign_recipients(draft_id);
--> statement-breakpoint
ALTER TABLE sms_marketing_consents ADD COLUMN evidence_reference text;
