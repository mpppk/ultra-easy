CREATE TABLE outbox_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  outbox_key TEXT NOT NULL,
  notification_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  recipient_mode TEXT NOT NULL,
  recipient_user_id TEXT,
  materialized_step_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  UNIQUE (organization_id, outbox_key),
  UNIQUE (organization_id, notification_key)
);

CREATE INDEX outbox_events_dispatch_idx
  ON outbox_events (status, sequence);

CREATE INDEX outbox_events_action_request_idx
  ON outbox_events (organization_id, action_request_id, sequence);

CREATE TABLE notification_deliveries (
  organization_id TEXT NOT NULL,
  notification_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (organization_id, notification_key, recipient_user_id)
);

CREATE INDEX notification_deliveries_status_idx
  ON notification_deliveries (organization_id, status);
