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
  'organization:staging', 'authorization:relationship-update', 1, 'authorization.relationship.update',
  '{"actionType":"authorization.relationship.update","executorKey":"authorization","inputSchema":{"key":"authorization:relationship-update","version":1},"key":"authorization:relationship-update","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
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
INSERT OR IGNORE INTO published_approval_policy_versions (
  organization_id, policy_key, version, policy_json, actor_json,
  source_action_request_id, published_at
) VALUES (
  'organization:staging', 'policy:staging-authorization-relationship', 1,
  '{"description":"M9 staging E2E: can_approve grants need approval, others do not","key":"policy:staging-authorization-relationship","name":"staging-authorization-relationship","rules":[{"flow":{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12aa04a279d37e02306c6"}},"key":"security","purpose":"security_approval","type":"approval"},"key":"approver-rights","when":{"left":{"path":"action.input.tuple.relation","type":"field"},"operator":"eq","right":{"type":"literal","value":"can_approve"},"type":"comparison"}},{"flow":{"type":"none"},"key":"default","when":{"type":"always"}}],"schemaVersion":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  'organization:staging', 'binding:staging-authorization-relationship', 'policy:staging-authorization-relationship', 1,
  '{"compositionOrder":100,"enabled":true,"id":"binding:staging-authorization-relationship","organizationId":"organization:staging","policyKey":"policy:staging-authorization-relationship","selector":{"actionTypes":["authorization.relationship.update"]}}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;
INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  'organization:staging', 'staging:ticket-escalate', 1, 'ticket.escalate',
  '{"actionType":"ticket.escalate","executorKey":"staging","inputSchema":{"key":"staging:ticket-update","version":1},"key":"staging:ticket-escalate","version":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT OR IGNORE INTO published_approval_policy_versions (
  organization_id, policy_key, version, policy_json, actor_json,
  source_action_request_id, published_at
) VALUES (
  'organization:staging', 'policy:staging-parallel-escalation', 1,
  '{"description":"M9 staging E2E: serial of any / all / quorum parallel groups","key":"policy:staging-parallel-escalation","name":"staging-parallel-escalation","rules":[{"flow":{"children":[{"children":[{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12807a4ea2a6f7c2ccc09"}},"key":"triage-alice","type":"approval"},{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12aa04a279d37e02306c6"}},"key":"triage-bob","type":"approval"}],"strategy":"any","type":"parallel"},{"children":[{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12807a4ea2a6f7c2ccc09"}},"key":"review-alice","purpose":"business_approval","type":"approval"},{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12aa04a279d37e02306c6"}},"key":"review-bob","purpose":"security_approval","type":"approval"}],"strategy":"all","type":"parallel"},{"children":[{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12807a4ea2a6f7c2ccc09"}},"key":"board-alice","type":"approval"},{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12aa04a279d37e02306c6"}},"key":"board-bob","type":"approval"},{"approver":{"type":"user","userId":{"type":"literal","value":"user:auth0|6ab12807a4ea2a6f7c2ccc09"}},"key":"board-alice-2","resolution":"snapshot","type":"approval"}],"quorum":2,"strategy":"quorum","type":"parallel"}],"type":"serial"},"key":"default","when":{"type":"always"}}],"schemaVersion":1}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
);
INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  'organization:staging', 'binding:staging-ticket-escalate', 'policy:staging-parallel-escalation', 1,
  '{"compositionOrder":100,"enabled":true,"id":"binding:staging-ticket-escalate","organizationId":"organization:staging","policyKey":"policy:staging-parallel-escalation","selector":{"actionTypes":["ticket.escalate"]}}', '{"id":"service:bootstrap","type":"service"}', 'bootstrap:m8-staging-seed', '2026-09-22T00:00:00.000Z'
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;
