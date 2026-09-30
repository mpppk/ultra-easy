-- #198: ActionDefinition version -> downstream MCP tool routing for MCP-backed primitive
-- Actions registered in the Action Catalog. ActionRequests that do not pass through the
-- Gateway's tools/call (public API submit, Workflow child Actions) have no route snapshot;
-- the executor resolves the route bound to the snapshotted definition (key, version).
-- Rows are installed by reviewed catalog migrations (docs/application-catalog.md) and are
-- immutable: a routing change is a new ActionDefinition version, never an UPDATE.
CREATE TABLE mcp_action_routes (
  organization_id TEXT NOT NULL,
  action_definition_key TEXT NOT NULL,
  action_definition_version INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  route_json TEXT NOT NULL,
  route_fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_definition_key, action_definition_version)
);

CREATE TRIGGER mcp_action_routes_no_update
  BEFORE UPDATE ON mcp_action_routes
BEGIN
  SELECT RAISE(ABORT, 'mcp_action_routes is immutable');
END;

CREATE TRIGGER mcp_action_routes_no_delete
  BEFORE DELETE ON mcp_action_routes
BEGIN
  SELECT RAISE(ABORT, 'mcp_action_routes is immutable');
END;
