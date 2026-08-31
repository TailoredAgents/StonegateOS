CREATE TABLE "partner_account_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  "email" text NOT NULL,
  "normalized_email" text NOT NULL,
  "invitee_name" text NOT NULL,
  "role_template_id" uuid NOT NULL
    REFERENCES "partner_role_templates"("id") ON DELETE RESTRICT,
  "role_template_version" integer NOT NULL,
  "role_key" varchar(64) NOT NULL,
  "persona" varchar(64) DEFAULT 'other' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "token_hash" varchar(64),
  "generation" integer DEFAULT 1 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "invited_by_membership_id" uuid NOT NULL,
  "accepted_by_partner_user_id" uuid
    REFERENCES "partner_users"("id") ON DELETE RESTRICT,
  "accepted_membership_id" uuid,
  "revoked_by_membership_id" uuid,
  "delivery_status" text DEFAULT 'queued' NOT NULL,
  "delivery_outbox_event_id" uuid
    REFERENCES "outbox_events"("id") ON DELETE SET NULL,
  "delivery_attempt_id" uuid,
  "delivery_provider" text,
  "delivery_provider_message_id" text,
  "delivery_detail" text,
  "dispatch_started_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "expired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_account_invitations_email_check" CHECK (
    "normalized_email" = lower(btrim("normalized_email"))
    AND "email" = "normalized_email"
    AND length("normalized_email") BETWEEN 3 AND 254
    AND "normalized_email" !~ '[[:space:]]'
    AND "normalized_email" LIKE '%@%'
  ),
  CONSTRAINT "partner_account_invitations_name_check"
    CHECK (length(btrim("invitee_name")) BETWEEN 2 AND 120),
  CONSTRAINT "partner_account_invitations_role_key_check"
    CHECK ("role_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "partner_account_invitations_persona_check" CHECK (
    "persona" IN (
      'contractor',
      'real_estate_agent',
      'property_manager',
      'commercial_client',
      'other'
    )
  ),
  CONSTRAINT "partner_account_invitations_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT "partner_account_invitations_token_hash_check"
    CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_account_invitations_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "partner_account_invitations_version_check"
    CHECK ("version" > 0),
  CONSTRAINT "partner_account_invitations_role_version_check"
    CHECK ("role_template_version" > 0),
  CONSTRAINT "partner_account_invitations_delivery_status_check" CHECK (
    "delivery_status" IN (
      'queued',
      'dispatching',
      'accepted',
      'failed',
      'reconciliation_required'
    )
  ),
  CONSTRAINT "partner_account_invitations_lifecycle_check" CHECK (
    (
      "status" = 'pending'
      AND "token_hash" IS NOT NULL
      AND "accepted_by_partner_user_id" IS NULL
      AND "accepted_membership_id" IS NULL
      AND "accepted_at" IS NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'accepted'
      AND "token_hash" IS NULL
      AND "accepted_by_partner_user_id" IS NOT NULL
      AND "accepted_membership_id" IS NOT NULL
      AND "accepted_at" IS NOT NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'revoked'
      AND "token_hash" IS NULL
      AND "accepted_by_partner_user_id" IS NULL
      AND "accepted_membership_id" IS NULL
      AND "accepted_at" IS NULL
      AND "revoked_at" IS NOT NULL
      AND "expired_at" IS NULL
    ) OR (
      "status" = 'expired'
      AND "token_hash" IS NULL
      AND "accepted_by_partner_user_id" IS NULL
      AND "accepted_membership_id" IS NULL
      AND "accepted_at" IS NULL
      AND "revoked_at" IS NULL
      AND "expired_at" IS NOT NULL
    )
  ),
  CONSTRAINT "partner_account_invitations_inviter_account_fk"
    FOREIGN KEY ("invited_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_account_invitations_revoker_account_fk"
    FOREIGN KEY ("revoked_by_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "partner_account_invitations_acceptance_account_fk"
    FOREIGN KEY ("accepted_membership_id", "partner_account_id")
    REFERENCES "partner_account_memberships"("id", "partner_account_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "partner_account_invitations_pending_email_key"
  ON "partner_account_invitations" ("partner_account_id", "normalized_email")
  WHERE "status" = 'pending';

CREATE UNIQUE INDEX "partner_account_invitations_token_hash_key"
  ON "partner_account_invitations" ("token_hash")
  WHERE "token_hash" IS NOT NULL;

CREATE UNIQUE INDEX "partner_account_invitations_delivery_outbox_key"
  ON "partner_account_invitations" ("delivery_outbox_event_id")
  WHERE "delivery_outbox_event_id" IS NOT NULL;

CREATE INDEX "partner_account_invitations_account_status_idx"
  ON "partner_account_invitations" (
    "partner_account_id",
    "status",
    "created_at" DESC,
    "id"
  );

CREATE INDEX "partner_account_invitations_expiry_idx"
  ON "partner_account_invitations" ("expires_at")
  WHERE "status" = 'pending';

