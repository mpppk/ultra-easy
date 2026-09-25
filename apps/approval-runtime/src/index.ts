import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  ActionExecutorRegistry,
  ConsoleTelemetrySink,
  decodeUriComponent,
  GOVERNANCE_ACTION_DEFINITIONS,
  GOVERNANCE_ACTION_TYPES,
  GovernanceActionExecutor,
  computeActionFingerprint,
} from "@app/approval-core";
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionExecutorError,
  ActionRequestId,
  ApprovalDecisionEvent,
  ApprovalTaskId,
  MaterializedApprovalPlan,
  NotificationSink,
  OrganizationId,
  UserId,
} from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1GovernanceRepository,
  D1MaterializedPlanRepository,
  D1NotificationOutboxRepository,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  actionWorkflowInstanceId,
  CloudflareWorkflowCancellationControl,
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  serveActionExecutorRegistry,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "@app/approval-runtime-cloudflare";

import {
  evaluateRecentOrganizationAlerts,
  loadOperatorDashboardView,
  readOperatorAlertThresholds,
} from "./operator-dashboard.ts";
import { parseForceCancelBody } from "./preview-force-cancel.ts";
import {
  createPreviewPlan,
  isPreviewScenario,
  PREVIEW_EXECUTOR_KEY,
  PREVIEW_ORGANIZATION_ID,
} from "./preview-plan.ts";

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

/** Preview専用のside-effect mock。外部副作用を持たないためidempotent。 */
class PreviewSinkActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    return Result.succeed({
      status: "succeeded",
      output: {
        preview: true,
        executorKey: String(request.action.definition.executorKey),
        idempotencyKey: request.idempotencyKey,
      },
    });
  }
}

/**
 * Preview専用のAction Executor registry。
 * 本番と同じ`serveActionExecutorRegistry` contract（describe + idempotency / correlation検証）を
 * Preview環境でE2E確認できるようにする。
 */
export class PreviewActionExecutor extends WorkerEntrypoint<PreviewRuntimeEnv> {
  override async fetch(request: Request): Promise<Response> {
    return serveActionExecutorRegistry(
      request,
      new ActionExecutorRegistry({ [PREVIEW_EXECUTOR_KEY]: new PreviewSinkActionExecutor() }),
    );
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

/**
 * Preview force-cancel drill。
 * 本番と同じGovernanceActionExecutor + CloudflareWorkflowCancellationControl経路で
 * `admin.force_cancel`を実行し、projection/event/auditの復旧証跡をそのまま返す。
 * Preview専用のためactor/reasonはrequest bodyで受け取る（本番はtransportが供給する）。
 */
async function forceCancelRun(
  request: Request,
  actionRequestId: ActionRequestId,
  env: PreviewRuntimeEnv,
): Promise<Response> {
  const parsed = parseForceCancelBody(await request.json().catch(() => null));
  if (Result.isFailure(parsed)) {
    return json({ error: parsed.error.message, code: parsed.error.code }, { status: 400 });
  }
  const { reason, actor } = parsed.value;

  const plan = await new D1MaterializedPlanRepository(env.DB).load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (plan.type !== "found") return json({ error: "preview run not found" }, { status: 404 });

  const runtimeRepository = new D1ApprovalRuntimeProjectionRepository(env.DB);
  const initialProjection = await runtimeRepository.load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(initialProjection)) {
    return json({ error: initialProjection.error.message }, { status: 500 });
  }
  if (!initialProjection.value) {
    return json({ error: "preview runtime is not projected yet" }, { status: 409 });
  }

  const eventRepository = new D1ActionEventRepository(env.DB);
  const initialEvents = await eventRepository.listForAction({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(initialEvents)) {
    return json({ error: initialEvents.error.message }, { status: 500 });
  }
  const initialLatestEvent = initialEvents.value.at(-1);

  const definition = GOVERNANCE_ACTION_DEFINITIONS.find(
    (candidate) =>
      String(candidate.actionType) === String(GOVERNANCE_ACTION_TYPES.adminForceCancel),
  );
  if (!definition) {
    return json({ error: "governance force-cancel definition is not installed" }, { status: 500 });
  }
  const governanceAction = {
    definition,
    type: GOVERNANCE_ACTION_TYPES.adminForceCancel,
    resource: {
      type: "governance" as MaterializedApprovalPlan["action"]["resource"]["type"],
      id: "governance:force-cancel" as MaterializedApprovalPlan["action"]["resource"]["id"],
    },
    input: {
      targetActionRequestId: String(actionRequestId),
      reason,
    },
  } satisfies MaterializedApprovalPlan["action"];
  const fingerprint = await computeActionFingerprint(governanceAction);
  if (Result.isFailure(fingerprint)) {
    return json({ error: fingerprint.error.message }, { status: 500 });
  }

  const sourceActionRequestId = `preview-force-cancel:${String(actionRequestId)}`;
  const executor = new GovernanceActionExecutor(
    new D1GovernanceRepository(env.DB),
    new CloudflareWorkflowCancellationControl(env.DB, env.ACTION_WORKFLOW),
  );
  const executed = await executor.execute({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId: sourceActionRequestId as ActionRequestId,
    actionFingerprint: fingerprint.value,
    idempotencyKey: sourceActionRequestId,
    action: governanceAction,
    authorizationEvidence: {
      evaluatedAt: new Date().toISOString(),
      consistency: "higher_consistency",
    },
    actor,
  });
  if (Result.isFailure(executed)) {
    const status =
      executed.error.code === "force_cancel_target_not_found"
        ? 404
        : executed.error.code === "force_cancel_target_not_pending" ||
            executed.error.code === "force_cancel_audit_conflict"
          ? 409
          : 500;
    return json({ error: executed.error.code, message: executed.error.message }, { status });
  }

  const finalProjection = await runtimeRepository.load({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(finalProjection)) {
    return json({ error: finalProjection.error.message }, { status: 500 });
  }
  const finalEvents = await eventRepository.listForAction({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId,
  });
  if (Result.isFailure(finalEvents)) {
    return json({ error: finalEvents.error.message }, { status: 500 });
  }
  const audit = await new D1GovernanceRepository(env.DB).loadForceCancelAudit({
    organizationId: PREVIEW_ORGANIZATION_ID,
    sourceActionRequestId,
  });
  if (Result.isFailure(audit)) {
    return json({ error: audit.error.message }, { status: 500 });
  }
  const workflow = await env.ACTION_WORKFLOW.get(
    await actionWorkflowInstanceId({
      organizationId: PREVIEW_ORGANIZATION_ID,
      actionRequestId,
    }),
  );
  const workflowStatus = await workflow.status().catch(() => ({ status: "unknown" as const }));

  return json(
    {
      actionRequestId,
      sourceActionRequestId,
      initialStatus: initialProjection.value.status,
      initialLatestEvent: initialLatestEvent
        ? { type: initialLatestEvent.event.type, occurredAt: initialLatestEvent.occurredAt }
        : null,
      projection: finalProjection.value,
      lastEvent: finalEvents.value.at(-1),
      forceCancelAudit: audit.value,
      workflow: workflowStatus,
      postReviewRequired: true,
    },
    { status: 200 },
  );
}

/** Operator dashboard snapshot。organization filter必須、未指定はpreview組織。 */
async function getOperatorDashboard(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("organizationId")?.trim();
  if (raw !== undefined && raw.length === 0) {
    return json({ error: "organizationId must not be empty" }, { status: 400 });
  }
  const organizationId = (raw ?? PREVIEW_ORGANIZATION_ID) as OrganizationId;
  const view = await loadOperatorDashboardView(env.DB, {
    organizationId,
    thresholds: readOperatorAlertThresholds(env as unknown as Record<string, string | undefined>),
  });
  if (Result.isFailure(view)) {
    return json({ error: view.error.message, code: view.error.code }, { status: 500 });
  }
  return json(view.value, { status: 200 });
}

/** 1つのcaptureをdecodeする。不一致はnull、不正なpercent-encodingは400。 */
function pathParameter(pattern: RegExp, url: URL): string | null | Response {
  const match = pattern.exec(url.pathname);
  if (!match?.[1]) return null;
  const decoded = decodeUriComponent(match[1]);
  return Result.isFailure(decoded)
    ? json({ error: "invalid path parameter", code: "invalid_path_parameter" }, { status: 400 })
    : decoded.value;
}

async function route(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/preview/approval-runs") {
    return startRun(request, env);
  }

  const decisionMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)\/decisions$/, url);
  if (decisionMatch instanceof Response) return decisionMatch;
  if (request.method === "POST" && decisionMatch) {
    return sendDecision(request, decisionMatch as ActionRequestId, env);
  }

  const forceCancelMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)\/force-cancel$/, url);
  if (forceCancelMatch instanceof Response) return forceCancelMatch;
  if (request.method === "POST" && forceCancelMatch) {
    return forceCancelRun(request, forceCancelMatch as ActionRequestId, env);
  }

  if (request.method === "GET" && url.pathname === "/operator/dashboard") {
    return getOperatorDashboard(request, env);
  }

  const statusMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)$/, url);
  if (statusMatch instanceof Response) return statusMatch;
  if (request.method === "GET" && statusMatch) {
    return getRun(statusMatch as ActionRequestId, env);
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
    const telemetry = new ConsoleTelemetrySink();
    const now = new Date(controller.scheduledTime).toISOString();
    const dispatched = await dispatchNotificationOutbox({
      repository: new D1NotificationOutboxRepository(env.DB),
      queue: env.NOTIFICATION_QUEUE,
      now,
      telemetry,
    });
    if (Result.isFailure(dispatched)) {
      console.error("notification outbox dispatch failed", {
        code: dispatched.error.code,
      });
    }
    const evaluated = await evaluateRecentOrganizationAlerts({
      db: env.DB,
      thresholds: readOperatorAlertThresholds(env as unknown as Record<string, string | undefined>),
      now,
      telemetry,
    });
    if (Result.isFailure(evaluated)) {
      console.error("operator alert evaluation failed", {
        code: evaluated.error.code,
      });
    }
  },

  async queue(batch, env): Promise<void> {
    const repository = new D1NotificationOutboxRepository(env.DB);
    const sink = new PreviewNotificationSink();
    const telemetry = new ConsoleTelemetrySink();
    for (const message of batch.messages) {
      const consumed = await consumeNotificationMessage({
        repository,
        sink,
        message: message.body,
        now: new Date().toISOString(),
        telemetry,
      });
      if (Result.isFailure(consumed)) {
        message.retry();
      } else {
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<PreviewRuntimeEnv, NotificationQueueMessage>;
