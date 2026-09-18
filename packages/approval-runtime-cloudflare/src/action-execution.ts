import { Result } from "@praha/byethrow";
import type { WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import {
  executeAuthorizedAction,
  reauthorizeActionForExecution,
  type ActionRequest,
  type ApprovalPlanChecksum,
  type AuthorizationEvidence,
  type MaterializedApprovalPlan,
  type ActionRequestId,
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

type StepTransition<T> =
  | { type: "success"; value: T }
  | { type: "terminal"; status: ActionExecutionTerminalStatus; code: string; message: string }
  | { type: "failed"; code: string; message: string }
  | { type: "retry"; error: Error };

type PersistedStepTransition<T> = Exclude<StepTransition<T>, { type: "retry" }>;

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
): Promise<
  | { type: "found"; plan: MaterializedApprovalPlan }
  | Extract<StepTransition<never>, { type: "failed" | "retry" }>
> {
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

async function runRetryingStep<T>(
  step: WorkflowStep,
  name: string,
  exhaustedStatus: Extract<
    ActionExecutionTerminalStatus,
    "authorization_check_failed" | "execution_failed"
  >,
  callback: () => Promise<StepTransition<T>>,
): Promise<PersistedStepTransition<T>> {
  try {
    return await step.do(name, async () => {
      const transition = await callback();
      if (transition.type === "retry") return Promise.reject(transition.error);
      return transition;
    });
  } catch (error) {
    return {
      type: "terminal",
      status: exhaustedStatus,
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

async function reauthorizeStep(input: {
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  evaluatedAt: string;
}): Promise<StepTransition<AuthorizationEvidence>> {
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
  return { type: "success", value: result.value.authorizationEvidence };
}

async function executeStep(input: {
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  authorizationEvidence: AuthorizationEvidence;
}): Promise<StepTransition<Extract<ActionExecutionTerminalStatus, "executed">>> {
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
  return { type: "success", value: "executed" };
}

function asWorkflowResult<T>(
  transition: PersistedStepTransition<T>,
): ActionExecutionWorkflowResult | null {
  if (transition.type === "failed") {
    return { type: "failed", code: transition.code, message: transition.message };
  }
  if (transition.type === "terminal") {
    return {
      type: "completed",
      status: transition.status,
      code: transition.code,
      message: transition.message,
    };
  }
  return null;
}

export async function runActionExecution(input: {
  env: ActionExecutionWorkflowEnv;
  params: ActionExecutionWorkflowParams;
  step: WorkflowStep;
  evaluatedAt: string;
}): Promise<ActionExecutionWorkflowResult> {
  const reauthorization = await runRetryingStep(
    input.step,
    "reauthorize action",
    "authorization_check_failed",
    () =>
      reauthorizeStep({
        env: input.env,
        params: input.params,
        evaluatedAt: input.evaluatedAt,
      }),
  );
  const reauthorizationResult = asWorkflowResult(reauthorization);
  if (reauthorizationResult) return reauthorizationResult;

  const execution = await runRetryingStep(input.step, "execute action", "execution_failed", () =>
    executeStep({
      env: input.env,
      params: input.params,
      authorizationEvidence: reauthorization.value,
    }),
  );
  const executionResult = asWorkflowResult(execution);
  if (executionResult) return executionResult;

  return { type: "completed", status: execution.value };
}
