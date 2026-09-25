-- #165: async executor（Composite Action等）の受付と最終完了。
-- `accepted | cancel_requested -> completed` をCASで一度だけ確定し、completionのbinding
-- （fingerprint / execution_ref / idempotency_key）が一致する完了だけを受理する。
CREATE TABLE action_async_executions (
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  execution_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  executor_key TEXT NOT NULL,
  guarantee_level TEXT NOT NULL,
  workflow_instance_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'cancel_requested', 'completed')),
  accepted_at TEXT NOT NULL,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  completion_json TEXT,
  completed_at TEXT,
  PRIMARY KEY (organization_id, action_request_id)
);

CREATE INDEX action_async_executions_open_idx
  ON action_async_executions (organization_id, status, accepted_at);
