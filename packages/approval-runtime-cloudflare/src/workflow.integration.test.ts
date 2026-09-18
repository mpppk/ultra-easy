import { Result } from "@praha/byethrow";
import { assert, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";

import {
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  computeApprovalPlanChecksum,
  computeEvaluationSnapshotChecksum,
  createMaterializedStepId,
} from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalStepKey,
  ApprovalTaskId,
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  MaterializedStepSource,
  OrganizationId,
  SchemaKey,
  Sha256Digest,
  UserId,
} from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";

import type { ActionWorkflowParams } from "./workflow.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const organizationId = "organization:workflow-test" as OrganizationId;
const bindingId = "binding:workflow-test" as ApprovalPolicyBindingId;
const policyKey = "policy:workflow-test" as ApprovalPolicyKey;
const alice = "user:alice" as UserId;
const bob = "user:bob" as UserId;
const carol = "user:carol" as UserId;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM approval_tasks"),
    testEnv.DB.prepare("DELETE FROM approval_runtime_projections"),
    testEnv.DB.prepare("DELETE FROM approval_task_candidate_projections"),
    testEnv.DB.prepare("DELETE FROM action_requests"),
  ]);
});

function source(path: string): MaterializedStepSource {
  return { policyBindingId: bindingId, policyKey, policyVersion: 1, flowPath: path };
}

async function directStep(
  key: string,
  userId: UserId,
  path: string,
  options: Partial<Pick<MaterializedApprovalStep, "expiresAfter">> = {},
): Promise<MaterializedApprovalStep> {
  const stepSource = source(path);
  const materializedStepId = await createMaterializedStepId(stepSource);
  assert(Result.isSuccess(materializedStepId));
  return {
    type: "approval",
    materializedStepId: materializedStepId.value,
    stepKey: key as ApprovalStepKey,
    source: stepSource,
    target: { type: "user", userId, sourceKind: "user" },
    resolution: "snapshot",
    candidateCompletion: "any",
    ...options,
  };
}

async function validPlan(
  name: string,
  flow: MaterializedFlow,
  input: Record<string, unknown> = {},
): Promise<MaterializedApprovalPlan> {
  const actionRequestId = name as ActionRequestId;
  const action: MaterializedApprovalPlan["action"] = {
    definition: {
      key: "action:workflow" as MaterializedApprovalPlan["action"]["definition"]["key"],
      version: 1,
      actionType: "workflow" as MaterializedApprovalPlan["action"]["definition"]["actionType"],
      inputSchema: { key: "schema:workflow" as SchemaKey, version: 1 },
      executorKey:
        "executor:workflow" as MaterializedApprovalPlan["action"]["definition"]["executorKey"],
    },
    type: "workflow" as MaterializedApprovalPlan["action"]["type"],
    resource: {
      type: "document" as MaterializedApprovalPlan["action"]["resource"]["type"],
      id: `document:${name}` as MaterializedApprovalPlan["action"]["resource"]["id"],
    },
    input: input as MaterializedApprovalPlan["action"]["input"],
  };
  const evaluationSnapshot: MaterializedApprovalPlan["evaluationSnapshot"] = {
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "api" },
    organization: { id: organizationId },
    evaluatedAt: "2026-09-13T00:00:00.000Z",
  };
  const policyBindingSnapshots: MaterializedApprovalPlan["policyBindingSnapshots"] = [
    {
      bindingId,
      policyKey,
      policyVersion: 1,
      policyDefinitionChecksum: `sha256:${"1".repeat(64)}` as Sha256Digest,
      selector: { actionTypes: [action.type] },
      enabled: true,
      outcome: { type: "matched", ruleKey: "rule:workflow" as never, flowType: flow.type },
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
    actionRequestId,
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

async function savePlan(plan: MaterializedApprovalPlan): Promise<void> {
  const saved = await new D1MaterializedPlanRepository(testEnv.DB).save(plan);
  expect(saved.type === "created" || saved.type === "existing").toBe(true);
}

function taskId(plan: MaterializedApprovalPlan, step: MaterializedApprovalStep): ApprovalTaskId {
  return `task:${String(plan.actionRequestId)}:${String(step.materializedStepId)}` as ApprovalTaskId;
}

function decision(
  plan: MaterializedApprovalPlan,
  step: MaterializedApprovalStep,
  userId: UserId,
  key: string,
  value: "approve" | "reject" = "approve",
) {
  return {
    idempotencyKey: key,
    taskId: taskId(plan, step),
    userId,
    decision: value,
    decidedAt: new Date().toISOString(),
  };
}

async function createInstance(plan: MaterializedApprovalPlan, id: string) {
  return testEnv.ACTION_WORKFLOW.create({
    id,
    params: {
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    },
  });
}

async function expectCompleted(instanceId: string, status: string) {
  const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, instanceId);
  await introspector.waitForStatus("complete");
  expect(await introspector.getOutput()).toMatchObject({ type: "completed", status });
  await introspector.dispose();
}

describe("ActionWorkflow / Cloudflare Workflows integration", () => {
  it("serial human waitをevent buffering込みで完走する", async () => {
    const manager = await directStep("manager", alice, "root.children[0]");
    const finance = await directStep("finance", bob, "root.children[1]");
    const plan = await validPlan("cf-serial", {
      type: "serial",
      children: [manager, finance],
    });
    await savePlan(plan);

    const id = "cf-serial";
    const instance = await createInstance(plan, id);
    await instance.sendEvent({
      type: "approval-decision",
      payload: decision(plan, manager, alice, "manager-approved"),
    });
    await instance.sendEvent({
      type: "approval-decision",
      payload: decision(plan, finance, bob, "finance-approved"),
    });

    await expectCompleted(id, "executed");
    const projection = await new D1ApprovalRuntimeProjectionRepository(testEnv.DB).load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(projection));
    expect(projection.value?.tasks).toHaveLength(2);
    expect(projection.value?.tasks.every((task) => task.status === "approved")).toBe(true);
  });

  it("parallel/allとparallel/quorumをhuman Decision eventで完走する", async () => {
    for (const scenario of ["all", "quorum"] as const) {
      const first = await directStep("first", alice, "root.children[0]");
      const second = await directStep("second", bob, "root.children[1]");
      const third = await directStep("third", carol, "root.children[2]");
      const flow: MaterializedFlow =
        scenario === "all"
          ? { type: "parallel", strategy: "all", children: [first, second] }
          : { type: "parallel", strategy: "quorum", quorum: 2, children: [first, second, third] };
      const plan = await validPlan(`cf-${scenario}`, flow);
      await savePlan(plan);
      const instance = await createInstance(plan, `cf-${scenario}`);
      await instance.sendEvent({
        type: "approval-decision",
        payload: decision(plan, first, alice, `${scenario}-first`),
      });
      await instance.sendEvent({
        type: "approval-decision",
        payload: decision(plan, second, bob, `${scenario}-second`),
      });
      await expectCompleted(`cf-${scenario}`, "executed");
    }
  });

  it("instance pause/resume後もDecision待機から再開できる", async () => {
    const approval = await directStep("resume", bob, "root");
    const plan = await validPlan("cf-resume", approval);
    await savePlan(plan);

    const id = "cf-resume";
    await createInstance(plan, id);

    const runtimeRepository = new D1ApprovalRuntimeProjectionRepository(testEnv.DB);
    await vi.waitFor(
      async () => {
        const projection = await runtimeRepository.load({
          organizationId,
          actionRequestId: plan.actionRequestId,
        });
        assert(Result.isSuccess(projection));
        expect(projection.value?.status).toBe("pending");
        expect(projection.value?.tasks).toHaveLength(1);
      },
      { timeout: 1_500 },
    );

    const pausingInstance = await testEnv.ACTION_WORKFLOW.get(id);
    await pausingInstance.pause();
    await vi.waitFor(
      async () => {
        expect((await pausingInstance.status()).status).toBe("paused");
      },
      { timeout: 1_500 },
    );

    const resumingInstance = await testEnv.ACTION_WORKFLOW.get(id);
    await resumingInstance.resume();
    await vi.waitFor(
      async () => {
        expect((await resumingInstance.status()).status).toBe("running");
      },
      { timeout: 1_500 },
    );
    const eventInstance = await testEnv.ACTION_WORKFLOW.get(id);
    await eventInstance.sendEvent({
      type: "approval-decision",
      payload: decision(plan, approval, bob, "after-resume"),
    });

    const completedInstance = await testEnv.ACTION_WORKFLOW.get(id);
    await vi.waitFor(
      async () => {
        const status = await completedInstance.status();
        expect(status.status).toBe("complete");
        expect(status.output).toMatchObject({ type: "completed", status: "executed" });
      },
      { timeout: 5_000 },
    );
  });

  it("step.do retryでもTaskを二重生成しない", async () => {
    const approval = await directStep("retry", bob, "root");
    const plan = await validPlan("cf-retry", approval);
    await savePlan(plan);

    const id = "cf-retry";
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await introspector.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "initialize approval runtime" },
        new Error("transient initialization failure"),
        1,
      );
    });
    const instance = await createInstance(plan, id);
    const runtimeRepository = new D1ApprovalRuntimeProjectionRepository(testEnv.DB);
    await vi.waitFor(
      async () => {
        const projection = await runtimeRepository.load({
          organizationId,
          actionRequestId: plan.actionRequestId,
        });
        assert(Result.isSuccess(projection));
        expect(projection.value?.status).toBe("pending");
        expect(projection.value?.tasks).toHaveLength(1);
      },
      { timeout: 1_500 },
    );

    await instance.sendEvent({
      type: "approval-decision",
      payload: decision(plan, approval, bob, "retry-decision"),
    });
    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({ type: "completed", status: "executed" });

    const projection = await runtimeRepository.load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(projection));
    expect(projection.value?.tasks).toHaveLength(1);
    expect(projection.value?.tasks[0]?.decisions).toHaveLength(1);
    await introspector.dispose();
  });

  it("Workflow paramsのchecksum不一致をPlan load時にfail closedする", async () => {
    const plan = await validPlan("cf-checksum", { type: "none" });
    await savePlan(plan);

    const id = "cf-checksum";
    await testEnv.ACTION_WORKFLOW.create({
      id,
      params: {
        actionRequestId: plan.actionRequestId,
        approvalPlanChecksum: `sha256:${"f".repeat(64)}` as ApprovalPlanChecksum,
      },
    });
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({
      type: "failed",
      code: "approval_plan_checksum_mismatch",
    });
    await introspector.dispose();
  });

  it("1MiB近いPlanでもWorkflow params/step resultへPlan本体を載せない", async () => {
    const plan = await validPlan("cf-payload", { type: "none" }, { blob: "x".repeat(900_000) });
    await savePlan(plan);
    const params: ActionWorkflowParams = {
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    };
    expect(new TextEncoder().encode(JSON.stringify(params)).byteLength).toBeLessThan(1024);

    const id = "cf-payload";
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await testEnv.ACTION_WORKFLOW.create({ id, params });
    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({ type: "completed", status: "executed" });
    const initialized = await introspector.waitForStepResult({
      name: "initialize approval runtime",
    });
    expect(new TextEncoder().encode(JSON.stringify(initialized)).byteLength).toBeLessThan(
      1024 * 1024,
    );
    await introspector.dispose();
  });

  it("AC-M5-005: retriable Executor failureをstep.doでretryし同じidempotency keyで成功する", async () => {
    const plan = await validPlan(
      "cf-execution-retry",
      { type: "none" },
      { executorScenario: "retry-once" },
    );
    await savePlan(plan);

    const id = "cf-execution-retry";
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await introspector.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await createInstance(plan, id);

    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({
      type: "completed",
      status: "executed",
    });
    await introspector.dispose();
  });

  it("AC-M5-006: non-retriable Executor failureをretryせずexecution_failedでterminal化する", async () => {
    const plan = await validPlan(
      "cf-execution-terminal",
      { type: "none" },
      { executorScenario: "non-retriable" },
    );
    await savePlan(plan);

    const id = "cf-execution-terminal";
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await introspector.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await createInstance(plan, id);

    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({
      type: "completed",
      status: "execution_failed",
      code: "business_validation_failed",
    });
    await introspector.dispose();
  });

});
