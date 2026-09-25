import { Result } from "@praha/byethrow";

import {
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  computeApprovalPlanChecksum,
  computeEvaluationSnapshotChecksum,
  createMaterializedStepId,
} from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalPolicyBindingId,
  ApprovalPolicyKey,
  ApprovalStepKey,
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  MaterializedStepSource,
  OrganizationId,
  SchemaKey,
  Sha256Digest,
  UserId,
} from "@app/approval-core";

export const PREVIEW_EXECUTOR_KEY = "executor:preview";

export const previewScenarios = [
  "no-approval",
  "serial-two-users",
  "parallel-all",
  "parallel-quorum",
  "distinct-approvers",
] as const;

export type PreviewScenario = (typeof previewScenarios)[number];

export const PREVIEW_ORGANIZATION_ID = "organization:preview" as OrganizationId;
const bindingId = "binding:preview" as ApprovalPolicyBindingId;
const policyKey = "policy:preview" as ApprovalPolicyKey;
const alice = "user:alice" as UserId;
const bob = "user:bob" as UserId;
const carol = "user:carol" as UserId;

async function unwrap<T, E extends Error>(result: Result.Result<T, E>): Promise<T> {
  if (Result.isFailure(result)) return Promise.reject(result.error);
  return result.value;
}

function source(path: string): MaterializedStepSource {
  return { policyBindingId: bindingId, policyKey, policyVersion: 1, flowPath: path };
}

async function directStep(
  key: string,
  userId: UserId,
  path: string,
): Promise<MaterializedApprovalStep> {
  const stepSource = source(path);
  const materializedStepId = await unwrap(await createMaterializedStepId(stepSource));
  return {
    type: "approval",
    materializedStepId,
    stepKey: key as ApprovalStepKey,
    source: stepSource,
    target: { type: "user", userId, sourceKind: "user" },
    resolution: "snapshot",
    candidateCompletion: "any",
  };
}

async function flowForScenario(scenario: PreviewScenario): Promise<MaterializedFlow> {
  if (scenario === "no-approval") return { type: "none" };

  if (scenario === "serial-two-users") {
    return {
      type: "serial",
      children: [
        await directStep("manager", alice, "root.children[0]"),
        await directStep("finance", bob, "root.children[1]"),
      ],
    };
  }

  if (scenario === "parallel-all") {
    return {
      type: "parallel",
      strategy: "all",
      children: [
        await directStep("first", alice, "root.children[0]"),
        await directStep("second", bob, "root.children[1]"),
      ],
    };
  }

  if (scenario === "parallel-quorum") {
    return {
      type: "parallel",
      strategy: "quorum",
      quorum: 2,
      children: [
        await directStep("first", alice, "root.children[0]"),
        await directStep("second", bob, "root.children[1]"),
        await directStep("third", carol, "root.children[2]"),
      ],
    };
  }

  return {
    type: "serial",
    constraints: { distinctApprovers: true },
    children: [
      await directStep("first", alice, "root.children[0]"),
      await directStep("second", bob, "root.children[1]"),
    ],
  };
}

export function isPreviewScenario(value: unknown): value is PreviewScenario {
  return typeof value === "string" && previewScenarios.includes(value as PreviewScenario);
}

export async function createPreviewPlan(
  scenario: PreviewScenario,
): Promise<MaterializedApprovalPlan> {
  const actionRequestId = `preview-${scenario}-${crypto.randomUUID()}` as ActionRequestId;
  const flow = await flowForScenario(scenario);
  const action: MaterializedApprovalPlan["action"] = {
    definition: {
      key: "action:preview" as MaterializedApprovalPlan["action"]["definition"]["key"],
      version: 1,
      actionType: "preview" as MaterializedApprovalPlan["action"]["definition"]["actionType"],
      inputSchema: { key: "schema:preview" as SchemaKey, version: 1 },
      executorKey:
        PREVIEW_EXECUTOR_KEY as MaterializedApprovalPlan["action"]["definition"]["executorKey"],
    },
    type: "preview" as MaterializedApprovalPlan["action"]["type"],
    resource: {
      type: "preview" as MaterializedApprovalPlan["action"]["resource"]["type"],
      id: actionRequestId as unknown as MaterializedApprovalPlan["action"]["resource"]["id"],
    },
    input: { scenario } as MaterializedApprovalPlan["action"]["input"],
  };
  const evaluationSnapshot: MaterializedApprovalPlan["evaluationSnapshot"] = {
    actor: { type: "user", id: alice },
    authority: { principal: { type: "user", id: alice } },
    origin: { type: "api" },
    organization: { id: PREVIEW_ORGANIZATION_ID },
    evaluatedAt: new Date().toISOString(),
  };
  const policyBindingSnapshots: MaterializedApprovalPlan["policyBindingSnapshots"] = [
    {
      bindingId,
      policyKey,
      policyVersion: 1,
      policyDefinitionChecksum: `sha256:${"1".repeat(64)}` as Sha256Digest,
      selector: { actionTypes: [action.type] },
      enabled: true,
      outcome: { type: "matched", ruleKey: "rule:preview" as never, flowType: flow.type },
    },
  ];

  const actionFingerprint = await unwrap(await computeActionFingerprint(action));
  const evaluationSnapshotChecksum = await unwrap(
    await computeEvaluationSnapshotChecksum(evaluationSnapshot),
  );
  const approvalPlanChecksum = await unwrap(
    await computeApprovalPlanChecksum({
      policyBindingSnapshots,
      flow,
      interpreterSemanticsVersion: 1,
    }),
  );
  const approvalBindingFingerprint = await unwrap(
    await computeApprovalBindingFingerprint({
      actionFingerprint,
      evaluationSnapshotChecksum,
      approvalPlanChecksum,
    }),
  );

  return {
    schemaVersion: 1,
    actionRequestId,
    organizationId: PREVIEW_ORGANIZATION_ID,
    action,
    evaluationSnapshot,
    policyBindingSnapshots,
    flow,
    interpreterSemanticsVersion: 1,
    actionFingerprint,
    evaluationSnapshotChecksum,
    approvalPlanChecksum,
    approvalBindingFingerprint,
  };
}
