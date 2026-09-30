-- Bootstrap the built-in governed relationship action for both deployed organizations.
-- The normal ActionRequest pipeline owns authorization, approval, and audit.
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
)
SELECT organization_id, 'application:relationship-update', 1,
  'application.relationship.update',
  '{"key":"application:relationship-update","version":1,"actionType":"application.relationship.update","inputSchema":{"key":"application:relationship-update","version":1},"executorKey":"authorization"}',
  '{"type":"service","id":"service:bootstrap"}',
  'bootstrap:application-relationship', '2026-09-30T00:00:00.000Z'
FROM (
  SELECT 'organization:staging' AS organization_id
  UNION ALL
  SELECT 'organization:production'
);

CREATE INDEX authorization_relationships_app_roles_idx
  ON authorization_relationships (organization_id, subject, logical_object, relation);
CREATE INDEX authorization_relationships_app_members_idx
  ON authorization_relationships (organization_id, logical_object, subject, relation);
