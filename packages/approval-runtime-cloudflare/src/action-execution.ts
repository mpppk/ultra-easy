import { Result } from "@praha/byethrow";
import type { WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  executeAuthorizedAction,
  reauthorizeActionForExecution,
  type ActionRequest,
  type ActionRequestId,
  type ApprovalPlanChecksum,
  type AuthorityMode,
  type AuthorizationConsistency,
  type AuthorizationEvidence,
  type DelegationGrantId,
  type MaterializedApprovalPlan,
} from "@app/approval-core";
import { D1MaterializedPlanRepository } from "@app/approval-d1";

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
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
};

type TerminalTransition = {
  type: "terminal";
  status: ActionExecutionTerminalStatus;
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
  | { type: "executed" }
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

async function reauthorizeStep(input: {
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  evaluatedAt: string;
}): Promise<ReauthorizationTransition> {
  const loaded = await loadPlan(input.env, input.params);
  if (loaded.type !== "found") return loaded;
  if (!input.env.ACTION_AUTHORIZER) {
    return {
      type: "terminal",
      status: "authorization_check_failed",
      code: "action_authorizer_not_configured",
      message: "Action Authorization service bindingが設定されていません",
    };
  }

  const result = await reauthorizeActionForExecution({
    authorizer: new ServiceBindingActionAuthorizer(input.env.ACTION_AUTHORIZER),
    request: requestFromPlan(loaded.plan),
    evaluatedAt: input.evaluatedAt,
  });
  if (Result.isFailure(result)) {
    return result.error.retriable
      ? { type: "retry", error: result.error }
      : {
          type: "terminal",
          status: "authorization_check_failed",
          code: result.error.code,
          message: result.error.message,
        };
  }
  if (result.value.type === "authorization_revoked") {
    return {
      type: "terminal",
      status: "authorization_revoked",
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
  if (!input.env.ACTION_EXECUTOR) {
    return {
      type: "terminal",
      status: "execution_failed",
      code: "action_executor_not_configured",
      message: "Action Executor service bindingが設定されていません",
    };
  }

  const result = await executeAuthorizedAction({
    executor: new ServiceBindingActionExecutor(
      input.env.ACTION_EXECUTOR,
      loaded.plan.action.definition.executorKey,
    ),
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
          code: result.error.code,
          message: result.error.message,
        };
  }
  return { type: "executed" };
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

function terminalResult(transition: TerminalTransition): ActionExecutionWorkflowResult {
  return {
    type: "completed",
    status: transition.status,
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
  if (execution.type === "terminal") return terminalResult(execution);

  return { type: "completed", status: "executed" };
}
