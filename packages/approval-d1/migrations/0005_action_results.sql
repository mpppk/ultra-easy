CREATE TABLE action_results (
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  guarantee_level TEXT,
  idempotency_key TEXT,
  result TEXT,
  code TEXT,
  message TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_request_id)
);

CREATE INDEX action_results_status_idx
  ON action_results (organization_id, status);
