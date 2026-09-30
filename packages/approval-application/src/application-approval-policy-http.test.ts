import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  brandLiteral,
  type ApplicationApprovalScheme,
  type PrincipalRef,
} from "@app/approval-core";

import { createPublicApplicationApprovalPolicyApi } from "./application-approval-policy-http.ts";

const SCHEME: ApplicationApprovalScheme = {
  application: "knowledge",
  scopeResourceType: "knowledge_space",
  policyKey: "app:knowledge:approval",
  bindingId: "binding:app:knowledge:approval",
  metaPolicyKey: "app:knowledge:approval-policy-meta",
  metaBindingId: "binding:app:knowledge:approval-policy-meta",
  actions: [
    { actionType: "knowledge.page.archive", conditionFields: [], principalFields: ["pageOwnerId"] },
  ],
  approvers: { space_owners: { relation: "owner" } },
  requesterIsNot: {},
  defaultPolicy: { rules: [] },
  metaApprovalRelation: "owner",
};

function api(input: { principal: PrincipalRef; member?: boolean; agentId?: string }) {
  const reads: string[] = [];
  const handler = createPublicApplicationApprovalPolicyApi({
    schemes: [SCHEME],
    repository: {
      current: async () => {
        reads.push("current");
        return Result.succeed(null);
      },
      recentProposalIds: async () => Result.succeed([]),
    },
    actionRequests: { getActionRequest: async () => Result.succeed(null) },
    identityProvider: { authenticate: async () => Result.succeed(input.principal) },
    accessChecker: { canView: async () => Result.succeed(input.member ?? false) },
    ...(input.agentId ? { applicationAgentId: input.agentId } : {}),
  });
  return { handler, reads };
}

const url = (scopeType: string, scopeId: string) =>
  new Request(
    `https://api.example/v1/organizations/organization%3Astaging/application-policies/${scopeType}/${scopeId}`,
  );
const user: PrincipalRef = { type: "user", id: brandLiteral("UserId", "user:alice") };
const agent: PrincipalRef = { type: "agent", id: brandLiteral("AgentId", "agent:knowledge") };

describe("public application approval policy read API (#199)", () => {
  it("returns the default rules of a member's space", async () => {
    const { handler } = api({ principal: user, member: true });
    const response = await handler.fetch(url("knowledge_space", "spc-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scopeType: "knowledge_space",
      scopeId: "spc-1",
      version: 0,
      policy: { rules: [] },
      pendingChange: null,
    });
  });

  it("refuses non-members, other agents, unknown scopes and invalid IDs before reading", async () => {
    for (const [principal, scopeType, scopeId, status] of [
      [user, "knowledge_space", "spc-1", 403],
      [agent, "knowledge_space", "spc-1", 403],
      [user, "ticket", "t-1", 404],
      [user, "knowledge_space", "bad%20id", 400],
    ] as const) {
      const { handler, reads } = api({ principal });
      const response = await handler.fetch(url(scopeType, scopeId));
      expect(response.status).toBe(status);
      expect(reads).toEqual([]);
    }
    const registered = api({ principal: agent, agentId: "agent:knowledge" });
    expect((await registered.handler.fetch(url("knowledge_space", "spc-1"))).status).toBe(200);
  });
});
