-- MCP Gateway state (M10). Gateway-owned state is limited to protocol projection,
-- routing snapshots and logical invocation metadata. Approval / Authorization /
-- execution lifecycle stays on the ActionRequest tables.

-- One row per logical tools/call (organization + principal + client scoped key).
-- A durable MCP Task is the same row (task_id), so Task and invocation are 1:1.
CREATE TABLE mcp_invocations (
  organization_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'prepared', 'committed', 'completed')),
  request_hash TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  task_id TEXT,
  action_request_id TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, invocation_id)
);

CREATE UNIQUE INDEX mcp_invocations_task_idx
  ON mcp_invocations (organization_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX mcp_invocations_action_request_idx
  ON mcp_invocations (organization_id, action_request_id);

CREATE INDEX mcp_invocations_lease_idx
  ON mcp_invocations (organization_id, status, lease_expires_at);

-- Downstream route bound to an ActionRequest at admission (INSERT-only), so a
-- binding change while approval is pending cannot redirect the approved Action.
CREATE TABLE mcp_route_snapshots (
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  binding_fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_request_id)
);
