// Staging bootstrap seed generator (M8-1).
// Governance bootstrap rule (docs/governance-bootstrap.md) に従い、
// version-controlledなSQLとして出力する。出力は冪等（INSERT OR IGNORE / upsert）。
// 実行: bun run packages/approval-d1/bootstrap/generate-staging-seed.ts
import { writeFileSync } from "node:fs";

import { Result } from "@praha/byethrow";
import {
  always,
  approve,
  AUTHORIZATION_RELATIONSHIP_UPDATE_DEFINITION,
  canonicalizeJson,
  definePolicy,
  eq,
  field,
  GOVERNANCE_ACTION_DEFINITIONS,
  literal,
  none,
  parallelAll,
  parallelAny,
  parallelQuorum,
  rule,
  serial,
  user,
} from "@app/approval-core";

const ORGANIZATION_ID = "organization:staging";
const SOURCE = "bootstrap:m8-staging-seed";
const OCCURRED_AT = "2026-09-22T00:00:00.000Z";
const ACTOR = { type: "service", id: "service:bootstrap" };

const ALICE = "user:auth0|6ab12807a4ea2a6f7c2ccc09";
const BOB = "user:auth0|6ab12aa04a279d37e02306c6";

function mustJson(value: unknown): string {
  const serialized = canonicalizeJson(value as never);
  if (Result.isFailure(serialized)) {
    console.error(serialized.error);
    process.exit(1);
  }
  return serialized.value;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const statements: string[] = [];
statements.push("-- ultra-easy staging bootstrap seed (M8-1). Idempotent: re-apply safe.");
statements.push(`-- source: ${SOURCE} at ${OCCURRED_AT}`);

// M9-2: governed relationship mutation (bootstrap-installed like governance definitions).
for (const definition of [
  ...GOVERNANCE_ACTION_DEFINITIONS,
  AUTHORIZATION_RELATIONSHIP_UPDATE_DEFINITION,
]) {
  statements.push(`INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, ${sqlQuote(String(definition.key))}, ${definition.version}, ${sqlQuote(String(definition.actionType))},
  ${sqlQuote(mustJson(definition))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
);`);
}

const stagingDefinition = {
  key: "staging:ticket-update",
  version: 1,
  actionType: "ticket.update",
  inputSchema: { key: "staging:ticket-update", version: 1 },
  executorKey: "staging",
};
statements.push(`INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'staging:ticket-update', 1, 'ticket.update',
  ${sqlQuote(mustJson(stagingDefinition))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
);`);

// #87: selfApprovalの既定はdeny（execution_consentを除く）。staging Auth0にはalice/bobの
// 2 userしか居らず、requester（can_execute）はaliceだけのため、aliceが承認するStepだけ
// selfApproval=allowを明示してopt-inする（semantic validatorのwarning対象）。bobのStepは
// 既定のdenyのまま職務分離を検証する。過去のversionはINSERT OR IGNOREで残り、新しいversionが優先される。
const ALICE_SELF_APPROVAL = { selfApproval: { mode: "allow" as const } };

function publishPolicyVersions(
  key: string,
  versions: readonly { version: number; policy: ReturnType<typeof definePolicy> }[],
): void {
  for (const { version, policy } of versions) {
    statements.push(`INSERT OR IGNORE INTO published_approval_policy_versions (
  organization_id, policy_key, version, policy_json, actor_json,
  source_action_request_id, published_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, ${sqlQuote(key)}, ${version},
  ${sqlQuote(mustJson(policy))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
);`);
  }
}

function serialTwoUsersPolicy(aliceSelfApproval: boolean) {
  return definePolicy({
    key: "policy:staging-serial-two-users",
    name: "staging-serial-two-users",
    description: "M8 staging E2E: direct-user serial approval (alice then bob)",
    rules: [
      rule("default", {
        when: always(),
        flow: serial(
          approve({
            key: "manager",
            approver: user(literal(ALICE)),
            purpose: "business_approval",
            ...(aliceSelfApproval ? ALICE_SELF_APPROVAL : {}),
          }),
          approve({ key: "finance", approver: user(literal(BOB)), purpose: "business_approval" }),
        ),
      }),
    ],
  });
}
publishPolicyVersions("policy:staging-serial-two-users", [
  { version: 1, policy: serialTwoUsersPolicy(false) },
  { version: 2, policy: serialTwoUsersPolicy(true) },
]);

const binding = {
  id: "binding:staging-ticket-update",
  organizationId: ORGANIZATION_ID,
  policyKey: "policy:staging-serial-two-users",
  selector: { actionTypes: ["ticket.update"] },
  compositionOrder: 100,
  enabled: true,
};
statements.push(`INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'binding:staging-ticket-update', 'policy:staging-serial-two-users', 1,
  ${sqlQuote(mustJson(binding))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;`);

// M9-2: granting approver rights (can_approve) requires bob's security approval;
// other catalog changes (e.g. can_execute) run without approval. Approval never
// overrides the editor authorization check.
const relationshipPolicy = definePolicy({
  key: "policy:staging-authorization-relationship",
  name: "staging-authorization-relationship",
  description: "M9 staging E2E: can_approve grants need approval, others do not",
  rules: [
    rule("approver-rights", {
      when: eq(field("action.input.tuple.relation"), literal("can_approve")),
      flow: approve({
        key: "security",
        approver: user(literal(BOB)),
        purpose: "security_approval",
      }),
    }),
    rule("default", { when: always(), flow: none() }),
  ],
});
statements.push(`INSERT OR IGNORE INTO published_approval_policy_versions (
  organization_id, policy_key, version, policy_json, actor_json,
  source_action_request_id, published_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'policy:staging-authorization-relationship', 1,
  ${sqlQuote(mustJson(relationshipPolicy))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
);`);

const relationshipBinding = {
  id: "binding:staging-authorization-relationship",
  organizationId: ORGANIZATION_ID,
  policyKey: "policy:staging-authorization-relationship",
  selector: { actionTypes: ["authorization.relationship.update"] },
  compositionOrder: 100,
  enabled: true,
};
statements.push(`INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'binding:staging-authorization-relationship', 'policy:staging-authorization-relationship', 1,
  ${sqlQuote(mustJson(relationshipBinding))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;`);

// M9-4: staging fixture exercising parallel completion semantics in Explorer
// simulation (serial of any / all / quorum groups). Same input schema as ticket.update.
const escalateDefinition = {
  key: "staging:ticket-escalate",
  version: 1,
  actionType: "ticket.escalate",
  inputSchema: { key: "staging:ticket-update", version: 1 },
  executorKey: "staging",
};
statements.push(`INSERT OR IGNORE INTO published_action_definitions (
  organization_id, definition_key, version, action_type, definition_json,
  actor_json, source_action_request_id, published_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'staging:ticket-escalate', 1, 'ticket.escalate',
  ${sqlQuote(mustJson(escalateDefinition))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
);`);
function escalatePolicy(aliceSelfApproval: boolean) {
  const aliceStep = aliceSelfApproval ? ALICE_SELF_APPROVAL : {};
  return definePolicy({
    key: "policy:staging-parallel-escalation",
    name: "staging-parallel-escalation",
    description: "M9 staging E2E: serial of any / all / quorum parallel groups",
    rules: [
      rule("default", {
        when: always(),
        flow: serial(
          parallelAny(
            approve({ key: "triage-alice", approver: user(literal(ALICE)), ...aliceStep }),
            approve({ key: "triage-bob", approver: user(literal(BOB)) }),
          ),
          parallelAll(
            approve({
              key: "review-alice",
              approver: user(literal(ALICE)),
              purpose: "business_approval",
              ...aliceStep,
            }),
            approve({
              key: "review-bob",
              approver: user(literal(BOB)),
              purpose: "security_approval",
            }),
          ),
          parallelQuorum(
            2,
            approve({ key: "board-alice", approver: user(literal(ALICE)), ...aliceStep }),
            approve({ key: "board-bob", approver: user(literal(BOB)) }),
            approve({
              key: "board-alice-2",
              approver: user(literal(ALICE)),
              resolution: "snapshot",
              ...aliceStep,
            }),
          ),
        ),
      }),
    ],
  });
}
publishPolicyVersions("policy:staging-parallel-escalation", [
  { version: 1, policy: escalatePolicy(false) },
  { version: 2, policy: escalatePolicy(true) },
]);
const escalateBinding = {
  id: "binding:staging-ticket-escalate",
  organizationId: ORGANIZATION_ID,
  policyKey: "policy:staging-parallel-escalation",
  selector: { actionTypes: ["ticket.escalate"] },
  compositionOrder: 100,
  enabled: true,
};
statements.push(`INSERT INTO approval_policy_bindings (
  organization_id, binding_id, policy_key, enabled, binding_json,
  actor_json, source_action_request_id, updated_at
) VALUES (
  ${sqlQuote(ORGANIZATION_ID)}, 'binding:staging-ticket-escalate', 'policy:staging-parallel-escalation', 1,
  ${sqlQuote(mustJson(escalateBinding))}, ${sqlQuote(mustJson(ACTOR))}, ${sqlQuote(SOURCE)}, ${sqlQuote(OCCURRED_AT)}
)
ON CONFLICT(organization_id, binding_id) DO UPDATE SET
  policy_key = excluded.policy_key,
  enabled = excluded.enabled,
  binding_json = excluded.binding_json,
  actor_json = excluded.actor_json,
  source_action_request_id = excluded.source_action_request_id,
  updated_at = excluded.updated_at;`);

writeFileSync(new URL("./staging-seed.sql", import.meta.url), `${statements.join("\n")}\n`);
console.log(`wrote ${statements.length} statements`);
