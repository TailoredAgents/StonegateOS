-- Expand-only: staff invitation issuers and same-email activation handoffs.
ALTER TABLE "partner_account_invitations"
  ALTER COLUMN "invited_by_membership_id" DROP NOT NULL,
  ADD COLUMN "invited_by_team_member_id" uuid
    REFERENCES "team_members"("id") ON DELETE RESTRICT,
  ADD COLUMN "resume_membership_id" uuid,
  ADD COLUMN "activated_at" timestamptz;
ALTER TABLE "partner_account_invitations"
  ADD CONSTRAINT "partner_account_invitations_resume_account_fk"
    FOREIGN KEY ("partner_account_id", "resume_membership_id")
    REFERENCES "partner_account_memberships"("partner_account_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_account_invitations_issuer_check"
    CHECK (("invited_by_membership_id" IS NOT NULL) <> ("invited_by_team_member_id" IS NOT NULL));

-- Existing active members are never treated as unfinished invitation setup.
UPDATE "partner_account_invitations" AS invitation
SET "activated_at" = COALESCE(member."accepted_at", invitation."accepted_at", member."updated_at")
FROM "partner_account_memberships" AS member
WHERE member."partner_account_id" = invitation."partner_account_id"
  AND member."id" = invitation."accepted_membership_id"
  AND member."status" <> 'invited';

ALTER TABLE "partner_auth_challenges"
  ADD COLUMN "invitation_id" uuid,
  ADD COLUMN "invitation_generation" integer;
ALTER TABLE "partner_auth_challenges"
  ADD CONSTRAINT "partner_auth_challenges_invitation_account_fk"
    FOREIGN KEY ("partner_account_id", "invitation_id")
    REFERENCES "partner_account_invitations"("partner_account_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_auth_challenges_invitation_scope_check"
    CHECK (
      ("invitation_id" IS NULL AND "invitation_generation" IS NULL)
      OR ("purpose" = 'account_activation' AND "partner_account_id" IS NOT NULL
        AND "invitation_id" IS NOT NULL AND "invitation_generation" > 0)
    );
CREATE INDEX "partner_auth_challenges_invitation_idx"
  ON "partner_auth_challenges"("invitation_id", "status")
  WHERE "invitation_id" IS NOT NULL;
