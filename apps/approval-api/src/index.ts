import { Result } from "@praha/byethrow";

import {
  ActionRequestApplicationService,
  ApprovalDecisionCommandProcessor,
  ApprovalDecisionCommandService,
  createActionRequestHttpApi,
  createPublicHttpApi,
  PublicApiRepositoryError,
} from "@app/approval-application";
import {
  ConsoleTelemetrySink,
  evaluateOperatorAlerts,
  safeLogRecord,
  type ActionRequestId,
  type NotificationSink,
  type OrganizationId,
  type PersistedOperatorAlertState,
} from "@app/approval-core";
import {
  D1ActionResultProjectionRepository,
  D1FixedWindowRateLimiter,
  D1MaterializedPlanRepository,
  D1NotificationOutboxRepository,
  D1OperatorAlertStateRepository,
  D1PublicApiRepository,
  D1PublishedActionDefinitionResolver,
  D1PublishedPolicyBindingResolver,
  listRecentOrganizations,
  loadOperatorDashboard,
  type OperatorDashboardSnapshot,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  emitNotificationSkipped,
  notifyAlertTransition,
  ServiceBindingActionAuthorizer,
  SlackWebhookSink,
  type ActionServiceBinding,
  type ActionWorkflowEnv,
  type ActionWorkflowParams,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "@app/approval-runtime-cloudflare";

import {
  authorizationAdminAccessChecker,
  buildAdminAuthorizationApi,
} from "./admin-authorization.ts";
import { Auth0IdentityProvider, readAuth0OrganizationMembership } from "./auth0-identity.ts";
import { readOperatorAlertThresholds } from "./operator-alert-thresholds.ts";
import { handleOperatorDashboard } from "./operator-dashboard.ts";
import { CloudflareActionWorkflowStarter } from "./workflow-starter.ts";
import { createActionExecutorRegistry } from "./executor-registry.ts";
import { StagingSchemaResolver } from "./staging-schema-resolver.ts";
import { StagingTrustedContextProvider } from "./trusted-context.ts";
import { WorkflowDecisionSink } from "./decision-sink.ts";
import { StagingActionAuthorizer } from "./staging-authorizer.ts";
import { StagingActionExecutor } from "./staging-executor.ts";
import { relationshipCoordinator } from "./relationship-mutation.ts";

export { ActionWorkflow, StagingActionAuthorizer, StagingActionExecutor };

type ApprovalApiEnv = ActionWorkflowEnv & {
  /** Non-secret Git revision the FGA model was published from (Model view). */
  AUTHORIZATION_MODEL_SOURCE_REVISION?: string;
  ACTION_WORKFLOW: Workflow<ActionWorkflowParams>;
  NOTIFICATION_QUEUE: NotificationQueueProducer;
  AUTH0_DOMAIN: string;
  AUTH0_API_AUDIENCE: string;
  AUTH0_ORGANIZATION_ID: string;
  /** Auth0 Organizations等でorganization所属を示すclaim名（既定 org_id）。 */
  AUTH0_ORGANIZATION_CLAIM?: string;
  /** そのclaimに期待する値（Auth0 Organization ID）。設定時はclaim一致を必須にする。 */
  AUTH0_ORGANIZATION_CLAIM_VALUE?: string;
  /**
   * "true"のときだけ、claimなしでAuth0 tenant全体を単一organizationとして信頼する
   * （public signupを無効にした単一組織tenant向けの明示opt-in）。どちらも無ければ全て403。
   */
  AUTH0_TENANT_IS_ORGANIZATION?: string;
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

function decisionProcessor(env: ApprovalApiEnv): ApprovalDecisionCommandProcessor {
  return new ApprovalDecisionCommandProcessor(
    new D1PublicApiRepository(env.DB),
    new WorkflowDecisionSink(env.ACTION_WORKFLOW),
  );
}

/**
 * 配送期限が到来したpending Decision commandをorganization横断で再配送する。
 * retriable失敗はprocessorがbackoff付きでpendingへ戻し、上限超過だけをfailedにする。
 */
async function sweepPendingDecisions(env: ApprovalApiEnv, now: string): Promise<void> {
  const repository = new D1PublicApiRepository(env.DB);
  const processor = decisionProcessor(env);
  const pending = await repository.listDuePending({ now, limit: 100 });
  if (Result.isFailure(pending)) {
    console.error("decision sweep list failed", { code: pending.error.code });
    return;
  }
  for (const record of pending.value) {
    const processed = await processor.process({
      organizationId: record.command.organizationId as OrganizationId,
      commandId: record.command.id,
      now,
    });
    if (Result.isFailure(processed)) {
      console.error("decision sweep process failed", { code: processed.error.code });
    }
  }
}

function buildApi(input: { env: ApprovalApiEnv; authorizerBinding: ActionServiceBinding }): {
  fetch(request: Request): Promise<Response>;
} {
  const env = input.env;
  const telemetry = new ConsoleTelemetrySink();
  const organizationId = stagingOrganizationId(env);
  const membership = readAuth0OrganizationMembership(env);
  const identity = new Auth0IdentityProvider({
    domain: env.AUTH0_DOMAIN,
    audience: env.AUTH0_API_AUDIENCE,
    organizationId,
    ...(membership ? { membership } : {}),
  });
  const adminAccess = authorizationAdminAccessChecker(env, organizationId);
  const readRepository = new D1PublicApiRepository(env.DB);
  const decisionService = new ApprovalDecisionCommandService(readRepository, readRepository, {
    next: () => `command:${crypto.randomUUID()}`,
  });
  const authorizer = new ServiceBindingActionAuthorizer(input.authorizerBinding, organizationId);
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver: new D1PublishedActionDefinitionResolver(env.DB, organizationId),
    schemaResolver: new StagingSchemaResolver(),
    policyBindingResolver: new D1PublishedPolicyBindingResolver(env.DB),
    authorizer,
    executor: createActionExecutorRegistry(env),
    planRepository: new D1MaterializedPlanRepository(env.DB),
    resultRepository: new D1ActionResultProjectionRepository(env.DB),
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
  const adminApi = buildAdminAuthorizationApi({ env, identity, organizationId, service });
  const publicApi = createPublicHttpApi({
    actionRequestApi,
    readRepository,
    decisionService,
    identityProvider: identity,
    operatorAccess: {
      // 関係者以外の閲覧はauthorization_admin viewer（運用者）に限る。userのみ・FGA障害はfail closed。
      async canReadAll({ principal }) {
        if (principal.type !== "user") return Result.succeed(false);
        const checked = await adminAccess.check({
          caller: { organizationId, principal },
          permission: "viewer",
        });
        return Result.isFailure(checked)
          ? Result.fail(
              new PublicApiRepositoryError(
                "operator_access_check_failed",
                checked.error.retriable,
                "operator権限を確認できません",
              ),
            )
          : checked;
      },
    },
    idempotencyRepository: readRepository,
    clock: { now: () => new Date().toISOString() },
    rateLimiter,
    onDecisionAccepted: async ({ organizationId, commandId }) => {
      const processed = await processor.process({
        organizationId,
        commandId,
        now: new Date().toISOString(),
      });
      if (Result.isFailure(processed)) {
        console.error("decision inline process failed", { code: processed.error.code });
      }
    },
  });
  return {
    fetch: (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/operator/dashboard") {
        return handleOperatorDashboard({
          request,
          callerResolver: identity,
          accessChecker: adminAccess,
          load: (organizationId) => loadOperatorDashboardView(env, organizationId),
          onError: (code) => console.error("operator dashboard failed", { code }),
        });
      }
      return adminApi.handles(request) ? adminApi.fetch(request) : publicApi.fetch(request);
    },
  };
}

type OperatorDashboardView = OperatorDashboardSnapshot & {
  alerts: PersistedOperatorAlertState[];
  thresholds: ReturnType<typeof operatorAlertThresholds>;
};

async function loadOperatorDashboardView(
  env: ApprovalApiEnv,
  organizationId: OrganizationId,
): Result.ResultAsync<OperatorDashboardView, { code: string }> {
  const snapshot = await loadOperatorDashboard(env.DB, { organizationId });
  if (Result.isFailure(snapshot)) return snapshot;
  const alerts = await new D1OperatorAlertStateRepository(env.DB).loadAll({ organizationId });
  if (Result.isFailure(alerts)) return alerts;
  return Result.succeed({
    ...snapshot.value,
    alerts: alerts.value,
    thresholds: operatorAlertThresholds(env),
  });
}

/**
 * Converges console-managed relationships whose mutation is indeterminate or
 * stuck in prepared/applying (crash / lost response) to the latest desired
 * revision. Stale revisions are superseded and never re-sent.
 */
async function reconcileRelationships(env: ApprovalApiEnv): Promise<void> {
  const coordinator = relationshipCoordinator(env);
  if (!coordinator) return;
  const reconciled = await coordinator.reconcilePending({
    organizationId: stagingOrganizationId(env),
  });
  if (Result.isFailure(reconciled)) {
    console.error("relationship reconcile failed", { code: reconciled.error.code });
    return;
  }
  if (reconciled.value.reconciled > 0) {
    console.log(
      JSON.stringify({
        event: "authorization.relationship_reconciled",
        count: reconciled.value.reconciled,
        statuses: reconciled.value.outcomes.map((outcome) => outcome.status),
      }),
    );
  }
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
      return buildApi({ env, authorizerBinding }).fetch(request);
    } catch (error) {
      // 例外messageは応答に含めない（#93）。
      console.error("approval api unhandled error", {
        code: "unhandled_error",
        name: error instanceof Error ? error.name : typeof error,
      });
      return Response.json(
        {
          type: "urn:ultra-easy:problem:internal_error",
          title: "Internal Server Error",
          status: 500,
          code: "internal_error",
        },
        { status: 500, headers: { "content-type": "application/problem+json" } },
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
    await reconcileRelationships(env);
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
