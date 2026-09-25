import { Result } from "@praha/byethrow";

import type {
  ActionRequestApplicationService,
  ActionRequestSubmitResult,
} from "@app/approval-application";
import {
  foldActionRequestStatus,
  isTerminalActionRequestStatus,
  parseBrand,
  sha256CanonicalJson,
} from "@app/approval-core";
import type {
  Action,
  ActionEventRepository,
  ActionRequestId,
  ActionRequestStatus,
  ActionResultRecord,
  DelegationScope,
  MaterializedPlanRepository,
  OrganizationId,
} from "@app/approval-core";
import type { JsonValue } from "@app/expression-core";
import type { ActionEffectRequest, WorkflowRunId } from "@app/workflow-core";

import { EffectHandlerError } from "../ports.ts";
import type { EffectContext, EffectHandler, EffectOutcomeReport } from "../ports.ts";
import { childAuthority } from "./principals.ts";
import type { ChildActionCorrelationRepository } from "./ports.ts";

/** child ActionRequestの現在状態（ActionRequest boundaryのread model）。 */
export type ChildActionStatus = {
  actionRequestId: ActionRequestId;
  status: ActionRequestStatus;
  /** Materialized Approval Plan（enforcementの正本）が承認を要求するか。 */
  approvalRequired?: boolean;
  output?: JsonValue;
  code?: string;
  message?: string;
};

export interface ChildActionStatusReader {
  status(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ChildActionStatus | null, EffectHandlerError>;
}

export interface ActionResultLoader {
  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionResultRecord | null, { message: string; retriable?: boolean }>;
}

/**
 * domain event（action_events）をcoreの状態機械でfoldしてchild ActionRequestの状態を得る
 * （read API / MCPと同じ導出。adapterごとに推測しない）。
 */
export class EventSourcedChildActionStatusReader implements ChildActionStatusReader {
  constructor(
    private readonly deps: {
      events: ActionEventRepository;
      plans: MaterializedPlanRepository;
      results: ActionResultLoader;
    },
  ) {}

  async status(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ChildActionStatus | null, EffectHandlerError> {
    const plan = await this.deps.plans.load(input);
    if (plan.type === "repository_error") {
      return Result.fail(new EffectHandlerError("child_status_unavailable", true, plan.message));
    }
    if (plan.type !== "found") return Result.succeed(null);
    const events = await this.deps.events.listForAction(input);
    if (Result.isFailure(events)) {
      return Result.fail(
        new EffectHandlerError("child_status_unavailable", true, events.error.message),
      );
    }
    if (events.value.length === 0) return Result.succeed(null);
    const status = foldActionRequestStatus(
      events.value.map((record) => record.event),
      { approvalRequired: plan.plan.flow.type !== "none" },
    );
    const result = await this.deps.results.load(input);
    if (Result.isFailure(result)) {
      return Result.fail(
        new EffectHandlerError(
          "child_status_unavailable",
          result.error.retriable ?? true,
          result.error.message,
        ),
      );
    }
    const record = result.value;
    return Result.succeed({
      actionRequestId: input.actionRequestId,
      status,
      approvalRequired: plan.plan.flow.type !== "none",
      ...(record?.result?.output !== undefined ? { output: record.result.output } : {}),
      ...(record?.code !== undefined ? { code: record.code } : {}),
      ...(record?.message !== undefined ? { message: record.message } : {}),
    });
  }
}

/** child ActionRequestの状態を作用の結果へ写像する（v1: 未処理の終端失敗はNodeの失敗）。 */
export function childStatusReport(child: ChildActionStatus): EffectOutcomeReport {
  const reference = String(child.actionRequestId);
  if (child.status === "executed") {
    return { type: "completed", output: child.output ?? null, reference };
  }
  if (isTerminalActionRequestStatus(child.status)) {
    return {
      type: "failed",
      code: child.status,
      message: child.message ?? `child ActionRequestが${child.status}で終端しました`,
      reference,
    };
  }
  return {
    type: "in_flight",
    waitingReason: child.status === "pending_approval" ? "waiting_approval" : "waiting_action",
    reference,
  };
}

/** WorkflowRun / Effectからchild ActionRequest IDを決定的に導出する（crash / retryで同じID）。 */
export async function childActionRequestId(input: {
  organizationId: OrganizationId;
  runId: WorkflowRunId;
  effectId: string;
}): Result.ResultAsync<ActionRequestId, EffectHandlerError> {
  const digest = await sha256CanonicalJson([
    String(input.organizationId),
    String(input.runId),
    input.effectId,
  ]);
  if (Result.isFailure(digest)) {
    return Result.fail(new EffectHandlerError("child_id_failed", false, digest.error.message));
  }
  const parsed = parseBrand(
    "ActionRequestId",
    `action:wf:${String(digest.value).slice("sha256:".length, "sha256:".length + 40)}`,
  );
  return Result.isFailure(parsed)
    ? Result.fail(new EffectHandlerError("child_id_failed", false, parsed.error.message))
    : parsed;
}

/** child ActionRequestのcancel伝播（Composite childのWorkflowRun cancel等）。 */
export interface ChildActionCanceller {
  cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    now: string;
  }): Result.ResultAsync<void, EffectHandlerError>;
}

/** Program / LLM Nodeからのaction要求に委任するscopeを決める（#161 Capability Broker）。 */
export interface ActionEffectScopePolicy {
  scopeFor(
    context: EffectContext,
    request: ActionEffectRequest,
  ): Result.Result<DelegationScope, EffectHandlerError>;
}

/** Action Nodeの宣言（actionType / resource type / restriction）だけをNode Agentへ委任する。 */
export const actionNodeScopePolicy: ActionEffectScopePolicy = {
  scopeFor(context, request) {
    if (context.node.type !== "action") {
      return Result.fail(
        new EffectHandlerError(
          "capability_denied",
          false,
          `${context.node.type} NodeのAction要求にはcapability grantが必要です`,
        ),
      );
    }
    const resourceType = parseBrand("ResourceType", request.resource.type);
    if (Result.isFailure(resourceType)) {
      return Result.fail(
        new EffectHandlerError("action_input_invalid", false, "resource typeが不正です"),
      );
    }
    return Result.succeed({
      actionTypes: [request.actionType],
      resourceTypes: [resourceType.value],
    });
  },
};

function submitReport(submitted: ActionRequestSubmitResult): EffectOutcomeReport {
  if (submitted.type === "authorization_denied") {
    return {
      type: "failed",
      code: "authorization_denied",
      message: submitted.reason,
      reference: String(submitted.actionRequestId),
    };
  }
  const view = submitted.view;
  return childStatusReport({
    actionRequestId: submitted.actionRequestId,
    status: view.status,
    ...(view.result?.output !== undefined ? { output: view.result.output } : {}),
    ...(view.result?.code !== undefined ? { code: view.result.code } : {}),
    ...(view.result?.message !== undefined ? { message: view.result.message } : {}),
  });
}

/**
 * Action作用を **必ずActionRequest boundary経由** で実行するhandler（#158）。
 *
 * - child ActionRequest IDはrun / effectから決定的に導出し、既に存在すればその状態を返す（冪等）
 * - 評価時刻は作用の予約時刻に固定し、再配送でも同じPlanへ収束させる（commit resume）
 * - actor = Node Agent、authority = 親authority + `親actor -> Workflow Agent -> Node Agent`委任
 * - Authorization / Policy / Approval / Re-AuthorizationはActionRequest pipelineがそのまま行う
 *   （Workflow RuntimeはActionExecutorを直接呼ばない）
 */
export class ActionRequestEffectHandler implements EffectHandler {
  constructor(
    private readonly deps: {
      actionRequests: Pick<ActionRequestApplicationService, "prepare" | "commit">;
      statuses: ChildActionStatusReader;
      correlations: ChildActionCorrelationRepository;
      canceller?: ChildActionCanceller;
      scopePolicy?: ActionEffectScopePolicy;
    },
  ) {}

  private async childId(context: EffectContext) {
    return childActionRequestId({
      organizationId: context.run.state.organizationId,
      runId: context.run.state.runId,
      effectId: String(context.effect.id),
    });
  }

  async dispatch(
    context: EffectContext,
  ): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    const request = context.effect.request;
    if (request.kind !== "action") {
      return Result.succeed({
        type: "failed",
        code: "effect_kind_mismatch",
        message: "action作用ではありません",
      });
    }
    const { run } = context;
    const organizationId = run.state.organizationId;
    const childId = await this.childId(context);
    if (Result.isFailure(childId)) return childId;

    const existing = await this.deps.statuses.status({
      organizationId,
      actionRequestId: childId.value,
    });
    if (Result.isFailure(existing)) return existing;
    if (existing.value) return Result.succeed(childStatusReport(existing.value));

    const scope = (this.deps.scopePolicy ?? actionNodeScopePolicy).scopeFor(context, request);
    if (Result.isFailure(scope)) {
      return Result.succeed({
        type: "failed",
        code: scope.error.code,
        message: scope.error.message,
      });
    }
    const principals = childAuthority({
      parentActor: run.invocation.actor,
      parentAuthority: run.invocation.authority,
      definition: context.version.definition,
      runId: run.state.runId,
      nodeId: context.node.id,
      nodeScope: scope.value,
      ...(run.invocation.delegationTimeBounds
        ? { timeBounds: run.invocation.delegationTimeBounds }
        : {}),
    });
    if (Result.isFailure(principals)) return principals;

    const resourceType = parseBrand("ResourceType", request.resource.type);
    const resourceId = parseBrand("ResourceId", request.resource.id);
    const agentRunId = parseBrand("AgentRunId", String(run.state.runId));
    if (
      Result.isFailure(resourceType) ||
      Result.isFailure(resourceId) ||
      Result.isFailure(agentRunId)
    ) {
      return Result.succeed({
        type: "failed",
        code: "action_input_invalid",
        message: "resourceが不正です",
      });
    }

    const recorded = await this.deps.correlations.record({
      organizationId,
      childActionRequestId: childId.value,
      runId: run.state.runId,
      nodeRunId: context.effect.nodeRunId,
      effectId: context.effect.id,
      ...(run.invocation.parentAction
        ? { parentActionRequestId: run.invocation.parentAction.actionRequestId }
        : {}),
      depth: run.depth,
      ancestry: [...(run.invocation.ancestry ?? []), run.state.definitionId],
      actionType: request.actionType,
      createdAt: context.effect.requestedAt,
    });
    if (Result.isFailure(recorded)) {
      return Result.fail(
        new EffectHandlerError(
          recorded.error.code,
          recorded.error.retriable,
          recorded.error.message,
        ),
      );
    }

    const action: Action = {
      type: request.actionType,
      resource: { type: resourceType.value, id: resourceId.value },
      input: request.input,
    };
    const prepared = await this.deps.actionRequests.prepare({
      action,
      actionRequestId: childId.value,
      clientReference: `workflow:${String(run.state.runId)}/${String(context.effect.nodeRunId)}`,
      trustedContext: {
        actor: principals.value.actor,
        authority: principals.value.authority,
        origin: {
          type: "system",
          caller: principals.value.workflowAgent,
          agentRunId: agentRunId.value,
        },
        organization: { id: organizationId, settings: run.state.context.organizationSettings },
        attributes: run.state.context.attributes,
        // 作用の予約時刻で評価し、再配送でも同じPlan（checksum）へ収束させる。
        now: context.effect.requestedAt,
      },
    });
    if (Result.isFailure(prepared)) {
      if (prepared.error.retriable) {
        return Result.fail(
          new EffectHandlerError(prepared.error.code, true, prepared.error.message),
        );
      }
      return Result.succeed({
        type: "failed",
        code: prepared.error.code,
        message: prepared.error.message,
        reference: String(childId.value),
      });
    }
    const committed = await this.deps.actionRequests.commit({
      preparation: prepared.value,
      now: context.now,
      resume: true,
    });
    if (Result.isFailure(committed)) {
      if (committed.error.code === "execution_failed") {
        // 同期実行の失敗はaction_resultsに記録済み。状態を読み直して結果を返す。
        const after = await this.deps.statuses.status({
          organizationId,
          actionRequestId: childId.value,
        });
        if (Result.isSuccess(after) && after.value)
          return Result.succeed(childStatusReport(after.value));
      }
      if (committed.error.retriable) {
        return Result.fail(
          new EffectHandlerError(committed.error.code, true, committed.error.message),
        );
      }
      return Result.succeed({
        type: "failed",
        code: committed.error.executionErrorCode ?? committed.error.code,
        message: committed.error.message,
        reference: String(childId.value),
      });
    }
    return Result.succeed(submitReport(committed.value));
  }

  async poll(context: EffectContext): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    const childId = await this.childId(context);
    if (Result.isFailure(childId)) return childId;
    const status = await this.deps.statuses.status({
      organizationId: context.run.state.organizationId,
      actionRequestId: childId.value,
    });
    if (Result.isFailure(status)) return status;
    if (!status.value) {
      return Result.succeed({
        type: "in_flight",
        waitingReason: "waiting_action",
        reference: String(childId.value),
      });
    }
    return Result.succeed(childStatusReport(status.value));
  }

  async cancel(context: EffectContext): Result.ResultAsync<void, EffectHandlerError> {
    if (!this.deps.canceller) return Result.succeed(undefined);
    const childId = await this.childId(context);
    if (Result.isFailure(childId)) return childId;
    return this.deps.canceller.cancel({
      organizationId: context.run.state.organizationId,
      actionRequestId: childId.value,
      reason: `parent WorkflowRun ${String(context.run.state.runId)} cancelled the child`,
      now: context.now,
    });
  }
}
