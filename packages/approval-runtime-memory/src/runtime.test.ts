import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionRequestId,
  ApprovalPlanChecksum,
  ApproverResolver,
  MaterializedApprovalPlan,
  OrganizationId,
} from "@app/approval-core";

import { ApprovalRuntimeAlreadyExistsError, InMemoryApprovalRuntime } from "./runtime.ts";

const resolver: ApproverResolver = {
  check: async () => Result.succeed(false),
  list: async () => Result.succeed({ userIds: [], complete: true }),
};

function noApprovalPlan(): MaterializedApprovalPlan {
  return {
    schemaVersion: 1,
    actionRequestId: "action-request:memory-test" as ActionRequestId,
    organizationId: "organization:memory-test" as OrganizationId,
    action: {
      definition: {
        key: "action:test" as MaterializedApprovalPlan["action"]["definition"]["key"],
        version: 1,
        actionType: "test" as MaterializedApprovalPlan["action"]["definition"]["actionType"],
        inputSchema: { key: "schema:test", version: 1 },
        executorKey: "executor:test" as MaterializedApprovalPlan["action"]["definition"]["executorKey"],
      },
      type: "test" as MaterializedApprovalPlan["action"]["type"],
      resource: {
        type: "test" as MaterializedApprovalPlan["action"]["resource"]["type"],
        id: "resource:memory-test" as MaterializedApprovalPlan["action"]["resource"]["id"],
      },
      input: {},
    },
    evaluationSnapshot: {
      actor: { type: "user", id: "user:actor" as never },
      authority: { principal: { type: "user", id: "user:actor" as never } },
      origin: { type: "api" },
      organization: { id: "organization:memory-test" as OrganizationId },
      evaluatedAt: "2026-09-13T00:00:00.000Z",
    },
    policyBindingSnapshots: [],
    flow: { type: "none" },
    interpreterSemanticsVersion: 1,
    actionFingerprint: "sha256:action" as MaterializedApprovalPlan["actionFingerprint"],
    evaluationSnapshotChecksum:
      "sha256:evaluation" as MaterializedApprovalPlan["evaluationSnapshotChecksum"],
    approvalPlanChecksum: "sha256:plan" as ApprovalPlanChecksum,
    approvalBindingFingerprint:
      "sha256:binding" as MaterializedApprovalPlan["approvalBindingFingerprint"],
  };
}

describe("InMemoryApprovalRuntime", () => {
  it("approval不要Planをterminal approvedで開始し、同じActionRequestの二重開始を拒否する", async () => {
    const runtime = new InMemoryApprovalRuntime(resolver);
    const plan = noApprovalPlan();

    const started = await runtime.start({
      plan,
      startedAt: "2026-09-13T00:00:00.000Z",
    });
    assert(Result.isSuccess(started));
    expect(started.value.status).toBe("approved");
    expect(started.value.tasks).toEqual([]);

    const duplicate = await runtime.start({
      plan,
      startedAt: "2026-09-13T00:00:00.000Z",
    });
    assert(Result.isFailure(duplicate));
    expect(duplicate.error).toBeInstanceOf(ApprovalRuntimeAlreadyExistsError);
  });
});
