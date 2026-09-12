import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import {
  actor,
  always,
  approve,
  authorityPrincipal,
  authorizeActionRequest,
  caller,
  definePolicy,
  delegator,
  materializeApprovalPlan,
  principal,
  rule,
  serial,
} from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  AgentId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  AuthorizationConsistency,
  AuthorizationDecision,
  DelegationGrantId,
  ExecutorKey,
  OrganizationId,
  PolicyEvaluationContext,
  ResourceId,
  SchemaKey,
  UserId,
} from "@app/approval-core";
import {
  createAgentActionRequest,
  createDelegatedAgentActionRequest,
} from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

class CapturingAuthorizer implements ActionAuthorizer {
  readonly calls: AuthorizationConsistency[] = [];
  authorityPrincipal: string | undefined;

  async check(input: {
    request: ReturnType<typeof createAgentActionRequest>;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }) {
    this.calls.push(input.consistency);
    this.authorityPrincipal = String(input.request.authority.principal.id);
    const decision: AuthorizationDecision = {
      type: "allow",
      evidence: {
        evaluatedAt: input.evaluatedAt,
        provider: "fake",
        consistency: input.consistency,
      },
    };
    return Result.succeed(decision);
  }
}

describe("M3 Delegation / Principal Identity", () => {
  it("AC-M3-008: 再委譲しても上流grantにないresource scopeを獲得できない", async () => {
    const request = createDelegatedAgentActionRequest();
    const middleAgent = branded<AgentId>("agent:middle");
    const leafAgent = branded<AgentId>("agent:leaf");
    const upstreamResource = request.action.resource.id;
    const downstreamOnlyResource = branded<ResourceId>("TICKET-999");

    request.actor = { type: "agent", id: leafAgent };
    request.action.resource.id = downstreamOnlyResource;
    request.authority.delegation = {
      chain: [
        {
          delegator: request.authority.principal,
          delegatee: { type: "agent", id: middleAgent },
          grantId: branded<DelegationGrantId>("delegation:authority-to-middle"),
          scope: {
            actionTypes: [request.action.type],
            resourceTypes: [request.action.resource.type],
            resourceIds: [upstreamResource],
          },
        },
        {
          delegator: { type: "agent", id: middleAgent },
          delegatee: { type: "agent", id: leafAgent },
          grantId: branded<DelegationGrantId>("delegation:middle-to-leaf"),
          scope: {
            actionTypes: [request.action.type],
            resourceTypes: [request.action.resource.type],
            resourceIds: [downstreamOnlyResource],
          },
        },
      ],
    };

    const authorizer = new CapturingAuthorizer();
    const result = await authorizeActionRequest({
      authorizer,
      request,
      evaluatedAt: "2026-09-12T12:00:00.000Z",
    });

    assert(Result.isSuccess(result));
    expect(result.value).toMatchObject({ type: "deny", code: "delegation_scope_denied" });
    expect(authorizer.calls).toHaveLength(0);
  });

  it("AC-M3-009: actor（creator相当）/caller/authority/delegatorを独立して参照する", async () => {
    const request = createAgentActionRequest();
    const actorUser = branded<UserId>("user:actor");
    const callerUser = branded<UserId>("user:caller");
    const authorityUser = branded<UserId>("user:authority");
    const delegatorUser = branded<UserId>("user:delegator");

    request.actor = { type: "user", id: actorUser };
    request.origin.caller = { type: "user", id: callerUser };
    request.authority = {
      principal: { type: "user", id: authorityUser },
      delegation: {
        chain: [
          {
            delegator: { type: "user", id: authorityUser },
            delegatee: { type: "user", id: delegatorUser },
            grantId: branded<DelegationGrantId>("delegation:authority-to-delegator"),
          },
          {
            delegator: { type: "user", id: delegatorUser },
            delegatee: { type: "user", id: actorUser },
            grantId: branded<DelegationGrantId>("delegation:delegator-to-actor"),
          },
        ],
      },
    };

    const organizationId = branded<OrganizationId>("org:m3-identities");
    const context: PolicyEvaluationContext = {
      ...request,
      organization: { id: organizationId },
      now: "2026-09-12T12:00:00.000Z",
    };
    const policyKey = branded<ApprovalPolicyKey>("policy:m3-identities");
    const binding: ApprovalPolicyBinding = {
      id: branded<ApprovalPolicyBindingId>("binding:m3-identities"),
      organizationId,
      policyKey,
      selector: { actionTypes: [request.action.type] },
      enabled: true,
    };
    const actionDefinition: ActionDefinition = {
      key: branded<ActionDefinitionKey>("ticket-priority-change"),
      version: 1,
      actionType: request.action.type,
      inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
      executorKey: branded<ExecutorKey>("ticket-executor"),
    };

    const plan = await materializeApprovalPlan({
      actionRequestId: branded<ActionRequestId>("action-request:m3-identities"),
      context,
      actionDefinition,
      policyBindings: [
        {
          binding,
          policyVersion: 1,
          policy: definePolicy({
            key: String(policyKey),
            name: "Principal Identity Separation",
            rules: [
              rule("default", {
                when: always(),
                flow: serial(
                  approve({ key: "actor", approver: principal(actor()) }),
                  approve({ key: "caller", approver: principal(caller()) }),
                  approve({ key: "authority", approver: principal(authorityPrincipal()) }),
                  approve({ key: "delegator", approver: principal(delegator()) }),
                ),
              }),
            ],
          }),
        },
      ],
    });

    assert(plan.type === "materialized", plan.type === "error" ? plan.message : undefined);
    assert(plan.plan.flow.type === "serial");
    const resolvedPrincipalIds = plan.plan.flow.children.map((child) => {
      assert(child.type === "approval");
      assert(child.target.type === "user");
      return String(child.target.userId);
    });
    expect(resolvedPrincipalIds).toEqual([
      "user:actor",
      "user:caller",
      "user:authority",
      "user:delegator",
    ]);

    const authorizer = new CapturingAuthorizer();
    const authorization = await authorizeActionRequest({
      authorizer,
      request,
      evaluatedAt: "2026-09-12T12:00:00.000Z",
    });
    assert(Result.isSuccess(authorization));
    expect(authorization.value.type).toBe("allow");
    expect(authorizer.authorityPrincipal).toBe("user:authority");
    expect(authorizer.calls).toEqual(["higher_consistency"]);
  });
});
