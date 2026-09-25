import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import {
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  computeApprovalPlanChecksum,
  computeEvaluationSnapshotChecksum,
} from "@app/approval-core";
import type {
  ActionEventRecord,
  ActionExecutionRequest,
  ActionRequestId,
  ActionResultRecord,
  ApprovalRuntimeState,
  MaterializedApprovalPlan,
  OrganizationId,
  Sha256Digest,
  TelemetryRecord,
  UserId,
} from "@app/approval-core";

import { cloudflareWorkflowDependencies } from "./cloudflare-workflow.ts";
import { fgaTokenSupplier } from "./fga-token.ts";
import type { ActionWorkflowDependencies, ActionWorkflowEnv } from "./workflow-dependencies.ts";
import {
  actionWorkflowInstanceId,
  runActionWorkflow,
  type ActionWorkflowParams,
} from "./workflow.ts";

const organizationId = "organization:di-test" as OrganizationId;
const alice = "user:alice" as UserId;

async function noApprovalPlan(name: string): Promise<MaterializedApprovalPlan> {
  const action = {
    definition: {
      key: "action:di",
      version: 1,
      actionType: "di",
      inputSchema: { key: "schema:di", version: 1 },
      executorKey: "executor:di",
    },
    type: "di",
    resource: { type: "document", id: `document:${name}` },
    input: { name },
  } as unknown as MaterializedApprovalPlan["action"];
  const evaluationSnapshot: MaterializedApprovalPlan["evaluationSnapshot"] = {
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "api" },
    organization: { id: organizationId },
    evaluatedAt: "2026-09-25T00:00:00.000Z",
  };
  const flow: MaterializedApprovalPlan["flow"] = { type: "none" };
  const policyBindingSnapshots: MaterializedApprovalPlan["policyBindingSnapshots"] = [
    {
      bindingId: "binding:di" as never,
      policyKey: "policy:di" as never,
      policyVersion: 1,
      policyDefinitionChecksum: `sha256:${"1".repeat(64)}` as Sha256Digest,
      selector: { actionTypes: [action.type] },
      enabled: true,
      outcome: { type: "matched", ruleKey: "rule:di" as never, flowType: flow.type },
    },
  ];
  const actionFingerprint = await computeActionFingerprint(action);
  assert(Result.isSuccess(actionFingerprint));
  const evaluationSnapshotChecksum = await computeEvaluationSnapshotChecksum(evaluationSnapshot);
  assert(Result.isSuccess(evaluationSnapshotChecksum));
  const approvalPlanChecksum = await computeApprovalPlanChecksum({
    policyBindingSnapshots,
    flow,
    interpreterSemanticsVersion: 1,
  });
  assert(Result.isSuccess(approvalPlanChecksum));
  const approvalBindingFingerprint = await computeApprovalBindingFingerprint({
    actionFingerprint: actionFingerprint.value,
    evaluationSnapshotChecksum: evaluationSnapshotChecksum.value,
    approvalPlanChecksum: approvalPlanChecksum.value,
  });
  assert(Result.isSuccess(approvalBindingFingerprint));
  return {
    schemaVersion: 1,
    actionRequestId: name as ActionRequestId,
    organizationId,
    action,
    evaluationSnapshot,
    policyBindingSnapshots,
    flow,
    interpreterSemanticsVersion: 1,
    actionFingerprint: actionFingerprint.value,
    evaluationSnapshotChecksum: evaluationSnapshotChecksum.value,
    approvalPlanChecksum: approvalPlanChecksum.value,
    approvalBindingFingerprint: approvalBindingFingerprint.value,
  };
}

/** step.doをその場で実行し、waitForEventは呼ばれない前提のfake（承認不要のplanだけを流す）。 */
function fakeStep(): WorkflowStep & { names: string[] } {
  const names: string[] = [];
  const step = {
    names,
    do: async (name: string, ...args: unknown[]) => {
      names.push(name);
      const callback = args.at(-1) as () => Promise<unknown>;
      return callback();
    },
    waitForEvent: async () => Promise.reject(new Error("waitForEvent is not expected")),
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
  };
  return step as unknown as WorkflowStep & { names: string[] };
}

/** D1もservice bindingも使わないin-memoryの依存（#106）。 */
function inMemoryDependencies(
  plan: MaterializedApprovalPlan | null,
  overrides: Partial<ActionWorkflowDependencies> = {},
) {
  const events: ActionEventRecord[] = [];
  const results: ActionResultRecord[] = [];
  const telemetry: TelemetryRecord[] = [];
  const executed: ActionExecutionRequest[] = [];
  let projection: { state: ApprovalRuntimeState; version: number } | null = null;
  const deps: ActionWorkflowDependencies = {
    plans: {
      loadForWorkflow: async () => (plan ? { type: "found", plan } : { type: "not_found" }),
    },
    projections: {
      compareAndReplace: async (input) => {
        if ((projection?.version ?? null) !== input.expectedVersion) {
          return Result.succeed({ type: "conflict" as const, current: projection });
        }
        projection = { state: input.state, version: (projection?.version ?? 0) + 1 };
        events.push(...(input.events ?? []));
        return Result.succeed({ type: "written" as const, ...projection });
      },
      loadVersioned: async () => Result.succeed(projection),
      load: async () => Result.succeed(projection?.state ?? null),
    },
    events: {
      appendMany: async (records) => {
        events.push(...records);
        return Result.succeed(undefined);
      },
      listForAction: async () => Result.succeed([...events]),
    },
    results: {
      save: async (record, recordEvents) => {
        results.push(record);
        events.push(...recordEvents);
        return Result.succeed(undefined);
      },
    },
    commands: { resolveOutcome: async () => Result.succeed({ updated: true }) },
    approverResolver: () => ({
      check: async () => Result.succeed(true),
      list: async () => Result.succeed({ userIds: [], complete: true }),
    }),
    actionAuthorizer: () => ({
      check: async ({ evaluatedAt, consistency }) =>
        Result.succeed({
          type: "allow" as const,
          evidence: { evaluatedAt, consistency, provider: "in-memory" },
        }),
    }),
    actionExecutor: (_executorKey, guaranteeLevel) => ({
      guaranteeLevel: guaranteeLevel ?? "idempotent",
      describe: async () => Result.succeed({ type: "registered", guaranteeLevel: "idempotent" }),
      execute: async (request) => {
        executed.push(request);
        return Result.succeed({ status: "succeeded" as const, output: { ok: true } });
      },
    }),
    telemetry: { emit: (record) => telemetry.push(record) },
    executionMode: "execute",
    ...overrides,
  } as ActionWorkflowDependencies;
  return { deps, events, results, telemetry, executed };
}

async function workflowEvent(
  params: ActionWorkflowParams,
): Promise<WorkflowEvent<ActionWorkflowParams>> {
  return {
    payload: params,
    timestamp: new Date("2026-09-25T00:00:00.000Z"),
    instanceId: await actionWorkflowInstanceId(params),
    workflowName: "action-workflow",
  };
}

describe("#106 ActionWorkflow dependency injection", () => {
  it("in-memoryの依存だけで承認不要のActionを再認可・実行し、結果を投影する", async () => {
    const plan = await noApprovalPlan("action:di-execute");
    const memory = inMemoryDependencies(plan);
    const step = fakeStep();

    const output = await runActionWorkflow(
      memory.deps,
      await workflowEvent({
        organizationId,
        actionRequestId: plan.actionRequestId,
        approvalPlanChecksum: plan.approvalPlanChecksum,
      }),
      step,
    );

    expect(output).toMatchObject({ type: "completed", status: "executed" });
    expect(memory.executed).toHaveLength(1);
    expect(memory.results.map((result) => result.status)).toEqual(["executed"]);
    expect(memory.events.map((record) => record.event.type)).toContain("action.completed");
    expect(step.names).toEqual(
      expect.arrayContaining(["initialize approval runtime", "execute action"]),
    );
  });

  it("approval_onlyでは注入したexecutorを呼ばずに承認結果で終了する", async () => {
    const plan = await noApprovalPlan("action:di-approval-only");
    const memory = inMemoryDependencies(plan, { executionMode: "approval_only" });

    const output = await runActionWorkflow(
      memory.deps,
      await workflowEvent({
        organizationId,
        actionRequestId: plan.actionRequestId,
        approvalPlanChecksum: plan.approvalPlanChecksum,
      }),
      fakeStep(),
    );

    expect(output).toMatchObject({ type: "completed", status: "approved" });
    expect(memory.executed).toEqual([]);
  });

  it("Planが無ければworkflow.failedを注入したevent repositoryへ残す", async () => {
    const plan = await noApprovalPlan("action:di-missing");
    const memory = inMemoryDependencies(null);

    const output = await runActionWorkflow(
      memory.deps,
      await workflowEvent({
        organizationId,
        actionRequestId: plan.actionRequestId,
        approvalPlanChecksum: plan.approvalPlanChecksum,
      }),
      fakeStep(),
    );

    expect(output).toMatchObject({ type: "failed", code: "approval_plan_not_found" });
    expect(memory.events.map((record) => record.event.type)).toEqual(["workflow.failed"]);
    expect(memory.telemetry.length).toBeGreaterThan(0);
  });
});

describe("cloudflareWorkflowDependencies", () => {
  const env = {
    DB: {} as ActionWorkflowEnv["DB"],
    OPENFGA_API_URL: "https://fga.example",
    OPENFGA_STORE_ID: "store",
    OPENFGA_AUTHORIZATION_MODEL_ID: "model",
    FGA_CLIENT_ID: "client",
    FGA_CLIENT_SECRET: "secret",
  } satisfies ActionWorkflowEnv;

  it("同じenvでは依存を組み立て直さない（isolate内でmemo化する）", () => {
    expect(cloudflareWorkflowDependencies(env)).toBe(cloudflareWorkflowDependencies(env));
    expect(
      cloudflareWorkflowDependencies(env).actionAuthorizer({
        organizationId,
        actionRequestId: "action:x" as ActionRequestId,
      }),
    ).toBeNull();
  });

  it("FGA token providerはclient ID / issuer / audienceが同じ限りenvをまたいで共有する", () => {
    expect(fgaTokenSupplier(env)).toBe(fgaTokenSupplier({ ...env }));
    expect(fgaTokenSupplier(env)).not.toBe(
      fgaTokenSupplier({ ...env, FGA_API_AUDIENCE: "https://api.eu1.fga.dev/" }),
    );
    expect(fgaTokenSupplier({ ...env, FGA_CLIENT_SECRET: undefined })).toBeNull();
  });
});
