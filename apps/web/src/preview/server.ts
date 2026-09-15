import { env } from "cloudflare:workers";
import { Result } from "@praha/byethrow";
import type { D1Database } from "@cloudflare/workers-types";

import type {
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalPlanChecksum,
  ApprovalTaskId,
  UserId,
} from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";

import { createPreviewPlan, type PreviewScenario } from "./approval-runtime.ts";

type WorkflowParams = {
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

type PreviewEnv = {
  DB: D1Database;
  ACTION_WORKFLOW: Workflow<WorkflowParams>;
  PREVIEW_HARNESS_ENABLED?: string;
};

function previewEnv(): PreviewEnv {
  return env as unknown as PreviewEnv;
}

export function previewNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

export function isPreviewHarnessEnabled(): boolean {
  return previewEnv().PREVIEW_HARNESS_ENABLED === "true";
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function startPreviewRun(scenario: PreviewScenario) {
  const bindings = previewEnv();
  const plan = await createPreviewPlan(scenario);
  const saved = await new D1MaterializedPlanRepository(bindings.DB).save(plan);
  if (saved.type !== "created" && saved.type !== "existing") {
    return Promise.reject(new Error(`failed to save preview plan: ${saved.type}`));
  }

  await bindings.ACTION_WORKFLOW.create({
    id: String(plan.actionRequestId),
    params: {
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    },
  });

  return {
    scenario,
    actionRequestId: plan.actionRequestId,
    workflowInstanceId: String(plan.actionRequestId),
  };
}

export async function getPreviewRun(actionRequestId: ActionRequestId) {
  const bindings = previewEnv();
  const workflow = await bindings.ACTION_WORKFLOW.get(String(actionRequestId));
  const workflowStatus = await workflow.status();

  const rows = await bindings.DB.prepare(
    "SELECT organization_id FROM action_requests WHERE id = ? LIMIT 1",
  )
    .bind(actionRequestId)
    .first<{ organization_id: string }>();
  if (!rows) return null;

  const projection = await new D1ApprovalRuntimeProjectionRepository(bindings.DB).load({
    organizationId: rows.organization_id as Parameters<
      D1ApprovalRuntimeProjectionRepository["load"]
    >[0]["organizationId"],
    actionRequestId,
  });
  if (Result.isFailure(projection)) return Promise.reject(projection.error);

  return {
    actionRequestId,
    workflow: workflowStatus,
    runtime: projection.value,
  };
}

export async function sendPreviewDecision(input: {
  actionRequestId: ActionRequestId;
  taskId: ApprovalTaskId;
  userId: UserId;
  decision: "approve" | "reject";
}) {
  const bindings = previewEnv();
  const workflow = await bindings.ACTION_WORKFLOW.get(String(input.actionRequestId));
  const event: ApprovalDecisionEvent = {
    idempotencyKey: crypto.randomUUID(),
    taskId: input.taskId,
    userId: input.userId,
    decision: input.decision,
    decidedAt: new Date().toISOString(),
  };
  await workflow.sendEvent({ type: "approval-decision", payload: event });
  return { accepted: true, idempotencyKey: event.idempotencyKey };
}
