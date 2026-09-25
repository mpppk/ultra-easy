import { Result } from "@praha/byethrow";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

import {
  createActionExecutionIdempotencyKey,
  executeAuthorizedAction,
  executorFailureStatus,
  reauthorizeActionForExecution,
  validateApprovalBindingForExecution,
  type ActionExecutionGuaranteeLevel,
  type ActionExecutionTerminalStatus,
  type ActionRequest,
  type ActionRequestId,
  type ApprovalPlanChecksum,
  type AuthorityMode,
  type AuthorizationConsistency,
  type AuthorizationEvidence,
  type DelegationGrantId,
  type MaterializedApprovalPlan,
  type OrganizationId,
} from "@app/approval-core";
import type { ActionWorkflowDependencies } from "./workflow-dependencies.ts";

export type { ActionExecutionTerminalStatus };

/**
 * 保証レベルごとの「execute action」stepのretry方針。
 * - idempotent: 同じidempotency keyでの再実行が安全なため、retriableな失敗をbackoff付きでretryする。
 * - best_effort_at_most_once: 再実行しない。一時障害は副作用の有無が不明なため
 *   `execution_unknown`で終端し、人手でreconcileする。
 */
export const ACTION_EXECUTION_STEP_CONFIG: Record<
  ActionExecutionGuaranteeLevel,
  WorkflowStepConfig
> = {
  idempotent: {
    retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
    timeout: "5 minutes",
  },
  best_effort_at_most_once: {
    retries: { limit: 0, delay: 0 },
    timeout: "5 minutes",
  },
};

const DESCRIBE_EXECUTOR_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

export type ActionExecutionWorkflowResult =
  | {
      type: "completed";
      status: ActionExecutionTerminalStatus;
      guaranteeLevel?: ActionExecutionGuaranteeLevel;
      idempotencyKey?: string;
      resultJson?: string;
      authorizationEvidence?: AuthorizationEvidence;
      retriable?: boolean;
      code?: string;
      message?: string;
    }
  | {
      /** async executorが受け付けた（#165）。最終結果はtrusted completionで確定する。 */
      type: "accepted";
      guaranteeLevel: ActionExecutionGuaranteeLevel;
      idempotencyKey: string;
      executionRef: string;
      authorizationEvidence: AuthorizationEvidence;
    }
  | {
      type: "failed";
      code: string;
      message: string;
    };

type ActionExecutionWorkflowParams = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

type TerminalTransition = {
  type: "terminal";
  status: ActionExecutionTerminalStatus;
  guaranteeLevel?: ActionExecutionGuaranteeLevel;
  idempotencyKey?: string;
  retriable?: boolean;
  code: string;
  message: string;
};

type FailedTransition = {
  type: "failed";
  code: string;
  message: string;
};

type RetryTransition = {
  type: "retry";
  error: Error;
};

type PersistedAuthorizationEvidence = {
  evaluatedAt: string;
  provider?: string;
  contextChecksum?: string;
  authorizationModelId?: string;
  consistency: AuthorizationConsistency;
  authorityMode?: AuthorityMode;
  delegationGrantIds?: DelegationGrantId[];
};

type ReauthorizationTransition =
  | { type: "authorized"; evidence: PersistedAuthorizationEvidence }
  | TerminalTransition
  | FailedTransition
  | RetryTransition;

type ReauthorizationStepResult = Exclude<ReauthorizationTransition, RetryTransition>;

type ExecutionTransition =
  | {
      type: "executed";
      guaranteeLevel: ActionExecutionGuaranteeLevel;
      idempotencyKey: string;
      resultJson: string;
    }
  | {
      type: "accepted";
      guaranteeLevel: ActionExecutionGuaranteeLevel;
      idempotencyKey: string;
      executionRef: string;
    }
  | TerminalTransition
  | FailedTransition
  | RetryTransition;

type ExecutionStepResult = Exclude<ExecutionTransition, RetryTransition>;

type ExecutorDescriptionTransition =
  | { type: "registered"; guaranteeLevel: ActionExecutionGuaranteeLevel }
  | TerminalTransition
  | FailedTransition
  | RetryTransition;

type ExecutorDescriptionStepResult = Exclude<ExecutorDescriptionTransition, RetryTransition>;

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistAuthorizationEvidence(
  evidence: AuthorizationEvidence,
): PersistedAuthorizationEvidence {
  return {
    evaluatedAt: evidence.evaluatedAt,
    consistency: evidence.consistency,
    ...(evidence.provider !== undefined ? { provider: evidence.provider } : {}),
    ...(evidence.contextChecksum !== undefined
      ? { contextChecksum: evidence.contextChecksum }
      : {}),
    ...(evidence.authorizationModelId !== undefined
      ? { authorizationModelId: evidence.authorizationModelId }
      : {}),
    ...(evidence.authorityMode !== undefined ? { authorityMode: evidence.authorityMode } : {}),
    ...(evidence.delegationGrantIds !== undefined
      ? { delegationGrantIds: [...evidence.delegationGrantIds] }
      : {}),
  };
}

function restoreAuthorizationEvidence(
  evidence: PersistedAuthorizationEvidence,
): AuthorizationEvidence {
  return {
    evaluatedAt: evidence.evaluatedAt,
    consistency: evidence.consistency,
    ...(evidence.provider !== undefined ? { provider: evidence.provider } : {}),
    ...(evidence.contextChecksum !== undefined
      ? { contextChecksum: evidence.contextChecksum }
      : {}),
    ...(evidence.authorizationModelId !== undefined
      ? { authorizationModelId: evidence.authorizationModelId }
      : {}),
    ...(evidence.authorityMode !== undefined ? { authorityMode: evidence.authorityMode } : {}),
    ...(evidence.delegationGrantIds !== undefined
      ? {
          delegationGrantIds: [...evidence.delegationGrantIds],
        }
      : {}),
  };
}

function requestFromPlan(plan: MaterializedApprovalPlan): ActionRequest {
  return {
    actor: plan.evaluationSnapshot.actor,
    authority: plan.evaluationSnapshot.authority,
    action: {
      type: plan.action.type,
      resource: plan.action.resource,
      input: plan.action.input,
    },
    origin: plan.evaluationSnapshot.origin,
  };
}

async function loadPlan(
  deps: ActionWorkflowDependencies,
  params: ActionExecutionWorkflowParams,
): Promise<{ type: "found"; plan: MaterializedApprovalPlan } | FailedTransition | RetryTransition> {
  const loaded = await deps.plans.loadForWorkflow({
    organizationId: params.organizationId,
    actionRequestId: params.actionRequestId,
    expectedApprovalPlanChecksum: params.approvalPlanChecksum,
  });
  if (loaded.type === "found") return loaded;
  if (loaded.type === "repository_error") {
    return {
      type: "retry",
      error: new Error(`Materialized Approval Plan repository error: ${loaded.message}`),
    };
  }
  if (loaded.type === "not_found") {
    return {
      type: "failed",
      code: "approval_plan_not_found",
      message: "Materialized Approval Planが見つかりません",
    };
  }
  if (loaded.type === "checksum_mismatch") {
    return {
      type: "failed",
      code: "approval_plan_checksum_mismatch",
      message: `Workflow paramsのApproval Plan checksumと保存済みPlanが一致しません: ${String(loaded.actualApprovalPlanChecksum)}`,
    };
  }
  return { type: "failed", code: loaded.type, message: loaded.message };
}

async function validateApprovalBinding(
  deps: ActionWorkflowDependencies,
  plan: MaterializedApprovalPlan,
): Promise<FailedTransition | RetryTransition | null> {
  if (plan.flow.type === "none") return null;

  const projection = await deps.projections.load({
    organizationId: plan.organizationId,
    actionRequestId: plan.actionRequestId,
  });
  if (Result.isFailure(projection)) {
    return {
      type: "retry",
      error: new Error(`Approval runtime projection error: ${projection.error.message}`),
    };
  }

  const binding = validateApprovalBindingForExecution({
    plan,
    state: projection.value,
  });
  if (Result.isFailure(binding)) {
    return {
      type: "failed",
      code: binding.error.code,
      message: binding.error.message,
    };
  }
  return null;
}

async function reauthorizeStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  evaluatedAt: string;
}): Promise<ReauthorizationTransition> {
  const loaded = await loadPlan(input.deps, input.params);
  if (loaded.type !== "found") return loaded;
  const invalidBinding = await validateApprovalBinding(input.deps, loaded.plan);
  if (invalidBinding) return invalidBinding;
  const authorizer = input.deps.actionAuthorizer(input.params);
  if (!authorizer) {
    return {
      type: "terminal",
      status: "authorization_check_failed",
      retriable: false,
      code: "action_authorizer_not_configured",
      message: "Action Authorization service bindingが設定されていません",
    };
  }

  const result = await reauthorizeActionForExecution({
    authorizer,
    request: requestFromPlan(loaded.plan),
    evaluatedAt: input.evaluatedAt,
  });
  if (Result.isFailure(result)) {
    return result.error.retriable
      ? { type: "retry", error: result.error }
      : {
          type: "terminal",
          status: "authorization_check_failed",
          retriable: false,
          code: result.error.code,
          message: result.error.message,
        };
  }
  if (result.value.type === "authorization_revoked") {
    return {
      type: "terminal",
      status: "authorization_revoked",
      retriable: false,
      code: result.value.code,
      message: result.value.reason,
    };
  }
  return {
    type: "authorized",
    evidence: persistAuthorizationEvidence(result.value.authorizationEvidence),
  };
}

async function runReauthorizationStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
  evaluatedAt: string;
}): Promise<ReauthorizationStepResult> {
  try {
    return await input.step.do<ReauthorizationStepResult>("reauthorize action", async () => {
      const transition = await reauthorizeStep(input);
      if (transition.type === "retry") return Promise.reject(transition.error);
      return transition;
    });
  } catch (error) {
    return {
      type: "terminal",
      status: "authorization_check_failed",
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

/** downstreamのexecutor registryに問い合わせ、executorKeyの登録と実行保証を確定する。 */
async function describeExecutorStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
}): Promise<ExecutorDescriptionTransition> {
  const loaded = await loadPlan(input.deps, input.params);
  if (loaded.type !== "found") return loaded;
  const executorKey = loaded.plan.action.definition.executorKey;
  const describable = input.deps.actionExecutor(executorKey);
  if (!describable) {
    return {
      type: "terminal",
      status: "execution_failed",
      retriable: false,
      code: "action_executor_not_configured",
      message: "Action Executor service bindingが設定されていません",
    };
  }
  const described = await describable.describe();
  if (Result.isFailure(described)) {
    return described.error.retriable
      ? { type: "retry", error: described.error }
      : {
          type: "terminal",
          status: "execution_failed",
          retriable: false,
          code: described.error.code,
          message: described.error.message,
        };
  }
  if (described.value.type === "not_registered") {
    return {
      type: "terminal",
      status: "execution_failed",
      retriable: false,
      code: "unknown_executor_key",
      message: `未対応のexecutorKeyです: ${String(executorKey)}`,
    };
  }
  return described.value;
}

async function runDescribeExecutorStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
}): Promise<ExecutorDescriptionStepResult> {
  try {
    return await input.step.do<ExecutorDescriptionStepResult>(
      "describe action executor",
      DESCRIBE_EXECUTOR_STEP_CONFIG,
      async () => {
        const transition = await describeExecutorStep(input);
        if (transition.type === "retry") return Promise.reject(transition.error);
        return transition;
      },
    );
  } catch (error) {
    // 実行前の失敗なので副作用は起きていない。
    return {
      type: "terminal",
      status: "execution_failed",
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

async function executeStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  authorizationEvidence: AuthorizationEvidence;
  guaranteeLevel: ActionExecutionGuaranteeLevel;
}): Promise<ExecutionTransition> {
  const loaded = await loadPlan(input.deps, input.params);
  if (loaded.type !== "found") return loaded;
  const invalidBinding = await validateApprovalBinding(input.deps, loaded.plan);
  if (invalidBinding) return invalidBinding;
  const executor = input.deps.actionExecutor(
    loaded.plan.action.definition.executorKey,
    input.guaranteeLevel,
  );
  if (!executor) {
    return {
      type: "terminal",
      status: "execution_failed",
      retriable: false,
      code: "action_executor_not_configured",
      message: "Action Executor service bindingが設定されていません",
    };
  }
  const idempotencyKey = createActionExecutionIdempotencyKey(
    loaded.plan.organizationId,
    loaded.plan.actionRequestId,
    loaded.plan.actionFingerprint,
  );
  const result = await executeAuthorizedAction({
    executor,
    organizationId: loaded.plan.organizationId,
    actionRequestId: loaded.plan.actionRequestId,
    actionFingerprint: loaded.plan.actionFingerprint,
    action: loaded.plan.action,
    authorizationEvidence: input.authorizationEvidence,
    actor: loaded.plan.evaluationSnapshot.actor,
  });
  if (Result.isFailure(result)) {
    // idempotentだけがstep.doのretryに委ねる。at-most-onceの一時障害はexecution_unknownで終端する。
    if (result.error.retriable && input.guaranteeLevel === "idempotent") {
      return { type: "retry", error: result.error };
    }
    return {
      type: "terminal",
      status: executorFailureStatus({
        retriable: result.error.retriable,
        guaranteeLevel: input.guaranteeLevel,
      }),
      guaranteeLevel: input.guaranteeLevel,
      idempotencyKey,
      retriable: result.error.retriable,
      code: result.error.code,
      message: result.error.message,
    };
  }
  if (result.value.type === "accepted") {
    return {
      type: "accepted",
      guaranteeLevel: result.value.guaranteeLevel,
      idempotencyKey: result.value.idempotencyKey,
      executionRef: result.value.executionRef,
    };
  }
  return {
    type: "executed",
    guaranteeLevel: result.value.guaranteeLevel,
    idempotencyKey: result.value.idempotencyKey,
    resultJson: JSON.stringify(result.value.result),
  };
}

async function runExecutionStep(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
  authorizationEvidence: PersistedAuthorizationEvidence;
  guaranteeLevel: ActionExecutionGuaranteeLevel;
}): Promise<ExecutionStepResult> {
  try {
    return await input.step.do<ExecutionStepResult>(
      "execute action",
      ACTION_EXECUTION_STEP_CONFIG[input.guaranteeLevel],
      async () => {
        const transition = await executeStep({
          deps: input.deps,
          params: input.params,
          authorizationEvidence: restoreAuthorizationEvidence(input.authorizationEvidence),
          guaranteeLevel: input.guaranteeLevel,
        });
        if (transition.type === "retry") return Promise.reject(transition.error);
        return transition;
      },
    );
  } catch (error) {
    // retry枯渇・timeout。at-most-onceでは副作用の有無が分からないためexecution_unknownにする。
    return {
      type: "terminal",
      status:
        input.guaranteeLevel === "best_effort_at_most_once"
          ? "execution_unknown"
          : "execution_failed",
      guaranteeLevel: input.guaranteeLevel,
      retriable: true,
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

function terminalResult(
  transition: TerminalTransition,
  authorizationEvidence?: AuthorizationEvidence,
): ActionExecutionWorkflowResult {
  return {
    type: "completed",
    status: transition.status,
    ...(transition.guaranteeLevel !== undefined
      ? { guaranteeLevel: transition.guaranteeLevel }
      : {}),
    ...(transition.idempotencyKey !== undefined
      ? { idempotencyKey: transition.idempotencyKey }
      : {}),
    ...(authorizationEvidence !== undefined ? { authorizationEvidence } : {}),
    ...(transition.retriable !== undefined ? { retriable: transition.retriable } : {}),
    code: transition.code,
    message: transition.message,
  };
}

export async function runActionExecution(input: {
  deps: ActionWorkflowDependencies;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
  evaluatedAt: string;
}): Promise<ActionExecutionWorkflowResult> {
  const reauthorization = await runReauthorizationStep(input);
  if (reauthorization.type === "failed") {
    return {
      type: "failed",
      code: reauthorization.code,
      message: reauthorization.message,
    };
  }
  if (reauthorization.type === "terminal") return terminalResult(reauthorization);

  const described = await runDescribeExecutorStep(input);
  if (described.type === "failed") {
    return { type: "failed", code: described.code, message: described.message };
  }
  if (described.type === "terminal") {
    return terminalResult(described, restoreAuthorizationEvidence(reauthorization.evidence));
  }

  const execution = await runExecutionStep({
    deps: input.deps,
    params: input.params,
    step: input.step,
    authorizationEvidence: reauthorization.evidence,
    guaranteeLevel: described.guaranteeLevel,
  });
  if (execution.type === "failed") {
    return {
      type: "failed",
      code: execution.code,
      message: execution.message,
    };
  }
  if (execution.type === "terminal") {
    return terminalResult(execution, restoreAuthorizationEvidence(reauthorization.evidence));
  }
  if (execution.type === "accepted") {
    return {
      type: "accepted",
      guaranteeLevel: execution.guaranteeLevel,
      idempotencyKey: execution.idempotencyKey,
      executionRef: execution.executionRef,
      authorizationEvidence: restoreAuthorizationEvidence(reauthorization.evidence),
    };
  }

  return {
    type: "completed",
    status: "executed",
    guaranteeLevel: execution.guaranteeLevel,
    idempotencyKey: execution.idempotencyKey,
    resultJson: execution.resultJson,
    authorizationEvidence: restoreAuthorizationEvidence(reauthorization.evidence),
  };
}
