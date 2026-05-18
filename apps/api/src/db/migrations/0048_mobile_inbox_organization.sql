ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "do_not_contact" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "do_not_contact_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "do_not_contact_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  ADD COLUMN IF NOT EXISTS "do_not_contact_reason" text;

ALTER TABLE "conversation_threads"
  ADD COLUMN IF NOT EXISTS "attention_handled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "attention_handled_by" uuid REFERENCES "team_members"("id") ON DELETE set null,
  ADD COLUMN IF NOT EXISTS "closed_reason" text,
  ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "closed_by" uuid REFERENCES "team_members"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "contacts_do_not_contact_idx" ON "contacts" ("do_not_contact");
CREATE INDEX IF NOT EXISTS "conversation_threads_attention_handled_idx" ON "conversation_threads" ("attention_handled_at");
CREATE INDEX IF NOT EXISTS "conversation_threads_closed_reason_idx" ON "conversation_threads" ("closed_reason");
