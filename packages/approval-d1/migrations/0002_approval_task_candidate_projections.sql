CREATE TABLE approval_task_candidate_projections (
  organization_id TEXT NOT NULL,
  approval_task_id TEXT NOT NULL,
  materialized_step_id TEXT NOT NULL,
  candidate_user_ids TEXT NOT NULL,
  complete INTEGER NOT NULL,
  resolved_at TEXT NOT NULL,
  source_revision TEXT,
  PRIMARY KEY (organization_id, approval_task_id)
);
