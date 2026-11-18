ALTER TABLE agent_integrations ADD COLUMN approval_mode text NOT NULL DEFAULT 'per_action' CHECK (approval_mode IN ('per_action','owner_delegated'));
