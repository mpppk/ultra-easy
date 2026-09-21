CREATE TABLE IF NOT EXISTS operator_alert_states (
  organization_id TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  breached_since TEXT,
  last_outbox_failed_total INTEGER,
  last_executor_failure_total INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_operator_alert_states_status
  ON operator_alert_states (status, updated_at);
