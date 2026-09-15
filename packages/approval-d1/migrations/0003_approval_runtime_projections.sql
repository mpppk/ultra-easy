CREATE TABLE approval_runtime_projections (
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  approval_plan_checksum TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_request_id)
);

CREATE TABLE approval_tasks (
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  materialized_step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  candidate_user_ids TEXT NOT NULL,
  decisions TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  expires_at TEXT,
  closed_at TEXT,
  distinct_scope_id TEXT,
  PRIMARY KEY (organization_id, task_id)
);

CREATE INDEX approval_tasks_action_request_idx
  ON approval_tasks (organization_id, action_request_id);

CREATE INDEX approval_tasks_status_idx
  ON approval_tasks (organization_id, status);
