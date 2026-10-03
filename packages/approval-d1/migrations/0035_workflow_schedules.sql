CREATE TABLE workflow_schedules (
  organization_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_key TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  action_json TEXT NOT NULL,
  correlation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  next_slot_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, schedule_id),
  UNIQUE (organization_id, schedule_key)
);

CREATE INDEX workflow_schedules_due
  ON workflow_schedules (status, next_slot_at);

CREATE TABLE workflow_schedule_slots (
  organization_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  slot_at TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'accepted', 'denied', 'failed', 'skipped')),
  preparation_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, schedule_id, slot_at),
  UNIQUE (organization_id, action_request_id),
  FOREIGN KEY (organization_id, schedule_id)
    REFERENCES workflow_schedules (organization_id, schedule_id)
);

CREATE INDEX workflow_schedule_slots_retry
  ON workflow_schedule_slots (status, locked_until);
