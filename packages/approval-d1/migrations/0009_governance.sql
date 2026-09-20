CREATE TABLE published_action_definitions (
  organization_id TEXT NOT NULL,
  definition_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, definition_key, version),
  UNIQUE (organization_id, action_type, version)
);

CREATE INDEX published_action_definitions_action_idx
  ON published_action_definitions (organization_id, action_type, version DESC);

CREATE TABLE published_approval_policy_versions (
  organization_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, policy_key, version)
);

CREATE INDEX published_approval_policy_latest_idx
  ON published_approval_policy_versions (organization_id, policy_key, version DESC);

CREATE TABLE approval_policy_bindings (
  organization_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, binding_id)
);

CREATE INDEX approval_policy_bindings_enabled_idx
  ON approval_policy_bindings (organization_id, enabled, binding_id);

CREATE TABLE force_cancel_audit (
  organization_id TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  target_action_request_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  post_review_required INTEGER NOT NULL CHECK (post_review_required = 1),
  PRIMARY KEY (organization_id, source_action_request_id)
);

CREATE INDEX force_cancel_audit_target_idx
  ON force_cancel_audit (organization_id, target_action_request_id, occurred_at);
