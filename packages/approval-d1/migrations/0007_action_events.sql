CREATE TABLE action_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (organization_id, event_key)
);

CREATE INDEX action_events_action_request_idx
  ON action_events (organization_id, action_request_id, sequence);
