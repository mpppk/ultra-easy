import { Result } from "@praha/byethrow";
import { describe, expect, it, vi } from "vite-plus/test";

import type { MaterializedApprovalPlan } from "@app/approval-core";

import { CloudflareActionWorkflowStarter } from "./workflow-starter.ts";

// approval-runtime-cloudflareは `cloudflare:workers` をimportするためVitestでは差し替える。
vi.mock("@app/approval-runtime-cloudflare", () => ({
  actionWorkflowInstanceId: (input: { actionRequestId: string }) =>
    Promise.resolve(`workflow-${input.actionRequestId}`),
}));

const plan = {
  organizationId: "org:staging",
  actionRequestId: "action:1",
  approvalPlanChecksum: "sha256:plan",
} as unknown as MaterializedApprovalPlan;

describe("CloudflareActionWorkflowStarter", () => {
  it("決定的instance IDが既に存在する場合のstartは冪等に成功する（commit再開）", async () => {
    const created: string[] = [];
    const starter = new CloudflareActionWorkflowStarter({
      create: ({ id }) => {
        if (created.includes(id)) return Promise.reject(new Error("instance already exists"));
        created.push(id);
        return Promise.resolve({ id });
      },
      get: (id) =>
        created.includes(id) ? Promise.resolve({ id }) : Promise.reject(new Error("not found")),
    });

    const first = await starter.start({ plan, startedAt: "2026-09-24T00:00:00.000Z" });
    const resumed = await starter.start({ plan, startedAt: "2026-09-24T00:01:00.000Z" });

    expect(Result.isSuccess(first) && Result.isSuccess(resumed)).toBe(true);
    expect(created).toHaveLength(1);
    expect(Result.isSuccess(resumed) && resumed.value.workflowInstanceId).toBe(created[0]);
  });

  it("instanceが存在しないcreate失敗はretriableなworkflow_start_failed", async () => {
    const starter = new CloudflareActionWorkflowStarter({
      create: () => Promise.reject(new Error("workflows unavailable")),
      get: () => Promise.reject(new Error("not found")),
    });

    const started = await starter.start({ plan, startedAt: "2026-09-24T00:00:00.000Z" });

    expect(Result.isFailure(started) && started.error).toMatchObject({
      code: "workflow_start_failed",
      retriable: true,
    });
  });
});
