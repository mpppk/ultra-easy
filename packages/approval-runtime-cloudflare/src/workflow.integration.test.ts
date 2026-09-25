import { Result } from "@praha/byethrow";
import { assert, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";

import {
  GOVERNANCE_ACTION_DEFINITIONS,
  GOVERNANCE_ACTION_TYPES,
  GovernanceActionExecutor,
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  computeApprovalPlanChecksum,
  computeEvaluationSnapshotChecksum,
  createActionExecutionIdempotencyKey,
  createMaterializedStepId,
} from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalBindingFingerprint,
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
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1GovernanceRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";

import { CloudflareWorkflowCancellationControl } from "./workflow-cancellation.ts";
import { actionWorkflowInstanceId, type ActionWorkflowParams } from "./workflow.ts";

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
    testEnv.DB.prepare("DELETE FROM force_cancel_audit"),
    testEnv.DB.prepare("DELETE FROM action_events"),
    testEnv.DB.prepare("DELETE FROM action_results"),
    testEnv.DB.prepare("DELETE FROM approval_tasks"),
    testEnv.DB.prepare("DELETE FROM approval_runtime_projections"),
    testEnv.DB.prepare("DELETE FROM approval_task_candidate_projections"),
    testEnv.DB.prepare("DELETE FROM action_requests"),
    testEnv.DB.prepare("DELETE FROM approval_commands"),
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
  planOrganizationId: OrganizationId = organizationId,
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
    organization: { id: planOrganizationId },
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
    organizationId: planOrganizationId,
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
  approvalBindingFingerprint: ApprovalBindingFingerprint = plan.approvalBindingFingerprint,
) {
  return {
    idempotencyKey: key,
    taskId: taskId(plan, step),
    userId,
    decision: value,
    decidedAt: new Date().toISOString(),
    approvalBindingFingerprint,
  };
}

async function createInstance(plan: MaterializedApprovalPlan, id: string) {
  return testEnv.ACTION_WORKFLOW.create({
    id,
    params: {
      organizationId: plan.organizationId,
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

    const id = await actionWorkflowInstanceId(plan);
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

    const audit = await new D1ActionEventRepository(testEnv.DB).listForAction({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(audit));
    expect(audit.value.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "step.activated",
      "step.approved",
      "step.activated",
      "step.approved",
      "action.reauthorized",
      "action.execution_started",
      "action.completed",
    ]);
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
      const id = await actionWorkflowInstanceId(plan);
      const instance = await createInstance(plan, id);
      await instance.sendEvent({
        type: "approval-decision",
        payload: decision(plan, first, alice, `${scenario}-first`),
      });
      await instance.sendEvent({
        type: "approval-decision",
        payload: decision(plan, second, bob, `${scenario}-second`),
      });
      await expectCompleted(id, "executed");
    }
  });

  it("instance pause/resume後もDecision待機から再開できる", async () => {
    const approval = await directStep("resume", bob, "root");
    const plan = await validPlan("cf-resume", approval);
    await savePlan(plan);

    const id = await actionWorkflowInstanceId(plan);
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

    const id = await actionWorkflowInstanceId(plan);
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

    const audit = await new D1ActionEventRepository(testEnv.DB).listForAction({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(audit));
    expect(audit.value.filter((record) => record.event.type === "workflow.started")).toHaveLength(
      1,
    );
    expect(audit.value.filter((record) => record.event.type === "step.activated")).toHaveLength(1);
    expect(audit.value.filter((record) => record.event.type === "step.approved")).toHaveLength(1);
    await introspector.dispose();
  });

  it("Workflow paramsのchecksum不一致をPlan load時にfail closedする", async () => {
    const plan = await validPlan("cf-checksum", { type: "none" });
    await savePlan(plan);

    const id = await actionWorkflowInstanceId(plan);
    await testEnv.ACTION_WORKFLOW.create({
      id,
      params: {
        organizationId: plan.organizationId,
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
      organizationId: plan.organizationId,
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    };
    expect(new TextEncoder().encode(JSON.stringify(params)).byteLength).toBeLessThan(1024);

    const id = await actionWorkflowInstanceId(plan);
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

    const id = await actionWorkflowInstanceId(plan);
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    await introspector.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await createInstance(plan, id);

    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({
      type: "completed",
      status: "executed",
      guaranteeLevel: "best_effort_at_most_once",
    });
    const actionResult = await new D1ActionResultProjectionRepository(testEnv.DB).load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(actionResult));
    expect(actionResult.value).toMatchObject({
      status: "executed",
      guaranteeLevel: "best_effort_at_most_once",
      idempotencyKey: createActionExecutionIdempotencyKey(
        plan.organizationId,
        plan.actionRequestId,
        plan.actionFingerprint,
      ),
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

    const id = await actionWorkflowInstanceId(plan);
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

  it("AC-M5-007: stale Approval bindingのDecisionは却下して待機を継続し、Executorへ進まない", async () => {
    const approval = await directStep("binding", bob, "root");
    const plan = await validPlan("cf-binding-mismatch", approval);
    await savePlan(plan);

    const id = await actionWorkflowInstanceId(plan);
    const instance = await createInstance(plan, id);
    await instance.sendEvent({
      type: "approval-decision",
      payload: decision(
        plan,
        approval,
        bob,
        "stale-binding",
        "approve",
        `sha256:${"f".repeat(64)}` as ApprovalBindingFingerprint,
      ),
    });

    const events = new D1ActionEventRepository(testEnv.DB);
    await vi.waitFor(
      async () => {
        const audit = await events.listForAction({
          organizationId,
          actionRequestId: plan.actionRequestId,
        });
        assert(Result.isSuccess(audit));
        expect(audit.value.map((record) => record.event)).toContainEqual(
          expect.objectContaining({
            type: "approval_decision.rejected",
            decisionKey: "stale-binding",
            code: "approval_decision_binding_mismatch",
          }),
        );
      },
      { timeout: 3_000 },
    );
    expect((await instance.status()).status).not.toBe("complete");
    const actionResult = await new D1ActionResultProjectionRepository(testEnv.DB).load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(actionResult));
    expect(actionResult.value).toBeNull();
    const projection = await new D1ApprovalRuntimeProjectionRepository(testEnv.DB).load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(projection));
    expect(projection.value?.status).toBe("pending");
    expect(projection.value?.tasks[0]?.decisions).toHaveLength(0);
    await instance.terminate();
  });

  it("#79/#80: 候補外・closed task・comment欠落のDecisionでは停止せず、正規のcomment付きDecisionで完走する", async () => {
    const manager = await directStep("manager", bob, "root.children[0]");
    const finance = {
      ...(await directStep("finance", carol, "root.children[1]")),
      requireCommentOn: ["approve" as const],
    };
    const plan = await validPlan("cf-invalid-decisions", {
      type: "serial",
      children: [manager, finance],
    });
    await savePlan(plan);
    await testEnv.DB.prepare(
      `INSERT INTO approval_commands (
         command_id, organization_id, action_request_id, task_id, command_type, status,
         actor_user_id, comment, created_at
       ) VALUES
         ('not-candidate', ?1, ?2, ?3, 'approve', 'delivered', 'user:alice', NULL, ?4),
         ('finance-approved', ?1, ?2, ?5, 'approve', 'delivered', 'user:carol', 'looks good', ?4)`,
    )
      .bind(
        organizationId,
        plan.actionRequestId,
        taskId(plan, manager),
        "2026-09-13T00:00:00.000Z",
        taskId(plan, finance),
      )
      .run();

    const id = await actionWorkflowInstanceId(plan);
    const introspector = await introspectWorkflowInstance(testEnv.ACTION_WORKFLOW, id);
    const instance = await createInstance(plan, id);
    const send = (payload: ReturnType<typeof decision> & { comment?: string }) =>
      instance.sendEvent({ type: "approval-decision", payload });

    await send(decision(plan, manager, alice, "not-candidate"));
    await send(decision(plan, manager, bob, "manager-approved"));
    await send(decision(plan, manager, bob, "manager-again"));
    await send(decision(plan, finance, carol, "finance-no-comment"));
    await send({ ...decision(plan, finance, carol, "finance-approved"), comment: "looks good" });

    await introspector.waitForStatus("complete");
    expect(await introspector.getOutput()).toMatchObject({ type: "completed", status: "executed" });
    await introspector.dispose();

    const audit = await new D1ActionEventRepository(testEnv.DB).listForAction({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(audit));
    const rejected = audit.value
      .map((record) => record.event)
      .filter((event) => event.type === "approval_decision.rejected")
      .map((event) => [event.decisionKey, event.code]);
    expect(rejected).toEqual([
      ["not-candidate", "approval_candidate_rejected"],
      ["manager-again", "approval_task_closed"],
      ["finance-no-comment", "approval_comment_required"],
    ]);
    expect(audit.value.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "step.approved",
        decisionKey: "finance-approved",
        actorId: carol,
        comment: "looks good",
      }),
    );

    const commands = await testEnv.DB.prepare(
      "SELECT command_id, status, error_json FROM approval_commands WHERE organization_id = ? ORDER BY command_id",
    )
      .bind(organizationId)
      .all<{ command_id: string; status: string; error_json: string | null }>();
    expect(commands.results.map((row) => [row.command_id, row.status])).toEqual([
      ["finance-approved", "applied"],
      ["not-candidate", "rejected"],
    ]);
    expect(
      JSON.parse(commands.results.find((row) => row.command_id === "not-candidate")!.error_json!),
    ).toMatchObject({ code: "approval_candidate_rejected", status: 422 });
  });

  it("AC-M7-001: 同じActionRequestIdでもorganizationごとにPlan/Workflowを分離する", async () => {
    const tenantA = "organization:tenant-a" as OrganizationId;
    const tenantB = "organization:tenant-b" as OrganizationId;
    const planA = await validPlan("cf-cross-tenant", { type: "none" }, {}, tenantA);
    const planB = await validPlan("cf-cross-tenant", { type: "none" }, {}, tenantB);
    await savePlan(planA);
    await savePlan(planB);

    const idA = await actionWorkflowInstanceId(planA);
    const idB = await actionWorkflowInstanceId(planB);
    expect(idA).toMatch(/^ue_[0-9a-f]{64}$/);
    expect(idA.length).toBeLessThanOrEqual(100);
    expect(idA).not.toBe(idB);

    await createInstance(planA, idA);
    await createInstance(planB, idB);
    await expectCompleted(idA, "executed");
    await expectCompleted(idB, "executed");

    const wrongTenantLoad = await new D1MaterializedPlanRepository(testEnv.DB).loadForWorkflow({
      organizationId: "organization:tenant-c" as OrganizationId,
      actionRequestId: planA.actionRequestId,
      expectedApprovalPlanChecksum: planA.approvalPlanChecksum,
    });
    expect(wrongTenantLoad.type).toBe("not_found");
  });

  it("AC-M7-010: stuck requestをforce cancelしprojection/event/auditで復旧証跡を確認できる", async () => {
    const approval = await directStep("operator-review", bob, "root");
    const plan = await validPlan("cf-operational-drill", approval);
    await savePlan(plan);

    const workflowInstanceId = await actionWorkflowInstanceId(plan);
    await createInstance(plan, workflowInstanceId);

    const runtimeRepository = new D1ApprovalRuntimeProjectionRepository(testEnv.DB);
    await vi.waitFor(
      async () => {
        const projection = await runtimeRepository.load({
          organizationId,
          actionRequestId: plan.actionRequestId,
        });
        assert(Result.isSuccess(projection));
        expect(projection.value?.status).toBe("pending");
      },
      { timeout: 1_500 },
    );

    const definition = GOVERNANCE_ACTION_DEFINITIONS.find(
      (candidate) =>
        String(candidate.actionType) === String(GOVERNANCE_ACTION_TYPES.adminForceCancel),
    );
    assert(definition);
    const governanceAction = {
      definition,
      type: GOVERNANCE_ACTION_TYPES.adminForceCancel,
      resource: {
        type: "governance" as MaterializedApprovalPlan["action"]["resource"]["type"],
        id: "governance:force-cancel" as MaterializedApprovalPlan["action"]["resource"]["id"],
      },
      input: {
        targetActionRequestId: String(plan.actionRequestId),
        reason: "stuck workflow recovery drill",
      },
    } satisfies MaterializedApprovalPlan["action"];
    const actionFingerprint = await computeActionFingerprint(governanceAction);
    assert(Result.isSuccess(actionFingerprint));

    const sourceActionRequestId = "cf-force-cancel-command" as ActionRequestId;
    const governanceRepository = new D1GovernanceRepository(testEnv.DB);
    const executor = new GovernanceActionExecutor(
      governanceRepository,
      new CloudflareWorkflowCancellationControl(testEnv.DB, testEnv.ACTION_WORKFLOW),
    );
    const executed = await executor.execute({
      organizationId,
      actionRequestId: sourceActionRequestId,
      actionFingerprint: actionFingerprint.value,
      idempotencyKey: "operational-drill-force-cancel",
      action: governanceAction,
      authorizationEvidence: {
        evaluatedAt: "2026-09-21T00:00:00.000Z",
        consistency: "higher_consistency",
      },
      actor: { type: "user", id: alice },
    });
    assert(Result.isSuccess(executed));
    expect(executed.value).toMatchObject({
      status: "succeeded",
      output: {
        targetActionRequestId: String(plan.actionRequestId),
        postReviewRequired: true,
      },
    });

    const projection = await runtimeRepository.load({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(projection));
    expect(projection.value?.status).toBe("cancelled");

    const audit = await new D1ActionEventRepository(testEnv.DB).listForAction({
      organizationId,
      actionRequestId: plan.actionRequestId,
    });
    assert(Result.isSuccess(audit));
    expect(audit.value.at(-1)?.event).toMatchObject({
      type: "action.completed",
      result: "cancelled",
    });

    const forceCancelAudit = await governanceRepository.loadForceCancelAudit({
      organizationId,
      sourceActionRequestId,
    });
    assert(Result.isSuccess(forceCancelAudit));
    expect(forceCancelAudit.value).toMatchObject({
      targetActionRequestId: String(plan.actionRequestId),
      actor: { type: "user", id: alice },
      reason: "stuck workflow recovery drill",
      occurredAt: "2026-09-21T00:00:00.000Z",
      postReviewRequired: true,
    });
  });
});
