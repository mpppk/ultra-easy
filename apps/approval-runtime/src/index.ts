import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import { withHttpAccessLog } from "@app/approval-application";

import {
  ActionExecutorRegistry,
  decodeUriComponent,
  GOVERNANCE_ACTION_DEFINITIONS,
  GOVERNANCE_ACTION_TYPES,
  GovernanceActionExecutor,
  computeActionFingerprint,
  parseBrand,
} from "@app/approval-core";
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionExecutorError,
  ActionRequestId,
  ApprovalDecisionEvent,
  MaterializedApprovalPlan,
  NotificationSink,
} from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1ApprovalRuntimeProjectionRepository,
  D1GovernanceRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  actionWorkflowInstanceId,
  CloudflareWorkflowCancellationControl,
  evaluateRecentOrganizationAlerts,
  handleNotificationQueueBatch,
  loadOperatorDashboardView,
  notificationScheduledTasks,
  readOperatorAlertThresholds,
  retentionScheduledTask,
  runScheduledTasks,
  serveActionExecutorRegistry,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
  telemetrySinkFromEnv,
  fgaAlertMetricsFromEnv,
  type FgaMetricsEnv,
} from "@app/approval-runtime-cloudflare";

import { parseForceCancelBody } from "./preview-force-cancel.ts";
import {
  createPreviewPlan,
  isPreviewScenario,
  PREVIEW_EXECUTOR_KEY,
  PREVIEW_ORGANIZATION_ID,
} from "./preview-plan.ts";

export { ActionWorkflow };

type PreviewRuntimeEnv = ActionWorkflowEnv &
  FgaMetricsEnv & {
    ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
    NOTIFICATION_QUEUE: NotificationQueueProducer;
    OPERATOR_ALERT_OUTBOX_BACKLOG?: string;
    OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES?: string;
    OPERATOR_ALERT_FAILURE_TREND_MINUTES?: string;
    OPERATOR_ALERT_DWELL_P95_SLA_MS?: string;
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

/** Preview専用のsink。外部へは送らず、宛先ごとの配信を記録するだけ。 */
class PreviewNotificationSink implements NotificationSink {
  readonly audience = "recipient" as const;

  async send() {
    return Result.succeed("sent" as const);
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
  const parsedTaskId = parseBrand("ApprovalTaskId", taskId);
  const parsedUserId = parseBrand("UserId", userId);
  if (Result.isFailure(parsedTaskId) || Result.isFailure(parsedUserId)) {
    return json({ error: "invalid decision payload" }, { status: 400 });
  }

  const event: ApprovalDecisionEvent = {
    idempotencyKey: crypto.randomUUID(),
    taskId: parsedTaskId.value,
    userId: parsedUserId.value,
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

  const sourceActionRequestId = parseBrand(
    "ActionRequestId",
    `preview-force-cancel:${String(actionRequestId)}`,
  );
  if (Result.isFailure(sourceActionRequestId)) {
    return json({ error: "invalid preview run id" }, { status: 400 });
  }
  const executor = new GovernanceActionExecutor(
    new D1GovernanceRepository(env.DB),
    new CloudflareWorkflowCancellationControl(
      env.DB,
      env.ACTION_WORKFLOW,
      telemetrySinkFromEnv(env),
    ),
  );
  const executed = await executor.execute({
    organizationId: PREVIEW_ORGANIZATION_ID,
    actionRequestId: sourceActionRequestId.value,
    actionFingerprint: fingerprint.value,
    idempotencyKey: sourceActionRequestId.value,
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
    sourceActionRequestId: sourceActionRequestId.value,
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
      sourceActionRequestId: sourceActionRequestId.value,
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
  const parsed = raw === undefined ? null : parseBrand("OrganizationId", raw);
  if (parsed && Result.isFailure(parsed)) {
    return json({ error: "organizationId must not be empty" }, { status: 400 });
  }
  const organizationId = parsed ? parsed.value : PREVIEW_ORGANIZATION_ID;
  const view = await loadOperatorDashboardView(env.DB, {
    organizationId,
    thresholds: readOperatorAlertThresholds(env),
  });
  if (Result.isFailure(view)) {
    return json({ error: view.error.message, code: view.error.code }, { status: 500 });
  }
  return json(view.value, { status: 200 });
}

/** ActionRequest IDの1 captureをdecode + 検証する。不一致はnull、不正な値は400。 */
function pathParameter(pattern: RegExp, url: URL): ActionRequestId | null | Response {
  const match = pattern.exec(url.pathname);
  if (!match?.[1]) return null;
  const decoded = decodeUriComponent(match[1]);
  const parsed = Result.isFailure(decoded) ? decoded : parseBrand("ActionRequestId", decoded.value);
  return Result.isFailure(parsed)
    ? json({ error: "invalid path parameter", code: "invalid_path_parameter" }, { status: 400 })
    : parsed.value;
}

async function route(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/preview/approval-runs") {
    return startRun(request, env);
  }

  const decisionMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)\/decisions$/, url);
  if (decisionMatch instanceof Response) return decisionMatch;
  if (request.method === "POST" && decisionMatch) {
    return sendDecision(request, decisionMatch, env);
  }

  const forceCancelMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)\/force-cancel$/, url);
  if (forceCancelMatch instanceof Response) return forceCancelMatch;
  if (request.method === "POST" && forceCancelMatch) {
    return forceCancelRun(request, forceCancelMatch, env);
  }

  if (request.method === "GET" && url.pathname === "/operator/dashboard") {
    return getOperatorDashboard(request, env);
  }

  const statusMatch = pathParameter(/^\/preview\/approval-runs\/([^/]+)$/, url);
  if (statusMatch instanceof Response) return statusMatch;
  if (request.method === "GET" && statusMatch) {
    return getRun(statusMatch, env);
  }

  return new Response("Not Found", { status: 404 });
}

/** access log（#110）の対象route。 */
const PREVIEW_RUNTIME_ROUTES = [
  "/preview/approval-runs",
  "/preview/approval-runs/{actionRequestId}",
  "/preview/approval-runs/{actionRequestId}/decisions",
  "/preview/approval-runs/{actionRequestId}/force-cancel",
  "/operator/dashboard",
];

export default {
  async fetch(request: Request, env: PreviewRuntimeEnv): Promise<Response> {
    return withHttpAccessLog(
      async (logged) => {
        try {
          return await route(logged, env);
        } catch (error) {
          return json({ error: errorMessage(error) }, { status: 500 });
        }
      },
      {
        telemetry: telemetrySinkFromEnv(env),
        routes: PREVIEW_RUNTIME_ROUTES,
        defaultOrganizationId: PREVIEW_ORGANIZATION_ID,
      },
    )(request);
  },

  async scheduled(controller, env): Promise<void> {
    const telemetry = telemetrySinkFromEnv(env);
    await runScheduledTasks({
      now: new Date(controller.scheduledTime).toISOString(),
      telemetry,
      tasks: [
        ...notificationScheduledTasks({
          db: env.DB,
          queue: env.NOTIFICATION_QUEUE,
          telemetry,
          sinkConfigured: true,
        }),
        {
          name: "evaluate_operator_alerts",
          run: (now) =>
            evaluateRecentOrganizationAlerts({
              db: env.DB,
              thresholds: readOperatorAlertThresholds(env),
              now,
              telemetry,
              // #109: 滞留検出（Workflow状態の照合）とFGA metric（Analytics Engine）。
              workflow: env.ACTION_WORKFLOW,
              fgaMetrics: fgaAlertMetricsFromEnv(env),
            }),
        },
        retentionScheduledTask(env.DB),
      ],
    });
  },

  async queue(batch, env): Promise<void> {
    await handleNotificationQueueBatch({
      batch,
      db: env.DB,
      sink: new PreviewNotificationSink(),
      telemetry: telemetrySinkFromEnv(env),
      now: () => new Date().toISOString(),
    });
  },
} satisfies ExportedHandler<PreviewRuntimeEnv, NotificationQueueMessage>;
