ALTER TABLE partner_accounts
  ADD COLUMN IF NOT EXISTS portal_workflow_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS portal_workflow_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE partner_accounts ADD CONSTRAINT partner_accounts_workflow_object_check
  CHECK (jsonb_typeof(portal_workflow_config) = 'object' AND portal_workflow_revision > 0);
