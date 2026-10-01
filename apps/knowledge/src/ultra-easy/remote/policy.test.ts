import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import type { CompiledPolicy } from "../client.ts";
import { RemotePolicyClient } from "./policy.ts";

const organizationId = "organization:staging";
const spaceId = "space:one";
const policy: CompiledPolicy = {
  rules: [
    {
      key: "publish_confidential",
      actionType: "knowledge.revision.publish",
      when: { field: "sensitivity", equals: "confidential" },
      approvers: "space_owners",
    },
  ],
};

function client(send: (request: Request) => Promise<Response>) {
  return new RemotePolicyClient({
    baseUrl: "https://approval-api.internal",
    approvalUiBaseUrl: "https://ultra-easy.example",
    organizationId,
    principalId: "user:alice",
    accessToken: "verified-user-token",
    send,
  });
}

function view(pendingChange: unknown = null) {
  return { scopeType: "knowledge_space", scopeId: spaceId, version: 3, policy, pendingChange };
}

describe("Knowledge remote policy client (#183)", () => {
  it("reads current rules and a governed pending change", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      return Response.json(
        view({ actionRequestId: "ar:change", status: "pending_approval", policy }),
      );
    });
    const loaded = await remote.getPolicyBinding({ organizationId, spaceId });
    expect(Result.isSuccess(loaded)).toBe(true);
    if (Result.isFailure(loaded)) return;
    expect(loaded.value).toMatchObject({
      spaceId,
      version: 3,
      policy,
      pendingChange: {
        actionRequestId: "ar:change",
        approvalUrl: "https://ultra-easy.example/action-requests/ar%3Achange",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer verified-user-token");
    expect(seen[0]?.url).toContain("/application-policies/knowledge_space/space%3Aone");
  });

  it("submits an actor-bound policy ActionRequest with the current version", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      return request.method === "POST"
        ? Response.json(
            { id: "ar:change", organizationId, actor: { id: "user:alice" } },
            { status: 201 },
          )
        : Response.json(view());
    });
    const proposed = await remote.proposePolicyBinding({
      organizationId,
      spaceId,
      policy,
      actor: { id: "user:alice", displayName: "Alice" },
    });
    expect(Result.isSuccess(proposed)).toBe(true);
    expect(seen.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(seen[1]?.headers.get("idempotency-key")).toMatch(/^knowledge-policy:space:one:3:/);
    expect(await seen[1]?.json()).toEqual({
      action: {
        type: "application.approval_policy.update",
        resource: { type: "knowledge_space", id: spaceId },
        input: { baseVersion: 3, policy },
      },
    });
  });

  it("rejects another tenant or actor before sending", async () => {
    const seen: Request[] = [];
    const remote = client(async (request) => {
      seen.push(request);
      return Response.json(view());
    });
    const tenant = await remote.getPolicyBinding({ organizationId: "organization:other", spaceId });
    expect(Result.isFailure(tenant) && tenant.error.code).toBe("forbidden");
    const actor = await remote.proposePolicyBinding({
      organizationId,
      spaceId,
      policy,
      actor: { id: "user:bob", displayName: "Bob" },
    });
    expect(Result.isFailure(actor) && actor.error.code).toBe("forbidden");
    expect(seen).toHaveLength(0);
  });
});
