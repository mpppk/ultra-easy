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
  type ActionRequestId,
  type OrganizationId,
} from "@app/approval-core";
import {
  createD1ActionRequestPersistence,
  D1FixedWindowRateLimiter,
  D1PublicApiRepository,
} from "@app/approval-d1";
import {
  ActionWorkflow,
  createSlackNotificationSink,
  evaluateRecentOrganizationAlerts,
  handleNotificationQueueBatch,
  loadOperatorDashboardView,
  notificationScheduledTasks,
  notifyAlertTransition,
  readOperatorAlertThresholds,
  runScheduledTasks,
  ServiceBindingActionAuthorizer,
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
 * 1件の失敗で残りを止めず、失敗件数をerrorで返す。
 */
async function sweepPendingDecisions(
  env: ApprovalApiEnv,
  now: string,
): Result.ResultAsync<{ processed: number }, { code: string }> {
  const repository = new D1PublicApiRepository(env.DB);
  const processor = decisionProcessor(env);
  const pending = await repository.listDuePending({ now, limit: 100 });
  if (Result.isFailure(pending)) return pending;
  let failedCode: string | undefined;
  for (const record of pending.value) {
    const processed = await processor.process({
      organizationId: record.command.organizationId as OrganizationId,
      commandId: record.command.id,
      now,
    });
    if (Result.isFailure(processed)) failedCode ??= processed.error.code;
  }
  return failedCode
    ? Result.fail({ code: failedCode })
    : Result.succeed({ processed: pending.value.length });
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
    ...createD1ActionRequestPersistence(env.DB, organizationId),
    schemaResolver: new StagingSchemaResolver(),
    authorizer,
    executor: createActionExecutorRegistry(env),
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
          load: (organizationId) =>
            loadOperatorDashboardView(env.DB, {
              organizationId,
              thresholds: readOperatorAlertThresholds(env),
            }),
          onError: (code) => console.error("operator dashboard failed", { code }),
        });
      }
      return adminApi.handles(request) ? adminApi.fetch(request) : publicApi.fetch(request);
    },
  };
}

/**
 * Converges console-managed relationships whose mutation is indeterminate or
 * stuck in prepared/applying (crash / lost response) to the latest desired
 * revision. Stale revisions are superseded and never re-sent.
 */
async function reconcileRelationships(
  env: ApprovalApiEnv,
): Result.ResultAsync<{ reconciled: number }, { code: string }> {
  const coordinator = relationshipCoordinator(env);
  if (!coordinator) return Result.succeed({ reconciled: 0 });
  const reconciled = await coordinator.reconcilePending({
    organizationId: stagingOrganizationId(env),
  });
  if (Result.isFailure(reconciled)) return reconciled;
  return Result.succeed({ reconciled: reconciled.value.reconciled });
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
    const webhookUrl = env.SLACK_WEBHOOK_URL?.trim() ?? "";
    await runScheduledTasks({
      now: new Date(controller.scheduledTime).toISOString(),
      telemetry,
      tasks: [
        ...notificationScheduledTasks({
          db: env.DB,
          queue: env.NOTIFICATION_QUEUE,
          telemetry,
          sinkConfigured: webhookUrl.length > 0,
        }),
        {
          name: "evaluate_operator_alerts",
          run: (now) =>
            evaluateRecentOrganizationAlerts({
              db: env.DB,
              thresholds: readOperatorAlertThresholds(env),
              now,
              telemetry,
              onTransition: (transition) =>
                notifyAlertTransition({
                  webhookUrl,
                  organizationId: transition.organizationId,
                  alertKey: transition.key,
                  from: transition.from,
                  to: transition.to,
                  telemetry,
                }),
            }),
        },
        { name: "sweep_pending_decisions", run: (now) => sweepPendingDecisions(env, now) },
        { name: "reconcile_relationships", run: () => reconcileRelationships(env) },
      ],
    });
  },

  async queue(batch, env): Promise<void> {
    await handleNotificationQueueBatch({
      batch,
      db: env.DB,
      // secret未設定のdegraded動作: 配信をskippedとして記録し、設定後にcronで再送する。
      sink: createSlackNotificationSink(env.SLACK_WEBHOOK_URL),
      telemetry: new ConsoleTelemetrySink(),
      now: () => new Date().toISOString(),
    });
  },
} satisfies ExportedHandler<ApprovalApiEnv, NotificationQueueMessage>;
