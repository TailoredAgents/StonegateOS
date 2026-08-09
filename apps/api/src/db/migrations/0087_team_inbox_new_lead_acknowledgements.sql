-- Durable, per-person Inbox acknowledgement for the new-lead banner.
--
-- Acknowledging one contact must never suppress another contact, so the
-- durable identity is the exact (team member, contact) pair. Expired rows are
-- retained as evidence and may be renewed by a later acknowledgement.
CREATE TABLE IF NOT EXISTS "team_inbox_new_lead_acknowledgements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_member_id" uuid NOT NULL
    REFERENCES "team_members" ("id") ON DELETE CASCADE,
  "contact_id" uuid NOT NULL
    REFERENCES "contacts" ("id") ON DELETE CASCADE,
  "acknowledged_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_inbox_new_lead_ack_expiry_check"
    CHECK ("expires_at" = "acknowledged_at" + interval '24 hours'),
  CONSTRAINT "team_inbox_new_lead_ack_version_check"
    CHECK ("version" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_inbox_new_lead_ack_member_contact_key"
  ON "team_inbox_new_lead_acknowledgements"
  ("team_member_id", "contact_id");

CREATE INDEX IF NOT EXISTS "team_inbox_new_lead_ack_member_expiry_idx"
  ON "team_inbox_new_lead_acknowledgements"
  ("team_member_id", "expires_at", "contact_id");

CREATE INDEX IF NOT EXISTS "team_inbox_new_lead_ack_expiry_idx"
  ON "team_inbox_new_lead_acknowledgements" ("expires_at");

CREATE INDEX IF NOT EXISTS "crm_pipeline_new_lead_order_idx"
  ON "crm_pipeline" ("stage", "updated_at" DESC, "contact_id")
  WHERE "stage" = 'new';

COMMENT ON TABLE "team_inbox_new_lead_acknowledgements" IS
  'Per-team-member, contact-scoped Inbox new-lead acknowledgements with a fixed 24-hour expiry.';

COMMENT ON COLUMN "team_inbox_new_lead_acknowledgements"."version" IS
  'Monotonic acknowledgement version incremented when an expired pair is acknowledged again.';
