CREATE TABLE action_requests (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  evaluation_snapshot TEXT NOT NULL,
  evaluation_snapshot_checksum TEXT NOT NULL,
  policy_binding_snapshots TEXT NOT NULL,
  materialized_plan TEXT NOT NULL,
  approval_plan_checksum TEXT NOT NULL,
  approval_binding_fingerprint TEXT NOT NULL,
  interpreter_semantics_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);
