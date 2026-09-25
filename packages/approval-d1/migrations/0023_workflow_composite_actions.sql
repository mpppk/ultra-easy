-- #158: Composite Action（Workflow）のbindingとchild ActionRequest相関（workflow bounded context）。

-- ActionDefinition version -> WorkflowVersion / checksum。immutable（insert-only）。
CREATE TABLE workflow_action_bindings (
  organization_id TEXT NOT NULL,
  action_definition_key TEXT NOT NULL,
  action_definition_version INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  workflow_definition_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  workflow_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_definition_key, action_definition_version)
);

CREATE INDEX workflow_action_bindings_workflow_idx
  ON workflow_action_bindings (organization_id, workflow_definition_id, workflow_version);

CREATE TRIGGER workflow_action_bindings_no_update
  BEFORE UPDATE ON workflow_action_bindings
BEGIN
  SELECT RAISE(ABORT, 'workflow_action_bindings is immutable');
END;

CREATE TRIGGER workflow_action_bindings_no_delete
  BEFORE DELETE ON workflow_action_bindings
BEGIN
  SELECT RAISE(ABORT, 'workflow_action_bindings is immutable');
END;

-- child ActionRequest -> WorkflowRun / NodeRun / Effect（audit correlation / nesting guard）。
CREATE TABLE workflow_child_actions (
  organization_id TEXT NOT NULL,
  child_action_request_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  parent_action_request_id TEXT,
  depth INTEGER NOT NULL,
  ancestry_json TEXT NOT NULL,
  action_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, child_action_request_id)
);

CREATE INDEX workflow_child_actions_run_idx ON workflow_child_actions (organization_id, run_id);
