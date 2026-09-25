import { Result } from "@praha/byethrow";
import { brandLiteral, parseBrand, sha256Digest } from "@app/approval-core";

import {
  computeActionFingerprint,
  computeApprovalBindingFingerprint,
  computeApprovalPlanChecksum,
  computeEvaluationSnapshotChecksum,
  createMaterializedStepId,
} from "@app/approval-core";
import type {
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  MaterializedStepSource,
  UserId,
} from "@app/approval-core";

export const PREVIEW_EXECUTOR_KEY = brandLiteral("ExecutorKey", "executor:preview");

export const previewScenarios = [
  "no-approval",
  "serial-two-users",
  "parallel-all",
  "parallel-quorum",
  "distinct-approvers",
] as const;

export type PreviewScenario = (typeof previewScenarios)[number];

export const PREVIEW_ORGANIZATION_ID = brandLiteral("OrganizationId", "organization:preview");
const bindingId = brandLiteral("ApprovalPolicyBindingId", "binding:preview");
const policyKey = brandLiteral("ApprovalPolicyKey", "policy:preview");
const alice = brandLiteral("UserId", "user:alice");
const bob = brandLiteral("UserId", "user:bob");
const carol = brandLiteral("UserId", "user:carol");

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
    stepKey: await unwrap(parseBrand("ApprovalStepKey", key)),
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
  const actionRequestId = await unwrap(
    parseBrand("ActionRequestId", `preview-${scenario}-${crypto.randomUUID()}`),
  );
  const flow = await flowForScenario(scenario);
  const action: MaterializedApprovalPlan["action"] = {
    definition: {
      key: brandLiteral("ActionDefinitionKey", "action:preview"),
      version: 1,
      actionType: brandLiteral("ActionType", "preview"),
      inputSchema: { key: brandLiteral("SchemaKey", "schema:preview"), version: 1 },
      executorKey: PREVIEW_EXECUTOR_KEY,
    },
    type: brandLiteral("ActionType", "preview"),
    resource: {
      type: brandLiteral("ResourceType", "preview"),
      id: await unwrap(parseBrand("ResourceId", String(actionRequestId))),
    },
    input: { scenario },
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
      policyDefinitionChecksum: sha256Digest("1".repeat(64)),
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
