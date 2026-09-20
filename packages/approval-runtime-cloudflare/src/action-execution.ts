import { Result } from "@praha/byethrow";
import type { WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  createActionExecutionIdempotencyKey,
  executeAuthorizedAction,
  reauthorizeActionForExecution,
  validateApprovalBindingForExecution,
  type ActionExecutionGuaranteeLevel,
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
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
} from "@app/approval-d1";

import {
  ServiceBindingActionAuthorizer,
  ServiceBindingActionExecutor,
  type ActionServiceBinding,
} from "./service-binding.ts";

export type ActionExecutionTerminalStatus =
  | "executed"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed";

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
      type: "failed";
      code: string;
      message: string;
    };

export type ActionExecutionWorkflowEnv = {
  DB: D1Database;
  ACTION_AUTHORIZER?: ActionServiceBinding;
  ACTION_EXECUTOR?: ActionServiceBinding;
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
  delegationGrantIds?: string[];
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
  | TerminalTransition
  | FailedTransition
  | RetryTransition;

type ExecutionStepResult = Exclude<ExecutionTransition, RetryTransition>;

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
      ? { delegationGrantIds: evidence.delegationGrantIds.map(String) }
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
          delegationGrantIds: evidence.delegationGrantIds.map(
            (grantId) => grantId as DelegationGrantId,
          ),
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
  env: ActionExecutionWorkflowEnv,
  params: ActionExecutionWorkflowParams,
): Promise<{ type: "found"; plan: MaterializedApprovalPlan } | FailedTransition | RetryTransition> {
  const loaded = await new D1MaterializedPlanRepository(env.DB).loadForWorkflow({
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
  env: ActionExecutionWorkflowEnv,
  plan: MaterializedApprovalPlan,
): Promise<FailedTransition | RetryTransition | null> {
  if (plan.flow.type === "none") return null;

  const projection = await new D1ApprovalRuntimeProjectionRepository(env.DB).load({
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
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  evaluatedAt: string;
}): Promise<ReauthorizationTransition> {
  const loaded = await loadPlan(input.env, input.params);
  if (loaded.type !== "found") return loaded;
  const invalidBinding = await validateApprovalBinding(input.env, loaded.plan);
  if (invalidBinding) return invalidBinding;
  if (!input.env.ACTION_AUTHORIZER) {
    return {
      type: "terminal",
      status: "authorization_check_failed",
      retriable: false,
      code: "action_authorizer_not_configured",
      message: "Action Authorization service bindingが設定されていません",
    };
  }

  const result = await reauthorizeActionForExecution({
    authorizer: new ServiceBindingActionAuthorizer(
      input.env.ACTION_AUTHORIZER,
      loaded.plan.organizationId,
    ),
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
  env: ActionExecutionWorkflowEnv;
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

async function executeStep(input: {
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  authorizationEvidence: AuthorizationEvidence;
}): Promise<ExecutionTransition> {
  const loaded = await loadPlan(input.env, input.params);
  if (loaded.type !== "found") return loaded;
  const invalidBinding = await validateApprovalBinding(input.env, loaded.plan);
  if (invalidBinding) return invalidBinding;
  if (!input.env.ACTION_EXECUTOR) {
    return {
      type: "terminal",
      status: "execution_failed",
      retriable: false,
      code: "action_executor_not_configured",
      message: "Action Executor service bindingが設定されていません",
    };
  }

  const executor = new ServiceBindingActionExecutor(
    input.env.ACTION_EXECUTOR,
    loaded.plan.action.definition.executorKey,
  );
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
  });
  if (Result.isFailure(result)) {
    return result.error.retriable
      ? { type: "retry", error: result.error }
      : {
          type: "terminal",
          status: "execution_failed",
          guaranteeLevel: executor.guaranteeLevel,
          idempotencyKey,
          retriable: false,
          code: result.error.code,
          message: result.error.message,
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
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
  authorizationEvidence: PersistedAuthorizationEvidence;
}): Promise<ExecutionStepResult> {
  try {
    return await input.step.do<ExecutionStepResult>("execute action", async () => {
      const transition = await executeStep({
        env: input.env,
        params: input.params,
        authorizationEvidence: restoreAuthorizationEvidence(input.authorizationEvidence),
      });
      if (transition.type === "retry") return Promise.reject(transition.error);
      return transition;
    });
  } catch (error) {
    return {
      type: "terminal",
      status: "execution_failed",
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
  env: ActionExecutionWorkflowEnv;
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

  const execution = await runExecutionStep({
    env: input.env,
    params: input.params,
    step: input.step,
    authorizationEvidence: reauthorization.evidence,
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

  return {
    type: "completed",
    status: "executed",
    guaranteeLevel: execution.guaranteeLevel,
    idempotencyKey: execution.idempotencyKey,
    resultJson: execution.resultJson,
    authorizationEvidence: restoreAuthorizationEvidence(reauthorization.evidence),
  };
}
