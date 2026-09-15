import { Result } from "@praha/byethrow";

import type {
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalTaskId,
  OrganizationId,
  UserId,
} from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
} from "@app/approval-runtime-cloudflare";

import { createPreviewPlan, isPreviewScenario } from "./preview-plan.ts";

export { ActionWorkflow };

type PreviewRuntimeEnv = ActionWorkflowEnv & {
  ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
};

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startRun(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
  const body = await request.json().catch(() => null);
  const scenario =
    body && typeof body === "object" && "scenario" in body ? body.scenario : undefined;
  if (!isPreviewScenario(scenario)) {
    return json({ error: "invalid preview scenario" }, { status: 400 });
  }

  const plan = await createPreviewPlan(scenario);
  const saved = await new D1MaterializedPlanRepository(env.DB).save(plan);
  if (saved.type !== "created" && saved.type !== "existing") {
    return json({ error: `failed to save preview plan: ${saved.type}` }, { status: 500 });
  }

  await env.ACTION_WORKFLOW.create({
    id: String(plan.actionRequestId),
    params: {
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    },
  });

  return json(
    {
      scenario,
      actionRequestId: plan.actionRequestId,
      workflowInstanceId: String(plan.actionRequestId),
    },
    { status: 201 },
  );
}

async function getRun(actionRequestId: ActionRequestId, env: PreviewRuntimeEnv): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT organization_id FROM action_requests WHERE id = ? LIMIT 1",
  )
    .bind(actionRequestId)
    .first<{ organization_id: string }>();
  if (!row) return json({ error: "preview run not found" }, { status: 404 });

  const projection = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: row.organization_id as OrganizationId,
    actionRequestId,
  });
  if (Result.isFailure(projection)) {
    return json({ error: projection.error.message }, { status: 500 });
  }

  const workflow = await env.ACTION_WORKFLOW.get(String(actionRequestId));
  const workflowStatus = await workflow.status();
  return json({
    actionRequestId,
    workflow: workflowStatus,
    runtime: projection.value,
  });
}

async function sendDecision(
  request: Request,
  actionRequestId: ActionRequestId,
  env: PreviewRuntimeEnv,
): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "invalid decision payload" }, { status: 400 });
  }

  const taskId = "taskId" in body ? body.taskId : undefined;
  const userId = "userId" in body ? body.userId : undefined;
  const decision = "decision" in body ? body.decision : undefined;
  if (
    typeof taskId !== "string" ||
    typeof userId !== "string" ||
    (decision !== "approve" && decision !== "reject")
  ) {
    return json({ error: "invalid decision payload" }, { status: 400 });
  }

  const event: ApprovalDecisionEvent = {
    idempotencyKey: crypto.randomUUID(),
    taskId: taskId as ApprovalTaskId,
    userId: userId as UserId,
    decision,
    decidedAt: new Date().toISOString(),
  };
  const workflow = await env.ACTION_WORKFLOW.get(String(actionRequestId));
  await workflow.sendEvent({ type: "approval-decision", payload: event });
  return json({ accepted: true, idempotencyKey: event.idempotencyKey }, { status: 202 });
}

async function route(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/preview/approval-runs") {
    return startRun(request, env);
  }

  const decisionMatch = /^\/preview\/approval-runs\/([^/]+)\/decisions$/.exec(url.pathname);
  if (request.method === "POST" && decisionMatch?.[1]) {
    return sendDecision(request, decodeURIComponent(decisionMatch[1]) as ActionRequestId, env);
  }

  const statusMatch = /^\/preview\/approval-runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    return getRun(decodeURIComponent(statusMatch[1]) as ActionRequestId, env);
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<PreviewRuntimeEnv>;
