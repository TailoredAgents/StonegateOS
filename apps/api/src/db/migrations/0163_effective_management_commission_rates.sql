-- Additive only: activating a dated policy is a separate, audited operation.
-- Legacy configuration and all earned commission / payout records are untouched.
CREATE TABLE "commission_management_rate_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "settings_key" text NOT NULL REFERENCES "commission_settings"("key") ON DELETE RESTRICT,
  "effective_from" timestamptz NOT NULL,
  "total_rate_bps" integer NOT NULL CHECK ("total_rate_bps" BETWEEN 0 AND 10000),
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 2000),
  "created_by" uuid NOT NULL REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "commission_management_rate_versions_effective_unique"
  ON "commission_management_rate_versions"("settings_key", "effective_from");

CREATE TABLE "commission_management_rate_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version_id" uuid NOT NULL REFERENCES "commission_management_rate_versions"("id") ON DELETE RESTRICT,
  "member_id" uuid NOT NULL REFERENCES "team_members"("id") ON DELETE RESTRICT,
  "rate_bps" integer NOT NULL CHECK ("rate_bps" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "commission_management_rate_recipients_member_unique"
  ON "commission_management_rate_recipients"("version_id", "member_id");

CREATE FUNCTION "reject_management_rate_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Management rate history is append-only; create a new effective version'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "management_rate_versions_immutable"
  BEFORE UPDATE OR DELETE ON "commission_management_rate_versions"
  FOR EACH ROW EXECUTE FUNCTION "reject_management_rate_history_mutation"();
CREATE TRIGGER "management_rate_recipients_immutable"
  BEFORE UPDATE OR DELETE ON "commission_management_rate_recipients"
  FOR EACH ROW EXECUTE FUNCTION "reject_management_rate_history_mutation"();
