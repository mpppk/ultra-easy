import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalTaskId,
  NotificationSink,
  UserId,
} from "@app/approval-core";
import {
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
  D1NotificationOutboxRepository,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  actionWorkflowInstanceId,
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "@app/approval-runtime-cloudflare";

import { createPreviewPlan, isPreviewScenario, PREVIEW_ORGANIZATION_ID } from "./preview-plan.ts";

export { ActionWorkflow };

type PreviewRuntimeEnv = ActionWorkflowEnv & {
  ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
  NOTIFICATION_QUEUE: NotificationQueueProducer;
};

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class PreviewNotificationSink implements NotificationSink {
  async send() {
    return Result.succeed(undefined);
  }
}

/**
 * Preview専用のActionAuthorizer。
 * 同一Workerのnamed entrypointへService Bindingすることで、public HTTP endpointを増やさず
 * productionと同じServiceBindingActionAuthorizer contractを通す。
 */
export class PreviewActionAuthorizer extends WorkerEntrypoint<PreviewRuntimeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return json(
        {
          code: "invalid_preview_authorization_request",
          retriable: false,
          detail: "preview authorization request must be a JSON object",
        },
        { status: 400 },
      );
    }

    return json({
      type: "allow",
      evidence: { provider: "preview-action-authorizer" },
    });
  }
}

/**
 * Preview専用のside-effect mock。
 * idempotency keyをheader/bodyの両方から確認し、実際のActionExecutor adapter contractを
 * Preview環境でE2E確認できるようにする。
 */
export class PreviewActionExecutor extends WorkerEntrypoint<PreviewRuntimeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/execute\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match?.[1]) {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const headerIdempotencyKey = request.headers.get("idempotency-key");
    const bodyIdempotencyKey =
      isRecord(body) && typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (
      !headerIdempotencyKey ||
      !bodyIdempotencyKey ||
      headerIdempotencyKey !== bodyIdempotencyKey
    ) {
      return json(
        {
          code: "invalid_idempotency_contract",
          retriable: false,
          detail: "idempotency key must be stable and identical in header/body",
        },
        { status: 409 },
      );
    }

    return json({
      status: "succeeded",
      output: {
        preview: true,
        executorKey: decodeURIComponent(match[1]),
        idempotencyKey: headerIdempotencyKey,
      },
    });
  }
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

  const workflowInstanceId = await actionWorkflowInstanceId(plan);
  await env.ACTION_WORKFLOW.create({
    id: workflowInstanceId,
    params: {
      organizationId: plan.organizationId,
      actionRequestId: plan.actionRequestId,
      approvalPlanChecksum: plan.approvalPlanChecksum,
    },
  });

  return json(
    {
      scenario,
      actionRequestId: plan.actionRequestId,
      workflowInstanceId,
    },
    { status: 201 },
  );
}

async function getRun(actionRequestId: ActionRequestId, env: PreviewRuntimeEnv): Promise<Response> {
  const plan = await new D1MaterializedPlanRepository(env.DB).load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (plan.type !== "found") return json({ error: "preview run not found" }, { status: 404 });

  const runtime = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(runtime)) {
    return json({ error: runtime.error.message }, { status: 500 });
  }

  const actionResult = await new D1ActionResultProjectionRepository(env.DB).load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(actionResult)) {
    return json({ error: actionResult.error.message }, { status: 500 });
  }

  const workflow = await env.ACTION_WORKFLOW.get(
    await actionWorkflowInstanceId({
      organizationId: PREVIEW_ORGANIZATION_ID,
      actionRequestId,
    }),
  );
  const workflowStatus = await workflow.status();
  return json({
    actionRequestId,
    workflow: workflowStatus,
    runtime: runtime.value,
    actionResult: actionResult.value,
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
  const workflow = await env.ACTION_WORKFLOW.get(
    await actionWorkflowInstanceId({
      organizationId: PREVIEW_ORGANIZATION_ID,
      actionRequestId,
    }),
  );
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

  async scheduled(controller, env): Promise<void> {
    const dispatched = await dispatchNotificationOutbox({
      repository: new D1NotificationOutboxRepository(env.DB),
      queue: env.NOTIFICATION_QUEUE,
      now: new Date(controller.scheduledTime).toISOString(),
    });
    if (Result.isFailure(dispatched)) {
      console.error("notification outbox dispatch failed", {
        code: dispatched.error.code,
      });
    }
  },

  async queue(batch, env): Promise<void> {
    const repository = new D1NotificationOutboxRepository(env.DB);
    const sink = new PreviewNotificationSink();
    for (const message of batch.messages) {
      const consumed = await consumeNotificationMessage({
        repository,
        sink,
        message: message.body,
        now: new Date().toISOString(),
      });
      if (Result.isFailure(consumed)) {
        message.retry();
      } else {
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<PreviewRuntimeEnv, NotificationQueueMessage>;
