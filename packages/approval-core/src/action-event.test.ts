import { describe, expect, it } from "vite-plus/test";

import { actionRuntimeTransitionEvents } from "./action-event.ts";
import type {
  ActionDefinitionKey,
  ActionFingerprint,
  ActionRequestId,
  ActionType,
  ApprovalBindingFingerprint,
  ApprovalPlanChecksum,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalRuntimeState,
  ApprovalStepKey,
  ApprovalTaskId,
  EvaluationSnapshotChecksum,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedStepId,
  OrganizationId,
  ResourceId,
  ResourceType,
  SchemaKey,
  UserId,
} from "./index.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:audit");
const actionRequestId = branded<ActionRequestId>("action:audit");
const approvalPlanChecksum = branded<ApprovalPlanChecksum>("sha256:plan");
const materializedStepId = branded<MaterializedStepId>("step:manager");
const stepKey = branded<ApprovalStepKey>("manager");
const taskId = branded<ApprovalTaskId>("task:manager");
const user1 = branded<UserId>("user:1");
const user2 = branded<UserId>("user:2");
const approvalBindingFingerprint = branded<ApprovalBindingFingerprint>("sha256:binding");

const plan: MaterializedApprovalPlan = {
  schemaVersion: 1,
  actionRequestId,
  organizationId,
  action: {
    definition: {
      key: branded<ActionDefinitionKey>("ticket.update"),
      version: 1,
      actionType: branded<ActionType>("ticket.update"),
      inputSchema: {
        key: branded<SchemaKey>("ticket.update.input"),
        version: 1,
      },
      executorKey: branded<ExecutorKey>("ticket"),
    },
    type: branded<ActionType>("ticket.update"),
    resource: {
      type: branded<ResourceType>("ticket"),
      id: branded<ResourceId>("ticket:1"),
    },
    input: {},
  },
  evaluationSnapshot: {
    actor: { type: "user", id: user1 },
    authority: { principal: { type: "user", id: user1 } },
    origin: { type: "api" },
    organization: { id: organizationId },
    evaluatedAt: "2026-09-20T00:00:00.000Z",
  },
  policyBindingSnapshots: [],
  flow: {
    type: "approval",
    materializedStepId,
    stepKey,
    source: {
      policyBindingId: branded<ApprovalPolicyBindingId>("binding:manager"),
      policyKey: branded<ApprovalPolicyKey>("policy:manager"),
      policyVersion: 1,
      flowPath: "$",
    },
    target: { type: "user", userId: user1, sourceKind: "user" },
  },
  interpreterSemanticsVersion: 1,
  actionFingerprint: branded<ActionFingerprint>("sha256:action"),
  evaluationSnapshotChecksum: branded<EvaluationSnapshotChecksum>("sha256:evaluation"),
  approvalPlanChecksum,
  approvalBindingFingerprint,
};

function decision(input: {
  key: string;
  userId: UserId;
  decision: "approve" | "reject";
  decidedAt: string;
  comment?: string;
}) {
  return {
    idempotencyKey: input.key,
    taskId,
    userId: input.userId,
    decision: input.decision,
    decidedAt: input.decidedAt,
    approvalBindingFingerprint,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

function state(input: {
  decisions: ReturnType<typeof decision>[];
  status?: ApprovalRuntimeState["status"];
  taskStatus?: ApprovalRuntimeState["tasks"][number]["status"];
}): ApprovalRuntimeState {
  return {
    schemaVersion: 1,
    actionRequestId,
    approvalPlanChecksum,
    interpreterSemanticsVersion: 1,
    status: input.status ?? "pending",
    startedAt: "2026-09-20T00:00:00.000Z",
    ...(input.status && input.status !== "pending"
      ? { completedAt: input.decisions.at(-1)?.decidedAt ?? "2026-09-20T00:00:00.000Z" }
      : {}),
    tasks: [
      {
        id: taskId,
        materializedStepId,
        status: input.taskStatus ?? "pending",
        target: { type: "user", userId: user1, sourceKind: "user" },
        candidateUserIds: [user1, user2],
        decisions: input.decisions,
        activatedAt: "2026-09-20T00:00:00.000Z",
        usedFallback: false,
      },
    ],
    processedDecisionKeys: input.decisions.map((item) => item.idempotencyKey),
  };
}

describe("actionRuntimeTransitionEvents", () => {
  it("pendingのquorum/all stepでも適用済みDecisionをappend-only eventへ変換する", () => {
    const firstDecision = decision({
      key: "decision:1",
      userId: user1,
      decision: "approve",
      decidedAt: "2026-09-20T00:01:00.000Z",
      comment: "looks good",
    });

    const events = actionRuntimeTransitionEvents({
      plan,
      previousState: state({ decisions: [] }),
      nextState: state({ decisions: [firstDecision] }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.occurredAt).toBe(firstDecision.decidedAt);
    expect(events[0]?.event).toEqual({
      type: "step.approved",
      actionRequestId,
      materializedStepId,
      stepKey,
      decisionKey: "decision:1",
      actorId: user1,
      approvalBindingFingerprint,
      comment: "looks good",
    });
  });

  it("既存Decisionを再発火せず同一stepの後続Decisionへ別eventKeyを割り当てる", () => {
    const firstDecision = decision({
      key: "decision:1",
      userId: user1,
      decision: "approve",
      decidedAt: "2026-09-20T00:01:00.000Z",
    });
    const secondDecision = decision({
      key: "decision:2",
      userId: user2,
      decision: "approve",
      decidedAt: "2026-09-20T00:02:00.000Z",
    });

    const firstEvents = actionRuntimeTransitionEvents({
      plan,
      previousState: state({ decisions: [] }),
      nextState: state({ decisions: [firstDecision] }),
    });
    const secondEvents = actionRuntimeTransitionEvents({
      plan,
      previousState: state({ decisions: [firstDecision] }),
      nextState: state({ decisions: [firstDecision, secondDecision] }),
    });

    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0]?.event).toMatchObject({
      type: "step.approved",
      decisionKey: "decision:2",
      actorId: user2,
    });
    expect(secondEvents[0]?.eventKey).not.toBe(firstEvents[0]?.eventKey);
  });
});
