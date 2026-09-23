import { Result } from "@praha/byethrow";

import {
  ActionRequestApplicationService,
  ApprovalDecisionCommandProcessor,
  ApprovalDecisionCommandService,
  createActionRequestHttpApi,
  createPublicHttpApi,
} from "@app/approval-application";
import {
  ConsoleTelemetrySink,
  evaluateOperatorAlerts,
  GovernanceActionExecutor,
  safeLogRecord,
  type ActionRequestId,
  type ExecutorKey,
  type NotificationSink,
  type OrganizationId,
} from "@app/approval-core";
import {
  D1FixedWindowRateLimiter,
  D1GovernanceRepository,
  D1MaterializedPlanRepository,
  D1NotificationOutboxRepository,
  D1OperatorAlertStateRepository,
  D1PublicApiRepository,
  D1PublishedActionDefinitionResolver,
  D1PublishedPolicyBindingResolver,
  listRecentOrganizations,
  loadOperatorDashboard,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  CloudflareWorkflowCancellationControl,
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  emitNotificationSkipped,
  notifyAlertTransition,
  ServiceBindingActionAuthorizer,
  ServiceBindingActionExecutor,
  SlackWebhookSink,
  type ActionServiceBinding,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "@app/approval-runtime-cloudflare";

import { Auth0IdentityProvider } from "./auth0-identity.ts";
import { readOperatorAlertThresholds } from "./operator-alert-thresholds.ts";
import { CloudflareActionWorkflowStarter } from "./workflow-starter.ts";
import { DispatchingActionExecutor } from "./dispatching-executor.ts";
import { StagingSchemaResolver } from "./staging-schema-resolver.ts";
import { StagingTrustedContextProvider } from "./trusted-context.ts";
import { WorkflowDecisionSink } from "./decision-sink.ts";
import { StagingActionAuthorizer } from "./staging-authorizer.ts";
import { StagingActionExecutor } from "./staging-executor.ts";

export { ActionWorkflow, StagingActionAuthorizer, StagingActionExecutor };

type ApprovalApiEnv = ActionWorkflowEnv & {
  ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
  NOTIFICATION_QUEUE: NotificationQueueProducer;
  AUTH0_DOMAIN: string;
  AUTH0_API_AUDIENCE: string;
  AUTH0_ORGANIZATION_ID: string;
  /** wrangler secret put のみ。平文commit禁止。未設定時は配信をskip (no-op成功) する。 */
  SLACK_WEBHOOK_URL?: string;
  /** alert閾値override (staging drill用 --var)。未設定・不正値はbaselineへfallback。 */
  OPERATOR_ALERT_OUTBOX_BACKLOG?: string;
  OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES?: string;
  OPERATOR_ALERT_FAILURE_TREND_MINUTES?: string;
  OPERATOR_ALERT_DWELL_P95_SLA_MS?: string;
};

function operatorAlertThresholds(env: ApprovalApiEnv) {
  return readOperatorAlertThresholds({
    OPERATOR_ALERT_OUTBOX_BACKLOG: env.OPERATOR_ALERT_OUTBOX_BACKLOG,
    OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES: env.OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES,
    OPERATOR_ALERT_FAILURE_TREND_MINUTES: env.OPERATOR_ALERT_FAILURE_TREND_MINUTES,
    OPERATOR_ALERT_DWELL_P95_SLA_MS: env.OPERATOR_ALERT_DWELL_P95_SLA_MS,
  });
}

class NoopNotificationSink implements NotificationSink {
  async send() {
    return Result.succeed(undefined);
  }
}

function createNotificationSink(env: ApprovalApiEnv): NotificationSink {
  const webhookUrl = env.SLACK_WEBHOOK_URL?.trim() ?? "";
  if (webhookUrl.length === 0) return new NoopNotificationSink();
  return new SlackWebhookSink({ webhookUrl });
}

function stagingOrganizationId(env: ApprovalApiEnv): OrganizationId {
  return env.AUTH0_ORGANIZATION_ID as OrganizationId;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function decisionProcessor(env: ApprovalApiEnv): ApprovalDecisionCommandProcessor {
  return new ApprovalDecisionCommandProcessor(
    new D1PublicApiRepository(env.DB),
    new WorkflowDecisionSink(env.ACTION_WORKFLOW),
  );
}

async function sweepPendingDecisions(env: ApprovalApiEnv, now: string): Promise<void> {
  const repository = new D1PublicApiRepository(env.DB);
  const processor = decisionProcessor(env);
  const organizations = await listRecentOrganizations(env.DB, 50);
  if (Result.isFailure(organizations)) {
    console.error("decision sweep organizations failed", { code: organizations.error.code });
    return;
  }
  for (const organizationId of organizations.value) {
    const pending = await repository.listPending({ organizationId, limit: 100 });
    if (Result.isFailure(pending)) {
      console.error("decision sweep list failed", { code: pending.error.code });
      continue;
    }
    for (const record of pending.value) {
      const processed = await processor.process({
        organizationId,
        commandId: record.command.id,
        appliedAt: now,
      });
      if (Result.isFailure(processed)) {
        console.error("decision sweep process failed", { code: processed.error.code });
      }
    }
  }
}

function buildApi(input: {
  env: ApprovalApiEnv;
  authorizerBinding: ActionServiceBinding;
  executorBinding: ActionServiceBinding;
}): { fetch(request: Request): Promise<Response> } {
  const env = input.env;
  const telemetry = new ConsoleTelemetrySink();
  const organizationId = stagingOrganizationId(env);
  const identity = new Auth0IdentityProvider({
    domain: env.AUTH0_DOMAIN,
    audience: env.AUTH0_API_AUDIENCE,
    organizationId,
  });
  const readRepository = new D1PublicApiRepository(env.DB);
  const decisionService = new ApprovalDecisionCommandService(readRepository, readRepository, {
    next: () => `command:${crypto.randomUUID()}`,
  });
  const authorizer = new ServiceBindingActionAuthorizer(input.authorizerBinding, organizationId);
  const dispatcher = new DispatchingActionExecutor({
    governance: new GovernanceActionExecutor(
      new D1GovernanceRepository(env.DB),
      new CloudflareWorkflowCancellationControl(env.DB, env.ACTION_WORKFLOW),
    ),
    staging: new ServiceBindingActionExecutor(input.executorBinding, "staging" as ExecutorKey),
  });
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: new D1PublishedActionDefinitionResolver(env.DB, organizationId),
    schemaResolver: new StagingSchemaResolver(),
    policyBindingResolver: new D1PublishedPolicyBindingResolver(env.DB),
    authorizer,
    executor: dispatcher,
    planRepository: new D1MaterializedPlanRepository(env.DB),
    workflowStarter: new CloudflareActionWorkflowStarter(env.ACTION_WORKFLOW),
    idGenerator: { next: () => `action:${crypto.randomUUID()}` as ActionRequestId },
  });
  const rateLimiter = new D1FixedWindowRateLimiter(env.DB);
  const actionRequestApi = createActionRequestHttpApi({
    service,
    trustedContextProvider: new StagingTrustedContextProvider(identity),
    rateLimiter,
    telemetry,
  });
  const processor = decisionProcessor(env);
  return createPublicHttpApi({
    actionRequestApi,
    readRepository,
    decisionService,
    identityProvider: identity,
    idempotencyRepository: readRepository,
    clock: { now: () => new Date().toISOString() },
    rateLimiter,
    onDecisionAccepted: async ({ organizationId, commandId }) => {
      const processed = await processor.process({
        organizationId,
        commandId,
        appliedAt: new Date().toISOString(),
      });
      if (Result.isFailure(processed)) {
        console.error("decision inline process failed", { code: processed.error.code });
      }
    },
  });
}

async function getOperatorDashboard(request: Request, env: ApprovalApiEnv): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("organizationId")?.trim();
  if (raw !== undefined && raw.length === 0) {
    return json({ error: "organizationId must not be empty" }, { status: 400 });
  }
  const organizationId = (raw ?? stagingOrganizationId(env)) as OrganizationId;
  const snapshot = await loadOperatorDashboard(env.DB, { organizationId });
  if (Result.isFailure(snapshot)) {
    return json({ error: snapshot.error.message }, { status: 500 });
  }
  const alerts = await new D1OperatorAlertStateRepository(env.DB).loadAll({ organizationId });
  if (Result.isFailure(alerts)) {
    return json({ error: alerts.error.message }, { status: 500 });
  }
  return json(
    { ...snapshot.value, alerts: alerts.value, thresholds: operatorAlertThresholds(env) },
    { status: 200 },
  );
}

async function evaluateAlerts(env: ApprovalApiEnv, now: string): Promise<void> {
  const telemetry = new ConsoleTelemetrySink();
  const organizations = await listRecentOrganizations(env.DB, 50);
  if (Result.isFailure(organizations)) {
    console.error("operator dashboard organizations failed", { code: organizations.error.code });
    return;
  }
  const repository = new D1OperatorAlertStateRepository(env.DB);
  for (const organizationId of organizations.value) {
    const snapshot = await loadOperatorDashboard(env.DB, { organizationId });
    if (Result.isFailure(snapshot)) {
      console.error("operator dashboard snapshot failed", { code: snapshot.error.code });
      continue;
    }
    const previous = await repository.loadAll({ organizationId });
    if (Result.isFailure(previous)) {
      console.error("operator alert states failed", { code: previous.error.code });
      continue;
    }
    const dwellSamples = Object.values(snapshot.value.sli.dwellByStepKey);
    const evaluated = evaluateOperatorAlerts({
      thresholds: operatorAlertThresholds(env),
      previous: previous.value,
      values: {
        outboxBacklog: snapshot.value.outbox.backlog,
        outboxFailedTotal:
          snapshot.value.outbox.failedOutbox + snapshot.value.outbox.failedDeliveries,
        executorFailureTotal: Object.values(snapshot.value.sli.executorFailuresByCode).reduce(
          (total, count) => total + count,
          0,
        ),
        dwellP95Ms:
          dwellSamples.length === 0
            ? null
            : Math.max(...dwellSamples.map((sample) => sample.p95Ms ?? 0)),
      },
      now,
    });
    for (const state of evaluated.states) {
      const saved = await repository.save({ organizationId, ...state });
      if (Result.isFailure(saved)) {
        console.error("operator alert save failed", { code: saved.error.code });
      }
    }
    for (const transition of evaluated.transitions) {
      const firing = transition.to === "firing";
      telemetry.emit(
        safeLogRecord({
          level: firing ? "warn" : "info",
          event: firing ? "alert.firing" : "alert.resolved",
          correlation: {
            organizationId,
            actionRequestId: "action:operator-alert" as ActionRequestId,
            correlationId: `operator-alert:${String(organizationId)}:${transition.key}`,
            component: "d1",
            operation: "operator.alert",
          },
          attributes: { alertKey: transition.key, status: transition.to },
        }),
      );
      await notifyAlertTransition({
        webhookUrl: env.SLACK_WEBHOOK_URL ?? "",
        organizationId,
        alertKey: transition.key,
        from: transition.from,
        to: transition.to,
        telemetry,
      });
    }
  }
}

export default {
  async fetch(request: Request, env: ApprovalApiEnv): Promise<Response> {
    try {
      const authorizerBinding = env.ACTION_AUTHORIZER;
      const executorBinding = env.ACTION_EXECUTOR;
      if (!authorizerBinding || !executorBinding) {
        return Response.json(
          { error: "ACTION_AUTHORIZER/ACTION_EXECUTOR bindingがありません" },
          { status: 500 },
        );
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/operator/dashboard") {
        return getOperatorDashboard(request, env);
      }
      return buildApi({ env, authorizerBinding, executorBinding }).fetch(request);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
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
      console.error("notification outbox dispatch failed", { code: dispatched.error.code });
    }
    await evaluateAlerts(env, now);
    await sweepPendingDecisions(env, now);
  },

  async queue(batch, env): Promise<void> {
    const repository = new D1NotificationOutboxRepository(env.DB);
    const sink = createNotificationSink(env);
    // secret未設定のdegraded動作: 配信skip (ack成功) + warn log/metric。cron/queueは壊さない。
    const degraded = (env.SLACK_WEBHOOK_URL?.trim() ?? "").length === 0;
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
        if (degraded && consumed.value.delivered > 0) {
          emitNotificationSkipped(telemetry, {
            organizationId: message.body.organizationId,
            actionRequestId: message.body.actionRequestId,
          });
        }
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<ApprovalApiEnv, NotificationQueueMessage>;
