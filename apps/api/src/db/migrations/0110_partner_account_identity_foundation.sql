-- Account-centric partner identity foundation.
--
-- This migration is deliberately expand-only. V1 contact-owned portal
-- columns and routes remain intact while every currently eligible portal user
-- receives an owner-equivalent account membership and every live session is
-- bound to that membership where possible.

ALTER TABLE "partner_accounts"
  ADD COLUMN "portal_contact_id" uuid,
  ADD COLUMN "portal_access_enabled" boolean DEFAULT false NOT NULL;

ALTER TABLE "partner_accounts"
  ADD CONSTRAINT "partner_accounts_portal_contact_id_contacts_id_fk"
  FOREIGN KEY ("portal_contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL;

CREATE UNIQUE INDEX "partner_accounts_portal_contact_key"
  ON "partner_accounts" ("portal_contact_id")
  WHERE "portal_contact_id" IS NOT NULL;

CREATE INDEX "partner_accounts_portal_access_idx"
  ON "partner_accounts" ("portal_access_enabled", "status");

ALTER TABLE "partner_users"
  ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL,
  ADD COLUMN "mfa_enrolled_at" timestamp with time zone,
  ADD COLUMN "security_version" integer DEFAULT 1 NOT NULL,
  ADD CONSTRAINT "partner_users_security_version_check"
    CHECK ("security_version" > 0);

CREATE TABLE "partner_mfa_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users"("id")
    ON DELETE CASCADE,
  "method_type" text NOT NULL,
  "label" text,
  "credential_id_hash" varchar(64),
  "credential_reference" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_mfa_methods_type_check"
    CHECK ("method_type" IN ('totp', 'webauthn')),
  CONSTRAINT "partner_mfa_methods_credential_hash_check"
    CHECK (
      "credential_id_hash" IS NULL
      OR "credential_id_hash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "partner_mfa_methods_enabled_state_check"
    CHECK (
      ("enabled" = true AND "disabled_at" IS NULL)
      OR ("enabled" = false AND "disabled_at" IS NOT NULL)
    )
);

CREATE INDEX "partner_mfa_methods_user_idx"
  ON "partner_mfa_methods" ("partner_user_id", "enabled");

CREATE UNIQUE INDEX "partner_mfa_methods_credential_hash_key"
  ON "partner_mfa_methods" ("credential_id_hash")
  WHERE "credential_id_hash" IS NOT NULL;

CREATE TABLE "partner_capability_definitions" (
  "key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "risk" text DEFAULT 'standard' NOT NULL,
  "assignable" boolean DEFAULT true NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_capability_definitions_key_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT "partner_capability_definitions_risk_check"
    CHECK ("risk" IN ('standard', 'sensitive', 'financial'))
);

CREATE INDEX "partner_capability_definitions_category_idx"
  ON "partner_capability_definitions" ("category", "active");

INSERT INTO "partner_capability_definitions"
  ("key", "label", "description", "category", "risk", "assignable")
VALUES
  ('portal.session.read', 'View own sessions', 'View the current partner session and account choices.', 'security', 'standard', false),
  ('portal.session.switch_account', 'Switch own account', 'Select another account where the person has an active membership.', 'security', 'standard', false),
  ('account.read', 'View account', 'View company profile and account configuration.', 'account', 'standard', true),
  ('account.update', 'Update account', 'Update company profile and account configuration.', 'account', 'sensitive', true),
  ('account.members.read', 'View members', 'View people and roles in the company account.', 'account', 'sensitive', true),
  ('account.members.manage', 'Manage members', 'Invite, suspend, and assign roles to account members.', 'account', 'sensitive', true),
  ('account.security.manage', 'Manage account security', 'Manage MFA policy and other company security settings.', 'security', 'sensitive', true),
  ('account.notifications.manage', 'Manage notifications', 'Manage company notification defaults and routing.', 'account', 'standard', true),
  ('bookings.read', 'View bookings', 'View account booking requests and schedule state.', 'scheduling', 'standard', true),
  ('bookings.create', 'Create bookings', 'Schedule a pickup or job for the account.', 'scheduling', 'standard', true),
  ('bookings.update', 'Update bookings', 'Edit or reschedule an account booking when policy allows.', 'scheduling', 'sensitive', true),
  ('bookings.cancel', 'Cancel bookings', 'Cancel an account booking when policy allows.', 'scheduling', 'sensitive', true),
  ('bookings.approve', 'Approve bookings', 'Approve booking requests governed by account workflow.', 'scheduling', 'sensitive', true),
  ('properties.read', 'View properties', 'View account properties, locations, and units.', 'properties', 'standard', true),
  ('properties.manage', 'Manage properties', 'Create and update account properties, locations, and units.', 'properties', 'sensitive', true),
  ('jobs.read', 'View jobs', 'View job detail, timeline, and completion state.', 'jobs', 'standard', true),
  ('jobs.change_request', 'Request job changes', 'Submit a scoped job change or service issue.', 'jobs', 'sensitive', true),
  ('media.read', 'View media', 'View account-scoped booking and job media.', 'media', 'standard', true),
  ('media.upload', 'Upload media', 'Upload account-scoped booking and job media.', 'media', 'sensitive', true),
  ('proof.read', 'View completion proof', 'View before and after service evidence.', 'media', 'standard', true),
  ('proof.request', 'Request completion proof', 'Require before, after, or complete service evidence.', 'media', 'standard', true),
  ('rates.read', 'View rates', 'View contracted or account-specific service rates.', 'billing', 'standard', true),
  ('invoices.read', 'View invoices', 'View account invoices, receipts, and statements.', 'billing', 'financial', true),
  ('payments.manage', 'Manage payments', 'Manage account payment methods and submit payments.', 'billing', 'financial', true),
  ('documents.read', 'View documents', 'View account contracts, COIs, and job documents.', 'documents', 'standard', true),
  ('documents.manage', 'Manage documents', 'Upload and manage account documents.', 'documents', 'sensitive', true),
  ('messages.read', 'View messages', 'View account-scoped service conversations.', 'communications', 'standard', true),
  ('messages.send', 'Send messages', 'Send account-scoped service messages.', 'communications', 'sensitive', true),
  ('reports.read', 'View reports', 'View account service and financial reporting.', 'reporting', 'standard', true),
  ('reports.export', 'Export reports', 'Export account service or financial data.', 'reporting', 'financial', true)
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE "partner_role_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid REFERENCES "partner_accounts"("id")
    ON DELETE CASCADE,
  "key" varchar(64) NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "capabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by_partner_user_id" uuid REFERENCES "partner_users"("id")
    ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_role_templates_key_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "partner_role_templates_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "partner_role_templates_global_key"
  ON "partner_role_templates" ("key")
  WHERE "partner_account_id" IS NULL;

CREATE UNIQUE INDEX "partner_role_templates_account_key"
  ON "partner_role_templates" ("partner_account_id", "key")
  WHERE "partner_account_id" IS NOT NULL;

CREATE INDEX "partner_role_templates_account_idx"
  ON "partner_role_templates" ("partner_account_id", "active");

INSERT INTO "partner_role_templates"
  ("id", "key", "name", "description", "capabilities", "is_system")
VALUES
  (
    'f0000000-0000-4000-8000-000000000001',
    'owner',
    'Owner',
    'Full company portal access, including security, billing, and member administration.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'account.update', 'account.members.read', 'account.members.manage',
      'account.security.manage', 'account.notifications.manage',
      'bookings.read', 'bookings.create', 'bookings.update',
      'bookings.cancel', 'bookings.approve', 'properties.read',
      'properties.manage', 'jobs.read', 'jobs.change_request', 'media.read',
      'media.upload', 'proof.read', 'proof.request', 'rates.read',
      'invoices.read', 'payments.manage', 'documents.read',
      'documents.manage', 'messages.read', 'messages.send', 'reports.read',
      'reports.export'
    ]::text[],
    true
  ),
  (
    'f0000000-0000-4000-8000-000000000002',
    'admin',
    'Administrator',
    'Manage company operations, members, jobs, documents, and reporting.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'account.update', 'account.members.read', 'account.members.manage',
      'account.notifications.manage', 'bookings.read', 'bookings.create',
      'bookings.update', 'bookings.cancel', 'bookings.approve',
      'properties.read', 'properties.manage', 'jobs.read',
      'jobs.change_request', 'media.read', 'media.upload', 'proof.read',
      'proof.request', 'rates.read', 'invoices.read', 'documents.read',
      'documents.manage', 'messages.read', 'messages.send', 'reports.read',
      'reports.export'
    ]::text[],
    true
  ),
  (
    'f0000000-0000-4000-8000-000000000003',
    'scheduler',
    'Scheduler',
    'Manage properties, schedule work, upload job media, and communicate with the service team.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'account.members.read', 'bookings.read', 'bookings.create',
      'bookings.update', 'bookings.cancel', 'properties.read',
      'properties.manage', 'jobs.read', 'jobs.change_request', 'media.read',
      'media.upload', 'proof.read', 'proof.request', 'rates.read',
      'documents.read', 'messages.read', 'messages.send', 'reports.read'
    ]::text[],
    true
  ),
  (
    'f0000000-0000-4000-8000-000000000004',
    'approver',
    'Approver',
    'Review job requests, pricing context, documents, and completion proof.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'bookings.update', 'bookings.approve',
      'properties.read', 'jobs.read', 'jobs.change_request', 'media.read',
      'proof.read', 'proof.request', 'rates.read', 'invoices.read',
      'documents.read', 'messages.read', 'messages.send', 'reports.read'
    ]::text[],
    true
  ),
  (
    'f0000000-0000-4000-8000-000000000005',
    'billing',
    'Billing',
    'Manage invoices and payments and review service records and reports.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'properties.read', 'jobs.read', 'proof.read',
      'rates.read', 'invoices.read', 'payments.manage', 'documents.read',
      'messages.read', 'reports.read', 'reports.export'
    ]::text[],
    true
  ),
  (
    'f0000000-0000-4000-8000-000000000006',
    'viewer',
    'Viewer',
    'Read-only access to company service records, proof, documents, and reports.',
    ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'properties.read', 'jobs.read', 'media.read',
      'proof.read', 'rates.read', 'invoices.read', 'documents.read',
      'messages.read', 'reports.read'
    ]::text[],
    true
  )
ON CONFLICT DO NOTHING;

CREATE TABLE "partner_account_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id")
    ON DELETE RESTRICT,
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users"("id")
    ON DELETE CASCADE,
  "role_template_id" uuid REFERENCES "partner_role_templates"("id")
    ON DELETE SET NULL,
  "role_key" varchar(64) NOT NULL,
  "status" text DEFAULT 'invited' NOT NULL,
  "capability_grants" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "capability_denies" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "persona" varchar(64) DEFAULT 'other' NOT NULL,
  "access_level" text DEFAULT 'account' NOT NULL,
  "access_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "invited_by_partner_user_id" uuid REFERENCES "partner_users"("id")
    ON DELETE SET NULL,
  "invited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accepted_at" timestamp with time zone,
  "suspended_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_account_memberships_status_check"
    CHECK ("status" IN ('invited', 'active', 'suspended', 'removed')),
  CONSTRAINT "partner_account_memberships_role_key_check"
    CHECK ("role_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "partner_account_memberships_persona_check"
    CHECK ("persona" IN (
      'contractor',
      'real_estate_agent',
      'property_manager',
      'commercial_client',
      'other'
    )),
  CONSTRAINT "partner_account_memberships_access_level_check"
    CHECK ("access_level" IN ('account', 'scoped')),
  CONSTRAINT "partner_account_memberships_override_conflict_check"
    CHECK (NOT ("capability_grants" && "capability_denies")),
  CONSTRAINT "partner_account_memberships_lifecycle_check" CHECK (
    (
      "status" = 'invited' AND "accepted_at" IS NULL
      AND "suspended_at" IS NULL AND "removed_at" IS NULL
    ) OR (
      "status" = 'active' AND "accepted_at" IS NOT NULL
      AND "suspended_at" IS NULL AND "removed_at" IS NULL
    ) OR (
      "status" = 'suspended' AND "accepted_at" IS NOT NULL
      AND "suspended_at" IS NOT NULL AND "removed_at" IS NULL
    ) OR ("status" = 'removed' AND "removed_at" IS NOT NULL)
  ),
  CONSTRAINT "partner_account_memberships_session_identity_key"
    UNIQUE ("id", "partner_account_id", "partner_user_id")
);

CREATE UNIQUE INDEX "partner_account_memberships_account_user_key"
  ON "partner_account_memberships" ("partner_account_id", "partner_user_id");

CREATE UNIQUE INDEX "partner_account_memberships_default_user_key"
  ON "partner_account_memberships" ("partner_user_id")
  WHERE "is_default" = true AND "status" = 'active';

CREATE INDEX "partner_account_memberships_account_status_idx"
  ON "partner_account_memberships" ("partner_account_id", "status", "created_at");

CREATE INDEX "partner_account_memberships_user_status_idx"
  ON "partner_account_memberships" ("partner_user_id", "status", "is_default");

CREATE TABLE "partner_access_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_hash" varchar(64) NOT NULL,
  "email" text NOT NULL,
  "normalized_email" text NOT NULL,
  "name" text NOT NULL,
  "phone" text,
  "phone_e164" text,
  "company_name" text NOT NULL,
  "website" text,
  "partner_type" text NOT NULL,
  "service_areas" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "requested_needs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "status" text DEFAULT 'submitted' NOT NULL,
  "applicant_partner_user_id" uuid REFERENCES "partner_users"("id")
    ON DELETE SET NULL,
  "approved_partner_account_id" uuid REFERENCES "partner_accounts"("id")
    ON DELETE RESTRICT,
  "reviewed_by_member_id" uuid REFERENCES "team_members"("id")
    ON DELETE SET NULL,
  "email_verified_at" timestamp with time zone,
  "terms_accepted_at" timestamp with time zone NOT NULL,
  "privacy_accepted_at" timestamp with time zone NOT NULL,
  "review_note" text,
  "reviewed_at" timestamp with time zone,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_access_applications_identity_hash_check"
    CHECK ("identity_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_access_applications_status_check"
    CHECK ("status" IN (
      'submitted',
      'under_review',
      'needs_information',
      'approved',
      'declined',
      'withdrawn'
    )),
  CONSTRAINT "partner_access_applications_version_check" CHECK ("version" > 0),
  CONSTRAINT "partner_access_applications_approval_check" CHECK (
    "status" <> 'approved'
    OR ("approved_partner_account_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "partner_access_applications_active_identity_key"
  ON "partner_access_applications" ("identity_hash")
  WHERE "status" IN ('submitted', 'under_review', 'needs_information');

CREATE INDEX "partner_access_applications_status_idx"
  ON "partner_access_applications" ("status", "submitted_at");

CREATE TABLE "partner_company_join_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_user_id" uuid NOT NULL REFERENCES "partner_users"("id")
    ON DELETE CASCADE,
  "partner_account_id" uuid NOT NULL REFERENCES "partner_accounts"("id")
    ON DELETE RESTRICT,
  "requested_role_key" varchar(64) DEFAULT 'member' NOT NULL,
  "message" text,
  "status" text DEFAULT 'submitted' NOT NULL,
  "reviewed_by_partner_user_id" uuid REFERENCES "partner_users"("id")
    ON DELETE SET NULL,
  "reviewed_by_member_id" uuid REFERENCES "team_members"("id")
    ON DELETE SET NULL,
  "resolved_membership_id" uuid REFERENCES "partner_account_memberships"("id")
    ON DELETE RESTRICT,
  "review_note" text,
  "reviewed_at" timestamp with time zone,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_company_join_requests_status_check"
    CHECK ("status" IN (
      'submitted',
      'under_review',
      'needs_information',
      'approved',
      'declined',
      'withdrawn'
    )),
  CONSTRAINT "partner_company_join_requests_role_key_check"
    CHECK ("requested_role_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "partner_company_join_requests_version_check" CHECK ("version" > 0),
  CONSTRAINT "partner_company_join_requests_approval_check" CHECK (
    "status" <> 'approved'
    OR ("resolved_membership_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "partner_company_join_requests_active_account_user_key"
  ON "partner_company_join_requests" ("partner_account_id", "partner_user_id")
  WHERE "status" IN ('submitted', 'under_review', 'needs_information');

CREATE INDEX "partner_company_join_requests_account_status_idx"
  ON "partner_company_join_requests" ("partner_account_id", "status", "requested_at");

CREATE INDEX "partner_company_join_requests_user_status_idx"
  ON "partner_company_join_requests" ("partner_user_id", "status");

-- Bridge existing V1 organizations to an existing CRM partner account first.
WITH existing_account_contacts AS (
  SELECT DISTINCT ON (contact."partner_account_id")
    contact."partner_account_id",
    contact."id" AS "portal_contact_id"
  FROM "contacts" contact
  INNER JOIN "partner_users" portal_user
    ON portal_user."org_contact_id" = contact."id"
  WHERE contact."partner_account_id" IS NOT NULL
    AND contact."partner_status" = 'partner'
    AND contact."deleted_at" IS NULL
  ORDER BY contact."partner_account_id", portal_user."created_at", contact."id"
)
UPDATE "partner_accounts" account
SET "portal_contact_id" = candidate."portal_contact_id",
    "portal_access_enabled" = true,
    "updated_at" = now()
FROM existing_account_contacts candidate
WHERE account."id" = candidate."partner_account_id"
  AND account."portal_contact_id" IS NULL;

-- Create one compatibility account only where V1 has no account link. The
-- portal_contact_id key makes the mapping deterministic for future adapters.
INSERT INTO "partner_accounts" (
  "name",
  "normalized_name",
  "segment",
  "status",
  "source",
  "portal_contact_id",
  "portal_access_enabled"
)
SELECT
  COALESCE(
    NULLIF(btrim(contact."company"), ''),
    NULLIF(btrim(concat_ws(' ', contact."first_name", contact."last_name")), ''),
    'Legacy partner'
  ),
  COALESCE(
    NULLIF(
      btrim(lower(regexp_replace(
        COALESCE(
          NULLIF(btrim(contact."company"), ''),
          concat_ws(' ', contact."first_name", contact."last_name")
        ),
        '[^a-zA-Z0-9]+',
        ' ',
        'g'
      ))),
      ''
    ),
    'legacy-partner-' || contact."id"::text
  ),
  contact."partner_type",
  'portal_partner',
  'partner_portal_legacy_backfill',
  contact."id",
  true
FROM "contacts" contact
WHERE contact."partner_account_id" IS NULL
  AND contact."partner_status" = 'partner'
  AND contact."deleted_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "partner_users" portal_user
    WHERE portal_user."org_contact_id" = contact."id"
  )
ON CONFLICT DO NOTHING;

UPDATE "contacts" contact
SET "partner_account_id" = account."id",
    "updated_at" = now()
FROM "partner_accounts" account
WHERE contact."partner_account_id" IS NULL
  AND account."portal_contact_id" = contact."id";

-- An account linked to any currently eligible V1 portal user must be enabled,
-- including accounts that already had a different compatibility contact.
UPDATE "partner_accounts" account
SET "portal_access_enabled" = true,
    "updated_at" = now()
FROM "contacts" contact
INNER JOIN "partner_users" portal_user
  ON portal_user."org_contact_id" = contact."id"
WHERE account."id" = contact."partner_account_id"
  AND contact."partner_status" = 'partner'
  AND contact."deleted_at" IS NULL
  AND account."portal_access_enabled" = false;

-- V1 had no role distinction. Owner-equivalent memberships preserve every
-- existing user's behavior; future invitations use explicit least-privilege
-- templates instead.
INSERT INTO "partner_account_memberships" (
  "partner_account_id",
  "partner_user_id",
  "role_template_id",
  "role_key",
  "status",
  "persona",
  "access_level",
  "access_scope",
  "preferences",
  "is_default",
  "invited_at",
  "accepted_at"
)
SELECT
  contact."partner_account_id",
  portal_user."id",
  'f0000000-0000-4000-8000-000000000001',
  'owner',
  'active',
  CASE
    WHEN lower(COALESCE(contact."partner_type", '')) ~ 'contract'
      THEN 'contractor'
    WHEN lower(COALESCE(contact."partner_type", '')) ~ '(real.?estate|realtor|agent)'
      THEN 'real_estate_agent'
    WHEN lower(COALESCE(contact."partner_type", '')) ~ '(property.?manage|manager)'
      THEN 'property_manager'
    WHEN lower(COALESCE(contact."partner_type", '')) ~ '(commercial|business|client)'
      THEN 'commercial_client'
    ELSE 'other'
  END,
  'account',
  '{}'::jsonb,
  '{}'::jsonb,
  true,
  portal_user."created_at",
  portal_user."created_at"
FROM "partner_users" portal_user
INNER JOIN "contacts" contact ON contact."id" = portal_user."org_contact_id"
WHERE contact."partner_account_id" IS NOT NULL
  AND contact."partner_status" = 'partner'
  AND contact."deleted_at" IS NULL
ON CONFLICT ("partner_account_id", "partner_user_id") DO NOTHING;

ALTER TABLE "partner_sessions"
  ADD COLUMN "active_partner_account_id" uuid,
  ADD COLUMN "active_membership_id" uuid,
  ADD COLUMN "auth_method" text DEFAULT 'legacy' NOT NULL,
  ADD COLUMN "assurance_level" text DEFAULT 'aal1' NOT NULL,
  ADD COLUMN "mfa_verified_at" timestamp with time zone,
  ADD COLUMN "security_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "device_name" text,
  ADD COLUMN "account_selected_at" timestamp with time zone,
  ADD COLUMN "rotated_from_session_id" uuid;

UPDATE "partner_sessions" session
SET "active_partner_account_id" = membership."partner_account_id",
    "active_membership_id" = membership."id",
    "account_selected_at" = COALESCE(session."last_seen_at", session."created_at")
FROM "partner_account_memberships" membership
WHERE membership."partner_user_id" = session."partner_user_id"
  AND membership."status" = 'active'
  AND membership."is_default" = true;

ALTER TABLE "partner_sessions"
  ADD CONSTRAINT "partner_sessions_active_partner_account_id_fk"
    FOREIGN KEY ("active_partner_account_id")
    REFERENCES "partner_accounts"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "partner_sessions_active_membership_id_fk"
    FOREIGN KEY ("active_membership_id")
    REFERENCES "partner_account_memberships"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "partner_sessions_rotated_from_session_id_fk"
    FOREIGN KEY ("rotated_from_session_id")
    REFERENCES "partner_sessions"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "partner_sessions_active_membership_identity_fk"
    FOREIGN KEY (
      "active_membership_id",
      "active_partner_account_id",
      "partner_user_id"
    ) REFERENCES "partner_account_memberships"(
      "id",
      "partner_account_id",
      "partner_user_id"
    ) ON DELETE CASCADE,
  ADD CONSTRAINT "partner_sessions_auth_method_check"
    CHECK ("auth_method" IN ('legacy', 'magic_link', 'password', 'passkey', 'mfa_step_up')),
  ADD CONSTRAINT "partner_sessions_assurance_level_check"
    CHECK ("assurance_level" IN ('aal1', 'aal2')),
  ADD CONSTRAINT "partner_sessions_security_version_check"
    CHECK ("security_version" > 0),
  ADD CONSTRAINT "partner_sessions_account_binding_check"
    CHECK (("active_partner_account_id" IS NULL) = ("active_membership_id" IS NULL)),
  ADD CONSTRAINT "partner_sessions_device_name_check"
    CHECK (
      "device_name" IS NULL
      OR char_length(btrim("device_name")) BETWEEN 1 AND 120
    );

CREATE INDEX "partner_sessions_user_active_idx"
  ON "partner_sessions" ("partner_user_id", "revoked_at", "expires_at");

CREATE INDEX "partner_sessions_account_idx"
  ON "partner_sessions" ("active_partner_account_id", "partner_user_id");
