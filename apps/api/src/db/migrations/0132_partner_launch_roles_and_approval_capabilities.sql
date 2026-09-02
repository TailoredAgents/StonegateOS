-- Lock the launch role model to four product roles and migrate approval
-- authority from mutable role-name checks to a stable capability snapshot.

ALTER TABLE "partner_account_memberships"
  ADD COLUMN "migration_review_status" text NOT NULL DEFAULT 'not_required',
  ADD COLUMN "migration_legacy_role_key" varchar(64),
  ADD COLUMN "migration_reviewed_by_team_member_id" uuid REFERENCES "team_members"("id") ON DELETE SET NULL,
  ADD COLUMN "migration_reviewed_at" timestamptz,
  ADD COLUMN "migration_review_note" text,
  ADD CONSTRAINT "partner_account_memberships_migration_review_check"
    CHECK ("migration_review_status" IN ('not_required', 'pending', 'approved', 'quarantined')),
  ADD CONSTRAINT "partner_account_memberships_migration_review_evidence_check"
    CHECK (
      ("migration_review_status" = 'approved'
        AND "migration_reviewed_at" IS NOT NULL
        AND "migration_reviewed_by_team_member_id" IS NOT NULL)
      OR "migration_review_status" <> 'approved'
    );

INSERT INTO "partner_role_templates" (
  "key", "name", "description", "capabilities", "is_system", "active", "version"
)
SELECT
  'administrator',
  'Administrator',
  'Account-wide team, security, operations, approvals, billing, documents, and reporting.',
  ARRAY[
    'portal.session.read', 'portal.session.switch_account', 'account.read',
    'account.update', 'account.members.read', 'account.members.manage',
    'account.security.manage', 'account.notifications.manage', 'bookings.read',
    'bookings.create', 'bookings.update', 'bookings.cancel',
    'bookings.pricing.read', 'approvals.read', 'approvals.decide',
    'properties.read', 'properties.manage', 'jobs.read', 'jobs.change_request',
    'media.read', 'media.upload', 'proof.read', 'proof.request', 'rates.read',
    'commercial.edit', 'invoices.read', 'payments.initiate',
    'documents.operational.read', 'documents.operational.manage',
    'documents.financial.read', 'documents.financial.manage', 'messages.read',
    'messages.send', 'reports.operational.read', 'reports.operational.export',
    'reports.financial.read', 'reports.financial.export'
  ]::text[],
  true, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "partner_role_templates"
  WHERE "partner_account_id" IS NULL AND "key" = 'administrator'
);

INSERT INTO "partner_role_templates" (
  "key", "name", "description", "capabilities", "is_system", "active", "version"
)
SELECT
  'operations',
  'Operations',
  'Schedules work, manages locations and proof, and communicates with Stonegate.',
  ARRAY[
    'portal.session.read', 'portal.session.switch_account', 'account.read',
    'bookings.read', 'bookings.create', 'bookings.update', 'bookings.cancel',
    'bookings.pricing.read', 'properties.read', 'properties.manage', 'jobs.read',
    'jobs.change_request', 'media.read', 'media.upload', 'proof.read',
    'proof.request', 'documents.operational.read',
    'documents.operational.manage', 'messages.read', 'messages.send',
    'reports.operational.read', 'reports.operational.export'
  ]::text[],
  true, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "partner_role_templates"
  WHERE "partner_account_id" IS NULL AND "key" = 'operations'
);

INSERT INTO "partner_role_templates" (
  "key", "name", "description", "capabilities", "is_system", "active", "version"
)
SELECT
  'billing_approver',
  'Billing / Approver',
  'Approves requests and manages quotes, invoices, payments, statements, and financial exports.',
  ARRAY[
    'portal.session.read', 'portal.session.switch_account', 'account.read',
    'bookings.read', 'bookings.pricing.read', 'approvals.read',
    'approvals.decide', 'properties.read', 'jobs.read', 'proof.read',
    'rates.read', 'commercial.edit', 'invoices.read', 'payments.initiate',
    'documents.financial.read', 'documents.financial.manage',
    'reports.financial.read', 'reports.financial.export'
  ]::text[],
  true, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "partner_role_templates"
  WHERE "partner_account_id" IS NULL AND "key" = 'billing_approver'
);

INSERT INTO "partner_role_templates" (
  "key", "name", "description", "capabilities", "is_system", "active", "version"
)
SELECT
  'viewer',
  'Viewer',
  'Read-only operational access without financial data, exports, uploads, or sends.',
  ARRAY[
    'portal.session.read', 'portal.session.switch_account', 'account.read',
    'bookings.read', 'properties.read', 'jobs.read', 'media.read', 'proof.read',
    'documents.operational.read', 'messages.read', 'reports.operational.read'
  ]::text[],
  true, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "partner_role_templates"
  WHERE "partner_account_id" IS NULL AND "key" = 'viewer'
);

-- Replace any earlier global template with the locked launch definition. The
-- version bump invalidates stale invitation snapshots.
UPDATE "partner_role_templates"
SET
  "name" = CASE "key"
    WHEN 'administrator' THEN 'Administrator'
    WHEN 'operations' THEN 'Operations'
    WHEN 'billing_approver' THEN 'Billing / Approver'
    ELSE 'Viewer'
  END,
  "description" = CASE "key"
    WHEN 'administrator' THEN 'Account-wide team, security, operations, approvals, billing, documents, and reporting.'
    WHEN 'operations' THEN 'Schedules work, manages locations and proof, and communicates with Stonegate.'
    WHEN 'billing_approver' THEN 'Approves requests and manages quotes, invoices, payments, statements, and financial exports.'
    ELSE 'Read-only operational access without financial data, exports, uploads, or sends.'
  END,
  "capabilities" = CASE "key"
    WHEN 'administrator' THEN ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'account.update', 'account.members.read', 'account.members.manage',
      'account.security.manage', 'account.notifications.manage', 'bookings.read',
      'bookings.create', 'bookings.update', 'bookings.cancel',
      'bookings.pricing.read', 'approvals.read', 'approvals.decide',
      'properties.read', 'properties.manage', 'jobs.read', 'jobs.change_request',
      'media.read', 'media.upload', 'proof.read', 'proof.request', 'rates.read',
      'commercial.edit', 'invoices.read', 'payments.initiate',
      'documents.operational.read', 'documents.operational.manage',
      'documents.financial.read', 'documents.financial.manage', 'messages.read',
      'messages.send', 'reports.operational.read', 'reports.operational.export',
      'reports.financial.read', 'reports.financial.export'
    ]::text[]
    WHEN 'operations' THEN ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'bookings.create', 'bookings.update', 'bookings.cancel',
      'bookings.pricing.read', 'properties.read', 'properties.manage', 'jobs.read',
      'jobs.change_request', 'media.read', 'media.upload', 'proof.read',
      'proof.request', 'documents.operational.read',
      'documents.operational.manage', 'messages.read', 'messages.send',
      'reports.operational.read', 'reports.operational.export'
    ]::text[]
    WHEN 'billing_approver' THEN ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'bookings.pricing.read', 'approvals.read',
      'approvals.decide', 'properties.read', 'jobs.read', 'proof.read',
      'rates.read', 'commercial.edit', 'invoices.read', 'payments.initiate',
      'documents.financial.read', 'documents.financial.manage',
      'reports.financial.read', 'reports.financial.export'
    ]::text[]
    ELSE ARRAY[
      'portal.session.read', 'portal.session.switch_account', 'account.read',
      'bookings.read', 'properties.read', 'jobs.read', 'media.read', 'proof.read',
      'documents.operational.read', 'messages.read', 'reports.operational.read'
    ]::text[]
  END,
  "is_system" = true,
  "active" = true,
  "version" = "version" + 1,
  "updated_at" = now()
WHERE "partner_account_id" IS NULL
  AND "key" IN ('administrator', 'operations', 'billing_approver', 'viewer');

-- Capture the previous assignment before changing it. Privileged legacy
-- assignments remain usable during shadow mode, but cutover preflight must
-- find zero pending reviews.
UPDATE "partner_account_memberships"
SET
  "migration_legacy_role_key" = "role_key",
  "migration_review_status" = CASE
    WHEN "role_key" IN ('owner', 'admin', 'approver', 'billing') THEN 'pending'
    WHEN "role_key" IN ('scheduler', 'requester', 'viewer') THEN 'not_required'
    WHEN "role_key" IN ('administrator', 'operations', 'billing_approver') THEN 'not_required'
    ELSE 'quarantined'
  END,
  "updated_at" = now()
WHERE "migration_legacy_role_key" IS NULL;

-- A legacy explicit grant must not collide with the temporary deny used to
-- prevent privilege expansion while a privileged mapping awaits review.
UPDATE "partner_account_memberships" AS "membership"
SET "capability_grants" = ARRAY(
  SELECT "capability"
  FROM unnest("membership"."capability_grants") AS "capability"
  WHERE "capability" <> ALL(
    CASE
      WHEN "membership"."migration_legacy_role_key" = 'admin' THEN
        ARRAY['account.security.manage', 'payments.initiate']::text[]
      WHEN "membership"."migration_legacy_role_key" = 'approver' THEN
        ARRAY['payments.initiate', 'reports.financial.export', 'commercial.edit']::text[]
      WHEN "membership"."migration_legacy_role_key" = 'billing' THEN
        ARRAY['approvals.read', 'approvals.decide', 'commercial.edit']::text[]
      ELSE ARRAY[]::text[]
    END
  )
)
WHERE "migration_legacy_role_key" IN ('admin', 'approver', 'billing');

WITH "mapping"("legacy_key", "target_key") AS (
  VALUES
    ('owner', 'administrator'),
    ('admin', 'administrator'),
    ('scheduler', 'operations'),
    ('requester', 'operations'),
    ('approver', 'billing_approver'),
    ('billing', 'billing_approver'),
    ('viewer', 'viewer')
)
UPDATE "partner_account_memberships" AS "membership"
SET
  "role_key" = "mapping"."target_key",
  "role_template_id" = "template"."id",
  "capability_denies" = CASE
    WHEN "membership"."migration_legacy_role_key" = 'admin' THEN
      ARRAY(
        SELECT DISTINCT unnest(
          "membership"."capability_denies" ||
          ARRAY['account.security.manage', 'payments.initiate']::text[]
        )
      )
    WHEN "membership"."migration_legacy_role_key" = 'approver' THEN
      ARRAY(
        SELECT DISTINCT unnest(
          "membership"."capability_denies" ||
          ARRAY['payments.initiate', 'reports.financial.export', 'commercial.edit']::text[]
        )
      )
    WHEN "membership"."migration_legacy_role_key" = 'billing' THEN
      ARRAY(
        SELECT DISTINCT unnest(
          "membership"."capability_denies" ||
          ARRAY['approvals.read', 'approvals.decide', 'commercial.edit']::text[]
        )
      )
    ELSE "membership"."capability_denies"
  END,
  "updated_at" = now()
FROM "mapping"
INNER JOIN "partner_role_templates" AS "template"
  ON "template"."partner_account_id" IS NULL
  AND "template"."key" = "mapping"."target_key"
  AND "template"."active" = true
WHERE "membership"."migration_legacy_role_key" = "mapping"."legacy_key";

-- Unknown/custom legacy assignments cannot be represented safely by the
-- locked launch model. Suspend the membership and require explicit recovery.
UPDATE "partner_account_memberships"
SET
  "status" = CASE WHEN "status" IN ('active', 'invited') THEN 'suspended' ELSE "status" END,
  "is_default" = false,
  "accepted_at" = CASE
    WHEN "status" = 'invited' THEN COALESCE("accepted_at", now())
    ELSE "accepted_at"
  END,
  "suspended_at" = CASE
    WHEN "status" IN ('active', 'invited') THEN COALESCE("suspended_at", now())
    ELSE "suspended_at"
  END,
  "updated_at" = now()
WHERE "migration_review_status" = 'quarantined';

UPDATE "partner_role_templates"
SET "active" = false, "updated_at" = now()
WHERE "partner_account_id" IS NULL
  AND "key" IN ('owner', 'admin', 'scheduler', 'requester', 'approver', 'billing');

UPDATE "partner_account_invitations"
SET
  "status" = 'revoked',
  "token_hash" = NULL,
  "revoked_at" = now(),
  "delivery_detail" = 'superseded_role_model',
  "version" = "version" + 1,
  "updated_at" = now()
WHERE "status" = 'pending';

ALTER TABLE "partner_approval_rules"
  ALTER COLUMN "required_approver_role_keys" SET DEFAULT ARRAY[]::text[],
  ADD COLUMN "required_approver_capabilities" text[] NOT NULL
    DEFAULT ARRAY['approvals.decide']::text[];

UPDATE "partner_approval_rules"
SET "required_approver_capabilities" = ARRAY['approvals.decide']::text[];
