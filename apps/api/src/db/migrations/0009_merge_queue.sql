CREATE TYPE "merge_suggestion_status" AS ENUM ('pending', 'approved', 'declined');

CREATE TABLE "merge_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "target_contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "status" "merge_suggestion_status" NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "confidence" integer NOT NULL DEFAULT 0,
  "meta" jsonb,
  "reviewed_by" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "merge_suggestions_status_idx" ON "merge_suggestions" ("status");
CREATE INDEX "merge_suggestions_source_idx" ON "merge_suggestions" ("source_contact_id");
CREATE INDEX "merge_suggestions_target_idx" ON "merge_suggestions" ("target_contact_id");
CREATE UNIQUE INDEX "merge_suggestions_pair_key" ON "merge_suggestions" ("source_contact_id", "target_contact_id");
