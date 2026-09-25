-- Stand-in for ultra-easy platform state used by the Knowledge example app
-- (#167) until the Workflow Engine public API exists (#154-#165). Lives in its
-- own D1 database so Knowledge data never embeds workflow / approval state.

CREATE TABLE mock_principals (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);

-- Authorization relationships (OpenFGA stand-in): space#viewer|editor|owner.
CREATE TABLE mock_space_roles (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  PRIMARY KEY (organization_id, principal_id, space_id)
);
CREATE INDEX mock_space_roles_space ON mock_space_roles (organization_id, space_id);

CREATE TABLE mock_action_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  parent_id TEXT,
  run_id TEXT,
  action_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE mock_workflow_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  space_id TEXT NOT NULL,
  page_id TEXT,
  publication_snapshot_id TEXT,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mock_workflow_runs_space ON mock_workflow_runs (organization_id, space_id, updated_at);
CREATE INDEX mock_workflow_runs_request ON mock_workflow_runs (organization_id, action_request_id);

CREATE TABLE mock_approval_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  run_id TEXT,
  action_type TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX mock_approval_tasks_request ON mock_approval_tasks (action_request_id);

-- Approval Policy Bindings compiled from Knowledge presets (per space).
CREATE TABLE mock_policy_bindings (
  organization_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, space_id)
);

CREATE TABLE mock_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX mock_audit_events_run ON mock_audit_events (run_id, seq);
