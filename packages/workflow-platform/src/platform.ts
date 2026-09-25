import { Result } from "@praha/byethrow";

import {
  ActionExecutionCompletionService,
  ActionRequestApplicationService,
} from "@app/approval-application";
import type { ActionWorkflowStarter } from "@app/approval-application";
import { ActionExecutorRegistry, newIdentifier } from "@app/approval-core";
import type {
  ActionAuthorizer,
  ActionExecutor,
  ActionRequestId,
  OrganizationId,
  SchemaResolver,
} from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1ActionResultProjectionRepository,
  D1AsyncActionExecutionRepository,
  D1GovernanceRepository,
  D1MaterializedPlanRepository,
  D1PublishedActionDefinitionResolver,
  D1PublishedPolicyBindingResolver,
} from "@app/approval-d1";
import {
  ActionRequestEffectHandler,
  CompositeActionCompletionListener,
  CompositeActionPublisher,
  CompositeAwareChildActionCanceller,
  EventSourcedChildActionStatusReader,
  HumanInputEffectHandler,
  InProcessWorkflowRunScheduler,
  PlanParentActionContextResolver,
  TimerEffectHandler,
  WORKFLOW_EXECUTOR_KEY,
  WorkflowActionExecutor,
  WorkflowApprovalProjector,
  WorkflowInputSchemaResolver,
  WorkflowPublishingService,
  WorkflowRuntime,
  traceAction,
} from "@app/workflow-application";
import type {
  ActionEffectScopePolicy,
  ActionTrace,
  ChildActionCanceller,
  Clock,
  EffectHandlers,
  WorkflowAdmissionController,
  WorkflowRunScheduler,
} from "@app/workflow-application";
import {
  D1ActionCatalogPublisher,
  D1ChildActionCorrelationRepository,
  D1WorkflowActionBindingRepository,
  D1WorkflowDraftRepository,
  D1WorkflowRunRepository,
  D1WorkflowVersionRepository,
} from "@app/workflow-d1";
import type { D1DatabaseLike } from "@app/workflow-d1";

import { PolicyApprovalRequirementProbe } from "./projection-probe.ts";

export type WorkflowPlatformOptions = {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  clock: Clock;
  authorizer: ActionAuthorizer;
  /** primitive Actionのexecutor（executorKey -> executor）。`workflow`は予約済み。 */
  primitiveExecutors: Record<string, ActionExecutor>;
  /** 承認が必要なActionRequestのDurable Approval Workflow起動。 */
  workflowStarter: ActionWorkflowStarter;
  schemaResolver?: SchemaResolver;
  /** WorkflowRunを進めるdriver。既定はin-process（同じisolateでadvance）。 */
  scheduler?: (runtime: () => WorkflowRuntime) => WorkflowRunScheduler;
  /** program / llm等の追加作用handler（#160 / #161）。 */
  effects?: EffectHandlers;
  /** Program / LLM NodeのAction作用に委任するscope（#161 Capability Broker）。 */
  actionScopePolicy?: ActionEffectScopePolicy;
  admission?: WorkflowAdmissionController;
  /** 承認待ち等のprimitive child ActionRequestのcancel。 */
  primitiveCanceller?: ChildActionCanceller;
  pollIntervalSeconds?: number;
  /** Composite Actionの最大nest深さ（既定: MAX_WORKFLOW_DEPTH）。 */
  maxDepth?: number;
  idGenerator?: { next(): ActionRequestId };
};

/**
 * ActionRequest pipeline（Authorization / Policy / Approval / Re-Authorization / Executor）と
 * Workflow Runtime（Composite Action）を同じD1上に組み立てるcomposition root。
 *
 * primitive / composite Actionは同じAction Catalog（published_action_definitions）から解決され、
 * Workflow内のActionは必ず`ActionRequestApplicationService`を通る。
 */
export function createWorkflowPlatform(options: WorkflowPlatformOptions) {
  const { db, organizationId } = options;
  const versions = new D1WorkflowVersionRepository(db);
  const drafts = new D1WorkflowDraftRepository(db);
  const runs = new D1WorkflowRunRepository(db);
  const bindings = new D1WorkflowActionBindingRepository(db);
  const correlations = new D1ChildActionCorrelationRepository(db);
  const catalog = new D1ActionCatalogPublisher(db);
  const plans = new D1MaterializedPlanRepository(db);
  const events = new D1ActionEventRepository(db);
  const results = new D1ActionResultProjectionRepository(db);
  const asyncExecutions = new D1AsyncActionExecutionRepository(db);
  const governance = new D1GovernanceRepository(db);

  let runtime: WorkflowRuntime | undefined;
  const getRuntime = (): WorkflowRuntime => {
    if (!runtime) runtime = buildRuntime();
    return runtime;
  };
  const scheduler =
    options.scheduler?.(getRuntime) ?? new InProcessWorkflowRunScheduler(getRuntime);
  const completion = new ActionExecutionCompletionService({ asyncExecutions, results, events });
  const workflowExecutor = new WorkflowActionExecutor({
    bindings,
    versions,
    runs,
    correlations,
    parentContext: new PlanParentActionContextResolver(plans),
    runtime: getRuntime,
    scheduler,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  });
  const registry = new ActionExecutorRegistry({
    ...options.primitiveExecutors,
    [String(WORKFLOW_EXECUTOR_KEY)]: workflowExecutor,
  });
  const actionDefinitionResolver = new D1PublishedActionDefinitionResolver(db, organizationId);
  const policyBindingResolver = new D1PublishedPolicyBindingResolver(db);
  const service = new ActionRequestApplicationService({
    actionDefinitionResolver,
    schemaResolver: new WorkflowInputSchemaResolver({
      organizationId,
      versions,
      ...(options.schemaResolver ? { fallback: options.schemaResolver } : {}),
    }),
    policyBindingResolver,
    authorizer: options.authorizer,
    executor: registry,
    planRepository: plans,
    eventRepository: events,
    resultRepository: results,
    asyncExecutions,
    workflowStarter: options.workflowStarter,
    idGenerator: options.idGenerator ?? { next: () => newIdentifier("ActionRequestId", "action") },
  });
  const statuses = new EventSourcedChildActionStatusReader({ events, plans, results });
  const canceller = new CompositeAwareChildActionCanceller({
    completion,
    runs,
    runtime: getRuntime,
    ...(options.primitiveCanceller ? { primitive: options.primitiveCanceller } : {}),
  });

  function buildRuntime(): WorkflowRuntime {
    return new WorkflowRuntime({
      versions,
      runs,
      clock: options.clock,
      completion: new CompositeActionCompletionListener({ completion, correlations, scheduler }),
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.pollIntervalSeconds !== undefined
        ? { pollIntervalSeconds: options.pollIntervalSeconds }
        : {}),
      effects: {
        action: new ActionRequestEffectHandler({
          actionRequests: service,
          statuses,
          correlations,
          canceller,
          ...(options.actionScopePolicy ? { scopePolicy: options.actionScopePolicy } : {}),
        }),
        timer: new TimerEffectHandler(),
        human_input: new HumanInputEffectHandler(),
        ...options.effects,
      },
    });
  }

  const projector = new WorkflowApprovalProjector({
    probe: new PolicyApprovalRequirementProbe({
      definitions: actionDefinitionResolver,
      policyBindings: policyBindingResolver,
      bindings,
      versions,
    }),
  });

  const publishing = new WorkflowPublishingService({
    versions,
    drafts,
    composites: new CompositeActionPublisher({ bindings, catalog }),
  });

  return {
    organizationId,
    service,
    registry,
    completion,
    publishing,
    projector,
    actionDefinitionResolver,
    statuses,
    scheduler,
    governance,
    catalog,
    get runtime(): WorkflowRuntime {
      return getRuntime();
    },
    repositories: {
      versions,
      drafts,
      runs,
      bindings,
      correlations,
      plans,
      events,
      results,
      asyncExecutions,
    },
    /** `Composite ActionRequest -> WorkflowRun -> NodeRun -> child ActionRequest`の相関trace。 */
    async trace(actionRequestId: ActionRequestId): Promise<ActionTrace | null> {
      const traced = await traceAction({
        organizationId,
        actionRequestId,
        runs,
        correlations,
        statuses,
      });
      return Result.isSuccess(traced) ? traced.value : null;
    },
  };
}

export type WorkflowPlatform = ReturnType<typeof createWorkflowPlatform>;
