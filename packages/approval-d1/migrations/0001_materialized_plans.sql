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

CREATE UNIQUE INDEX action_requests_approval_binding_fingerprint_idx
  ON action_requests (organization_id, approval_binding_fingerprint);

CREATE TABLE approval_candidate_cohorts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  materialized_step_id TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  source_revision TEXT,
  FOREIGN KEY (organization_id, action_request_id)
    REFERENCES action_requests (organization_id, id)
);

CREATE TABLE approval_candidate_cohort_members (
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, user_id),
  UNIQUE (cohort_id, ordinal),
  FOREIGN KEY (cohort_id) REFERENCES approval_candidate_cohorts (id)
);
