import { describe, expect, it } from "vite-plus/test";

import type { ActionDefinition } from "./action-definition.ts";
import { always, approve, authorityPrincipal, definePolicy, managerOf, rule } from "./builder.ts";
import type {
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ExecutorKey,
  OrganizationId,
  ResourceId,
  SchemaKey,
  UserId,
} from "./domain/brand.ts";
import type { PolicyEvaluationContext } from "./domain/evaluation.ts";
import type { ApprovalPolicyBinding } from "./domain/policy.ts";
import {
  createMaterializedStepId,
  createSnapshotApproverCohort,
  materializeApprovalPlan,
} from "./materialization.ts";
import { createTicketActionRequest, fixtureIds } from "./testing/fixtures.ts";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:test");
const actionRequestId = branded<ActionRequestId>("action-request:1");

function context(
  input: {
    threshold?: number;
    priority?: string;
    resourceId?: string;
    authorityUserId?: UserId;
  } = {},
): PolicyEvaluationContext {
  const request = createTicketActionRequest();
  return {
    ...request,
    authority: input.authorityUserId
      ? { principal: { type: "user", id: input.authorityUserId } }
      : request.authority,
    action: {
      ...request.action,
      resource: {
        ...request.action.resource,
        ...(input.resourceId ? { id: branded<ResourceId>(input.resourceId) } : {}),
      },
      input: { priority: input.priority ?? "critical" },
    },
    organization: {
      id: organizationId,
      settings: { threshold: input.threshold ?? 10 },
    },
    now: "2026-09-11T00:00:00.000Z",
  };
}

function actionDefinition(contextValue = context()): ActionDefinition {
  return {
    key: branded<ActionDefinitionKey>("ticket-priority-change"),
    version: 1,
    actionType: contextValue.action.type,
    inputSchema: { key: branded<SchemaKey>("ticket-priority-input"), version: 1 },
    executorKey: branded<ExecutorKey>("ticket-priority-executor"),
    normalizationVersion: 1,
  };
}

function policySource(input: {
  bindingId?: string;
  policyKey?: string;
  policyVersion?: number;
  stepKey?: string;
  resolution?: "dynamic" | "snapshot";
  candidateCompletion?: "any" | "all" | { type: "quorum"; count: number };
}) {
  const policyKey = branded<ApprovalPolicyKey>(input.policyKey ?? "policy:ticket");
  const policy = definePolicy({
    key: String(policyKey),
    name: "Ticket Policy",
    rules: [
      rule("default", {
        when: always(),
        flow: approve({
          key: input.stepKey ?? "manager",
          approver: managerOf(authorityPrincipal()),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.candidateCompletion ? { candidateCompletion: input.candidateCompletion } : {}),
        }),
      }),
    ],
  });
  const request = createTicketActionRequest();
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>(input.bindingId ?? "binding:ticket"),
    organizationId,
    policyKey,
    selector: { actionTypes: [request.action.type] },
    enabled: true,
  };
  return { binding, policyVersion: input.policyVersion ?? 1, policy };
}

async function materialize(
  input: {
    context?: PolicyEvaluationContext;
    sources?: ReturnType<typeof policySource>[];
  } = {},
) {
  const contextValue = input.context ?? context();
  const result = await materializeApprovalPlan({
    actionRequestId,
    context: contextValue,
    actionDefinition: actionDefinition(contextValue),
    policyBindings: input.sources ?? [policySource({})],
  });
  expect(result.type).toBe("materialized");
  if (result.type !== "materialized") throw new Error(result.message);
  return result.plan;
}

describe("MaterializedStepId", () => {
  it("同じbinding/version/pathから常に同じIDを生成する", async () => {
    const source = {
      policyBindingId: branded<ApprovalPolicyBindingId>("binding:a"),
      policyKey: branded<ApprovalPolicyKey>("policy:a"),
      policyVersion: 3,
      flowPath: "root.children[0]",
    };

    expect(await createMaterializedStepId(source)).toBe(await createMaterializedStepId(source));
  });

  it("同じstepKeyでもbindingが異なればMaterializedStepIdは衝突しない", async () => {
    const first = await materialize({ sources: [policySource({ bindingId: "binding:a" })] });
    const second = await materialize({ sources: [policySource({ bindingId: "binding:b" })] });

    expect(first.flow.type).toBe("approval");
    expect(second.flow.type).toBe("approval");
    if (first.flow.type !== "approval" || second.flow.type !== "approval") return;
    expect(first.flow.stepKey).toBe(second.flow.stepKey);
    expect(first.flow.materializedStepId).not.toBe(second.flow.materializedStepId);
  });
});

describe("fingerprint separation", () => {
  it("organization settingsだけが変わる場合actionFingerprintは変えない", async () => {
    const first = await materialize({ context: context({ threshold: 10 }) });
    const second = await materialize({ context: context({ threshold: 20 }) });

    expect(first.actionFingerprint).toBe(second.actionFingerprint);
    expect(first.evaluationSnapshotChecksum).not.toBe(second.evaluationSnapshotChecksum);
    expect(first.approvalBindingFingerprint).not.toBe(second.approvalBindingFingerprint);
  });

  it("approval-sensitive inputが変わればactionFingerprintとbinding fingerprintが変わる", async () => {
    const first = await materialize({ context: context({ priority: "critical" }) });
    const second = await materialize({ context: context({ priority: "normal" }) });

    expect(first.actionFingerprint).not.toBe(second.actionFingerprint);
    expect(first.approvalBindingFingerprint).not.toBe(second.approvalBindingFingerprint);
  });

  it("resourceが変わればactionFingerprintとbinding fingerprintが変わる", async () => {
    const first = await materialize({ context: context({ resourceId: "TICKET-1" }) });
    const second = await materialize({ context: context({ resourceId: "TICKET-2" }) });

    expect(first.actionFingerprint).not.toBe(second.actionFingerprint);
    expect(first.approvalBindingFingerprint).not.toBe(second.approvalBindingFingerprint);
  });

  it("authorityだけが変わる場合actionFingerprintは維持しbinding fingerprintを変える", async () => {
    const first = await materialize({ context: context({ authorityUserId: fixtureIds.alice }) });
    const second = await materialize({
      context: context({ authorityUserId: branded<UserId>("user:bob") }),
    });

    expect(first.actionFingerprint).toBe(second.actionFingerprint);
    expect(first.evaluationSnapshotChecksum).not.toBe(second.evaluationSnapshotChecksum);
    expect(first.approvalBindingFingerprint).not.toBe(second.approvalBindingFingerprint);
  });
});

describe("Policy Version snapshot", () => {
  it("既存Planは後からmaterializeしたPolicy Versionの変更を受けない", async () => {
    const v1 = await materialize({
      sources: [policySource({ policyVersion: 1, stepKey: "manager" })],
    });
    const v2 = await materialize({
      sources: [policySource({ policyVersion: 2, stepKey: "security" })],
    });

    expect(v1.policyBindingSnapshots[0]?.policyVersion).toBe(1);
    expect(v2.policyBindingSnapshots[0]?.policyVersion).toBe(2);
    expect(v1.flow.type).toBe("approval");
    expect(v2.flow.type).toBe("approval");
    if (v1.flow.type !== "approval" || v2.flow.type !== "approval") return;
    expect(String(v1.flow.stepKey)).toBe("manager");
    expect(String(v2.flow.stepKey)).toBe("security");
    expect(v1.approvalPlanChecksum).not.toBe(v2.approvalPlanChecksum);
  });
});

describe("snapshot approver cohort", () => {
  it("activation時candidate集合をcopyして固定する", async () => {
    const plan = await materialize({
      sources: [
        policySource({
          resolution: "snapshot",
          candidateCompletion: { type: "quorum", count: 2 },
        }),
      ],
    });
    expect(plan.flow.type).toBe("approval");
    if (plan.flow.type !== "approval") return;

    const candidates = [fixtureIds.alice, branded<UserId>("user:bob")];
    const result = await createSnapshotApproverCohort({
      step: plan.flow,
      candidateUserIds: candidates,
      complete: true,
      resolvedAt: "2026-09-11T00:01:00.000Z",
      sourceRevision: "org-rev:1",
    });
    expect(result.type).toBe("materialized");
    if (result.type !== "materialized") return;

    candidates.push(branded<UserId>("user:charlie"));
    expect(result.cohort.candidateUserIds.map(String)).toEqual(["user:alice", "user:bob"]);
  });

  it("不完全なcandidate集合はsnapshot cohortとして固定しない", async () => {
    const plan = await materialize({
      sources: [policySource({ resolution: "snapshot", candidateCompletion: "all" })],
    });
    if (plan.flow.type !== "approval") throw new Error("approval flowが必要です");

    await expect(
      createSnapshotApproverCohort({
        step: plan.flow,
        candidateUserIds: [fixtureIds.alice],
        complete: false,
        resolvedAt: "2026-09-11T00:01:00.000Z",
      }),
    ).resolves.toMatchObject({ type: "error", code: "incomplete_candidate_set" });
  });

  it("candidate quorumが固定候補数を超える場合は拒否する", async () => {
    const plan = await materialize({
      sources: [
        policySource({
          resolution: "snapshot",
          candidateCompletion: { type: "quorum", count: 2 },
        }),
      ],
    });
    if (plan.flow.type !== "approval") throw new Error("approval flowが必要です");

    await expect(
      createSnapshotApproverCohort({
        step: plan.flow,
        candidateUserIds: [fixtureIds.alice],
        complete: true,
        resolvedAt: "2026-09-11T00:01:00.000Z",
      }),
    ).resolves.toMatchObject({ type: "error", code: "candidate_quorum_unreachable" });
  });
});
