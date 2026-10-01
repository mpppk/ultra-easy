import { Result } from "@praha/byethrow";
import { describe, expect, it } from "vite-plus/test";

import {
  HttpTrustedContextError,
  type ActionRequestView,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import type { ActionRequestId, OrganizationId, UserId } from "@app/approval-core";

import { createPublicActionCancellationApi } from "./public-action-cancel-http.ts";

const organizationId = "organization:one" as OrganizationId;
const actionRequestId = "ar:one" as ActionRequestId;
const alice = "user:alice" as UserId;
const bob = "user:bob" as UserId;
const path = `/v1/organizations/${String(organizationId)}/action-requests/${String(actionRequestId)}/cancel`;

function view(status: ActionRequestView["status"] = "pending_approval"): ActionRequestView {
  return {
    id: actionRequestId,
    organizationId,
    actor: { type: "user", id: alice },
    authorityPrincipal: { type: "user", id: alice },
    action: {
      type: "knowledge.publish_document" as ActionRequestView["action"]["type"],
      resource: {
        type: "knowledge_space" as ActionRequestView["action"]["resource"]["type"],
        id: "space:one" as ActionRequestView["action"]["resource"]["id"],
      },
      input: { spaceId: "space:one", publicationSnapshotId: "pub:one" },
    },
    origin: "api",
    status,
    approval: { required: true, activeTaskCount: 1 },
    checksums: {
      actionFingerprint: "sha256:action",
      evaluationSnapshotChecksum: "sha256:evaluation",
      approvalPlanChecksum: "sha256:plan",
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

class MemoryIdempotency implements IdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  private key(input: { organizationId: OrganizationId; operation: string; key: string }) {
    return `${String(input.organizationId)}|${input.operation}|${input.key}`;
  }

  reserve(record: IdempotencyRecord) {
    const key = this.key(record);
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, record);
      return Promise.resolve(Result.succeed({ type: "acquired" as const, record }));
    }
    return Promise.resolve(
      Result.succeed({
        type:
          existing.requestHash !== record.requestHash ? ("conflict" as const) : ("replay" as const),
        record: existing,
      }),
    );
  }

  complete(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: import("@app/approval-core").JsonValue;
    responseLocation?: string;
    completedAt: string;
  }) {
    const key = this.key(input);
    const record = this.records.get(key)!;
    const completed: IdempotencyRecord = {
      ...record,
      status: "completed",
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      updatedAt: input.completedAt,
    };
    this.records.set(key, completed);
    return Promise.resolve(Result.succeed(completed));
  }

  release(input: { organizationId: OrganizationId; operation: string; key: string }) {
    this.records.delete(this.key(input));
    return Promise.resolve(Result.succeed(undefined));
  }
}

function harness(status: ActionRequestView["status"] = "pending_approval") {
  let current = view(status);
  const calls: string[] = [];
  const identityProvider: PublicHttpIdentityProvider = {
    authenticate: async ({ request, organizationId: tenant, actionType }) => {
      if (tenant !== organizationId)
        return Result.fail(new HttpTrustedContextError(403, "organization_forbidden", "Forbidden"));
      const token = request.headers.get("authorization");
      if (token !== "Bearer alice" && token !== "Bearer bob")
        return Result.fail(new HttpTrustedContextError(401, "invalid_token", "Unauthorized"));
      if (actionType && actionType !== "knowledge.publish_document")
        return Result.fail(new HttpTrustedContextError(403, "client_not_allowed", "Forbidden"));
      return Result.succeed({ type: "user" as const, id: token === "Bearer alice" ? alice : bob });
    },
  };
  const api = createPublicActionCancellationApi({
    readRepository: {
      getActionRequest: async ({ organizationId: tenant, actionRequestId: id }) =>
        Result.succeed(tenant === organizationId && id === actionRequestId ? current : null),
    },
    identityProvider,
    idempotencyRepository: new MemoryIdempotency(),
    clock: { now: () => "2026-10-01T00:00:00Z" },
    control: {
      cancelPending: async () => {
        calls.push("pending");
        current = view("cancelled");
        return Result.succeed({ duplicate: false });
      },
      cancelRunning: async () => {
        calls.push("running");
        current = view("cancelled");
        return Result.succeed({ runId: "run:one" });
      },
    },
  });
  return {
    api,
    calls,
    setStatus: (next: ActionRequestView["status"]) => {
      current = view(next);
    },
  };
}

function request(token = "alice", key = "cancel:one", body = "{}"): Request {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body,
  });
}

describe("public ActionRequest cancellation (#217)", () => {
  it("cancels a requester's pending approval and replays the same key", async () => {
    const { api, calls } = harness();
    const first = await api.fetch(request());
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ actionRequestId, status: "cancelled" });
    const replay = await api.fetch(request());
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ actionRequestId, status: "cancelled" });
    expect(calls).toEqual(["pending"]);
  });

  it("routes an executing composite to the run cancellation control", async () => {
    const { api, calls } = harness("executing");
    const response = await api.fetch(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      actionRequestId,
      runId: "run:one",
      status: "cancel_requested",
    });
    expect(calls).toEqual(["running"]);
  });

  it("rejects another actor, another tenant, and an unauthenticated caller", async () => {
    const { api, calls } = harness();
    expect((await api.fetch(request("bob"))).status).toBe(403);
    expect((await api.fetch(request("invalid"))).status).toBe(401);
    const other = new Request(
      `https://example.test/v1/organizations/organization:other/action-requests/ar:one/cancel`,
      {
        method: "POST",
        headers: { authorization: "Bearer alice", "idempotency-key": "cancel:one" },
      },
    );
    expect((await api.fetch(other)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects terminal states and retries an execution gap without sending a cancellation", async () => {
    const { api, calls, setStatus } = harness("executed");
    expect((await api.fetch(request())).status).toBe(409);
    setStatus("approved");
    expect((await api.fetch(request("alice", "cancel:two"))).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("validates the body and idempotency key", async () => {
    const { api, calls } = harness();
    expect((await api.fetch(request("alice", "cancel:one", '{"other":true}'))).status).toBe(400);
    expect((await api.fetch(request("alice", "", "{}"))).status).toBe(400);
    expect((await api.fetch(request("alice", "cancel:one", "x".repeat(65_537)))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});
