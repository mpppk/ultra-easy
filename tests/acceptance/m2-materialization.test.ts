import { describe, expect, it } from "vite-plus/test";

import {
  always,
  approve,
  authorityPrincipal,
  createSnapshotApproverCohort,
  definePolicy,
  materializeApprovalPlan,
  principal,
  rule,
} from "@app/approval-core";
import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionRequestId,
  ApprovalPolicyBinding,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ExecutorKey,
  OrganizationId,
  PolicyEvaluationContext,
  ResourceId,
  SchemaKey,
  UserId,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";
import { createTicketActionRequest, fixtureIds } from "@app/approval-core/testing";

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:test");
const actionRequestId = branded<ActionRequestId>("action-request:m2");

function context(input: {
  threshold?: number;
  priority?: string;
  resourceId?: string;
  authorityUserId?: UserId;
} = {}): PolicyEvaluationContext {
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

function actionDefinition(contextValue: PolicyEvaluationContext): ActionDefinition {
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
  bindingId: string;
  policyKey: string;
  policyVersion: number;
  stepKey: string;
  snapshot?: boolean;
}): VersionedApprovalPolicyBinding {
  const policyKey = branded<ApprovalPolicyKey>(input.policyKey);
  const request = createTicketActionRequest();
  const binding: ApprovalPolicyBinding = {
    id: branded<ApprovalPolicyBindingId>(input.bindingId),
    organizationId,
    policyKey,
    selector: { actionTypes: [request.action.type] },
    enabled: true,
  };
  return {
    binding,
    policyVersion: input.policyVersion,
    policy: definePolicy({
      key: input.policyKey,
      name: input.policyKey,
      rules: [
        rule("default", {
          when: always(),
          flow: approve({
            key: input.stepKey,
            approver: principal(authorityPrincipal()),
            ...(input.snapshot
              ? {
                  resolution: "snapshot" as const,
                  candidateCompletion: { type: "quorum" as const, count: 2 },
                }
              : {}),
          }),
        }),
      ],
    }),
  };
}

async function materialize(input: {
  context?: PolicyEvaluationContext;
  sources?: VersionedApprovalPolicyBinding[];
} = {}) {
  const contextValue = input.context ?? context();
  const result = await materializeApprovalPlan({
    actionRequestId,
    context: contextValue,
    actionDefinition: actionDefinition(contextValue),
    policyBindings:
      input.sources ??
      [
        policySource({
          bindingId: "binding:ticket",
          policyKey: "policy:ticket",
          policyVersion: 1,
          stepKey: "manager",
        }),
      ],
  });
  if (result.type !== "materialized") throw new Error(result.message);
  return result.plan;
}

describe("M2 Materialization", () => {
  it("AC-M2-001: Policy-local step keyが同じでもMaterializedStepIdは衝突せず再生成時は安定する", async () => {
    const sources = [
      policySource({
        bindingId: "binding:a",
        policyKey: "policy:a",
        policyVersion: 1,
        stepKey: "manager",
      }),
      policySource({
        bindingId: "binding:b",
        policyKey: "policy:b",
        policyVersion: 1,
        stepKey: "manager",
      }),
    ];
    const first = await materialize({ sources });
    const second = await materialize({ sources });

    expect(first.flow.type).toBe("serial");
    expect(second.flow.type).toBe("serial");
    if (first.flow.type !== "serial" || second.flow.type !== "serial") return;
    const firstSteps = first.flow.children.filter((child) => child.type === "approval");
    const secondSteps = second.flow.children.filter((child) => child.type === "approval");
    expect(firstSteps).toHaveLength(2);
    expect(firstSteps[0]?.type).toBe("approval");
    expect(firstSteps[1]?.type).toBe("approval");
    if (firstSteps[0]?.type !== "approval" || firstSteps[1]?.type !== "approval") return;
    expect(firstSteps[0].stepKey).toBe(firstSteps[1].stepKey);
    expect(firstSteps[0].materializedStepId).not.toBe(firstSteps[1].materializedStepId);
    expect(secondSteps.map((step) => (step.type === "approval" ? step.materializedStepId : null))).toEqual(
      firstSteps.map((step) => (step.type === "approval" ? step.materializedStepId : null)),
    );
  });

  it("AC-M2-002: Action identityとevaluation environmentを別checksumで追跡する", async () => {
    const first = await materialize({ context: context({ threshold: 10 }) });
    const second = await materialize({ context: context({ threshold: 20 }) });

    expect(first.actionFingerprint).toBe(second.actionFingerprint);
    expect(first.evaluationSnapshotChecksum).not.toBe(second.evaluationSnapshotChecksum);
  });

  it("AC-M2-003: resource/input/authorityの変更で以前のapproval bindingを再利用できない", async () => {
    const base = await materialize();
    const resourceChanged = await materialize({ context: context({ resourceId: "TICKET-999" }) });
    const inputChanged = await materialize({ context: context({ priority: "normal" }) });
    const authorityChanged = await materialize({
      context: context({ authorityUserId: branded<UserId>("user:bob") }),
    });

    expect(resourceChanged.approvalBindingFingerprint).not.toBe(base.approvalBindingFingerprint);
    expect(inputChanged.approvalBindingFingerprint).not.toBe(base.approvalBindingFingerprint);
    expect(authorityChanged.approvalBindingFingerprint).not.toBe(base.approvalBindingFingerprint);
  });

  it("AC-M2-004: Policy v2をpublishしても既存のv1 Materialized Planは変化しない", async () => {
    const v1Source = policySource({
      bindingId: "binding:ticket",
      policyKey: "policy:ticket",
      policyVersion: 1,
      stepKey: "manager",
    });
    const v1 = await materialize({ sources: [v1Source] });
    const originalChecksum = v1.approvalPlanChecksum;

    v1Source.policy.rules[0]!.flow = approve({
      key: "mutated-after-materialization",
      approver: principal(authorityPrincipal()),
    });
    const v2 = await materialize({
      sources: [
        policySource({
          bindingId: "binding:ticket",
          policyKey: "policy:ticket",
          policyVersion: 2,
          stepKey: "security",
        }),
      ],
    });

    expect(v1.approvalPlanChecksum).toBe(originalChecksum);
    expect(v1.policyBindingSnapshots[0]?.policyVersion).toBe(1);
    expect(v1.flow.type).toBe("approval");
    if (v1.flow.type === "approval") expect(String(v1.flow.stepKey)).toBe("manager");
    expect(v2.policyBindingSnapshots[0]?.policyVersion).toBe(2);
    expect(v2.approvalPlanChecksum).not.toBe(v1.approvalPlanChecksum);
  });

  it("AC-M2-007: snapshot cohortはactivation時の完全candidate集合を固定する", async () => {
    const plan = await materialize({
      sources: [
        policySource({
          bindingId: "binding:ticket",
          policyKey: "policy:ticket",
          policyVersion: 1,
          stepKey: "manager",
          snapshot: true,
        }),
      ],
    });
    if (plan.flow.type !== "approval") throw new Error("approval flowが必要です");

    const currentCandidates = [fixtureIds.alice, branded<UserId>("user:bob")];
    const cohort = await createSnapshotApproverCohort({
      step: plan.flow,
      candidateUserIds: currentCandidates,
      complete: true,
      resolvedAt: "2026-09-11T00:01:00.000Z",
      sourceRevision: "organization:1",
    });
    if (cohort.type !== "materialized") throw new Error(cohort.message);

    currentCandidates.splice(0, currentCandidates.length, branded<UserId>("user:charlie"));
    expect(cohort.cohort.candidateUserIds.map(String)).toEqual(["user:alice", "user:bob"]);
  });
});
