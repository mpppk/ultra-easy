-- #199: application-scoped approval rules (e.g. one Knowledge space's publication / archive
-- rules). Rows are the approved rule history per scope (insert-only); the latest version is the
-- current rule. Each approved change also publishes the next version of the compiled Approval
-- Policies in the same transaction (docs/application-catalog.md).
CREATE TABLE application_approval_policies (
  organization_id TEXT NOT NULL,
  application TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  policy_json TEXT NOT NULL,
  approval_policy_version INTEGER NOT NULL,
  actor_json TEXT NOT NULL,
  source_action_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, application, scope_type, scope_id, version)
);

CREATE UNIQUE INDEX application_approval_policies_source_idx
  ON application_approval_policies (organization_id, source_action_request_id);

CREATE TRIGGER application_approval_policies_no_update
  BEFORE UPDATE ON application_approval_policies
BEGIN
  SELECT RAISE(ABORT, 'application_approval_policies is immutable');
END;

CREATE TRIGGER application_approval_policies_no_delete
  BEFORE DELETE ON application_approval_policies
BEGIN
  SELECT RAISE(ABORT, 'application_approval_policies is immutable');
END;

-- Pending rule-change proposals of one scope (read API: current rule + pending change).
CREATE INDEX action_requests_action_resource_idx
  ON action_requests (
    organization_id,
    json_extract(materialized_plan, '$.action.type'),
    json_extract(materialized_plan, '$.action.resource.type'),
    json_extract(materialized_plan, '$.action.resource.id'),
    created_at DESC
  );

-- Bootstrap the built-in governed action for both deployed organizations. Which applications
-- may use it, and their meta-approval, come from the reviewed catalog migrations.
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
)
SELECT organization_id, 'application:approval-policy-update', 1,
  'application.approval_policy.update',
  '{"actionType":"application.approval_policy.update","executorKey":"application-policy","inputSchema":{"key":"application:approval-policy-update","version":1},"key":"application:approval-policy-update","version":1}',
  '{"id":"service:bootstrap","type":"service"}',
  'bootstrap:application-approval-policy', '2026-09-30T00:00:00.000Z'
FROM (
  SELECT 'organization:staging' AS organization_id
  UNION ALL
  SELECT 'organization:production'
);
