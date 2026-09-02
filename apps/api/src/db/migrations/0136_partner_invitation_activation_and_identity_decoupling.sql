-- Invitation acceptance is an activation workflow, not a routine login. Keep
-- invitation scopes account-bound and remove CRM contact ownership as an
-- identity requirement without deleting or rewriting any existing link.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'partner_users'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'contacts'::regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = 'partner_users'::regclass
            AND attribute.attname = 'org_contact_id'
        )
      ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE "partner_users" DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE "partner_users"
  ALTER COLUMN "org_contact_id" DROP NOT NULL,
  ADD CONSTRAINT "partner_users_org_contact_id_contacts_id_fk"
    FOREIGN KEY ("org_contact_id")
    REFERENCES "contacts"("id")
    ON DELETE SET NULL;

ALTER TABLE "partner_account_invitations"
  ADD COLUMN "access_level" text NOT NULL DEFAULT 'account',
  ADD CONSTRAINT "partner_account_invitations_access_level_check"
    CHECK ("access_level" IN ('account', 'scoped')),
  ADD CONSTRAINT "partner_account_invitations_administrator_scope_check"
    CHECK ("role_key" <> 'administrator' OR "access_level" = 'account');

CREATE UNIQUE INDEX "partner_account_invitations_account_invitation_key"
  ON "partner_account_invitations" ("partner_account_id", "id");

CREATE TABLE "partner_invitation_location_scopes" (
  "invitation_id" uuid NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_invitation_location_scopes_pk"
    PRIMARY KEY ("invitation_id", "location_id"),
  CONSTRAINT "partner_invitation_location_scopes_invitation_account_fk"
    FOREIGN KEY ("partner_account_id", "invitation_id")
    REFERENCES "partner_account_invitations"("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_invitation_location_scopes_location_account_fk"
    FOREIGN KEY ("partner_account_id", "location_id")
    REFERENCES "partner_account_locations"("partner_account_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "partner_invitation_location_scopes_account_invitation_idx"
  ON "partner_invitation_location_scopes" (
    "partner_account_id",
    "invitation_id"
  );

CREATE TABLE "partner_invitation_cost_center_scopes" (
  "invitation_id" uuid NOT NULL,
  "partner_account_id" uuid NOT NULL,
  "cost_center_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "partner_invitation_cost_center_scopes_pk"
    PRIMARY KEY ("invitation_id", "cost_center_id"),
  CONSTRAINT "partner_invitation_cost_center_scopes_invitation_account_fk"
    FOREIGN KEY ("partner_account_id", "invitation_id")
    REFERENCES "partner_account_invitations"("partner_account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "partner_invitation_cost_center_scopes_cost_center_account_fk"
    FOREIGN KEY ("partner_account_id", "cost_center_id")
    REFERENCES "partner_account_cost_centers"("partner_account_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "partner_invitation_cost_center_scopes_account_invitation_idx"
  ON "partner_invitation_cost_center_scopes" (
    "partner_account_id",
    "invitation_id"
  );
