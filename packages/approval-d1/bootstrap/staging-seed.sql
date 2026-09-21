-- ultra-easy staging bootstrap seed (M8-1). Idempotent: re-apply safe.
-- source: bootstrap:m8-staging-seed at 2026-09-22T00:00:00.000Z
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'governance:action-definition-publish', 1, 'action_definition.publish',
  '{"actionType":"action_definition.publish","executorKey":"governance","inputSchema":{"key":"governance:action-definition-publish","version":1},"key":"governance:action-definition-publish","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'governance:approval-policy-publish', 1, 'approval_policy.publish',
  '{"actionType":"approval_policy.publish","executorKey":"governance","inputSchema":{"key":"governance:approval-policy-publish","version":1},"key":"governance:approval-policy-publish","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'governance:approval-policy-binding-update', 1, 'approval_policy_binding.update',
  '{"actionType":"approval_policy_binding.update","executorKey":"governance","inputSchema":{"key":"governance:approval-policy-binding-update","version":1},"key":"governance:approval-policy-binding-update","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'governance:admin-force-cancel', 1, 'admin.force_cancel',
  '{"actionType":"admin.force_cancel","executorKey":"governance","inputSchema":{"key":"governance:admin-force-cancel","version":1},"key":"governance:admin-force-cancel","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'staging:ticket-update', 1, 'ticket.update',
  '{"actionType":"ticket.update","executorKey":"staging","inputSchema":{"key":"staging:ticket-update","version":1},"key":"staging:ticket-update","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_approval_policy_versions (
  organization_id, policy_key, version, policy_json, actor_json,
  source_action_request_id, published_at
) VALUES (
  'organization:staging', 'policy:staging-serial-two-users', 1,
  '{"description":"M8 staging E2E: direct-user serial approval (alice then bob)","key":"policy:staging-serial-two-users","name":"staging-serial-two-users","rules":[{"flow":{"children":[{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12807a4ea2a6f7c2ccc09"}},"key":"manager","purpose":"business_approval","type":"approval"},{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12aa04a279d37e02306c6"}},"key":"finance","purpose":"business_approval","type":"approval"}],"type":"serial"},"key":"default","when":{"type":"always"}}],"schemaVersion":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  'organization:staging', 'binding:staging-ticket-update', 'policy:staging-serial-two-users', 1,
  '{"compositionOrder":100,"enabled":true,"id":"binding:staging-ticket-update","organizationId":"organization:staging","policyKey":"policy:staging-serial-two-users","selector":{"actionTypes":["ticket.update"]}}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;
