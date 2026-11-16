CREATE TABLE agent_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES team_members(id),
  token_hash text NOT NULL UNIQUE,
  tools jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE agent_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES agent_integrations(id),
  request_key text NOT NULL,
  tool text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved','executing','succeeded','failed','uncertain','rejected')),
  approved_by uuid REFERENCES team_members(id),
  approved_at timestamptz,
  expires_at timestamptz NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(integration_id, request_key)
);
--> statement-breakpoint
CREATE INDEX agent_operations_status_created_idx ON agent_operations(status, created_at);
--> statement-breakpoint
CREATE TABLE agent_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES agent_integrations(id),
  tool text NOT NULL,
  operation_id uuid REFERENCES agent_operations(id),
  outcome text NOT NULL,
  record_refs jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX agent_access_events_integration_created_idx ON agent_access_events(integration_id, created_at);
