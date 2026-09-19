CREATE TABLE approval_commands (
  command_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  task_id TEXT,
  command_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_user_id TEXT,
  comment TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (organization_id, command_id)
);

CREATE INDEX approval_commands_action_request_idx
  ON approval_commands (organization_id, action_request_id);

CREATE INDEX approval_commands_status_idx
  ON approval_commands (organization_id, status);

CREATE TABLE api_idempotency_keys (
  organization_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  response_location TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation, idempotency_key)
);

CREATE INDEX api_idempotency_status_idx
  ON api_idempotency_keys (organization_id, status);
