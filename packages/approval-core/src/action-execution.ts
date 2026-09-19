import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ActionRequest } from "./domain/action.ts";
import type { ActionFingerprint, ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { JsonValue } from "./domain/json.ts";
import type { ApprovalRuntimeState } from "./interpreter/types.ts";
import type { MaterializedActionSnapshot, MaterializedApprovalPlan } from "./materialization.ts";
import {
  reauthorizeActionRequest,
  type ActionAuthorizer,
  type AuthorizationEvidence,
  type AuthorizationProviderError,
} from "./authorization.ts";

export type ActionExecutionRequest = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  idempotencyKey: string;
  action: MaterializedActionSnapshot;
  authorizationEvidence: AuthorizationEvidence;
};

export type ActionExecutionResult = {
  status: "succeeded";
  output?: JsonValue;
};

export type ActionExecutionGuaranteeLevel = "idempotent" | "best_effort_at_most_once";

export type ActionExecutionTerminalStatus =
  | "executed"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed";

const ActionExecutorErrorBase = ErrorFactory({
  name: "ActionExecutorError",
  message: ({ code, detail }) => `Action実行に失敗しました [${code}]: ${detail}`,
  fields: ErrorFactory.fields<{
    code: string;
    retriable: boolean;
    detail: string;
    details?: JsonValue;
  }>(),
});

export class ActionExecutorError extends ActionExecutorErrorBase {
  constructor(options: {
    code: string;
    retriable: boolean;
    detail: string;
    details?: JsonValue;
    cause?: Error;
  }) {
    super({
      code: options.code,
      retriable: options.retriable,
      detail: options.detail,
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.cause ? { cause: options.cause } : {}),
    });
  }
}

export interface ActionExecutor {
  /**
   * 外部side effectが提供する再実行保証。
   * local projectionの存在だけでexactly-onceへ昇格させてはならない。
   */
  readonly guaranteeLevel: ActionExecutionGuaranteeLevel;

  execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError>;
}

const ActionAuthorizationCheckFailedErrorBase = ErrorFactory({
  name: "ActionAuthorizationCheckFailedError",
  message: ({ provider, providerCode, detail }) =>
    `Action実行直前のAuthorization再確認に失敗しました [${provider}/${providerCode}]: ${detail}`,
  fields: ErrorFactory.fields<{
    code: "authorization_check_failed";
    retriable: boolean;
    provider: string;
    providerCode: string;
    detail: string;
  }>(),
});

export class ActionAuthorizationCheckFailedError extends ActionAuthorizationCheckFailedErrorBase {
  constructor(error: AuthorizationProviderError) {
    super({
      code: "authorization_check_failed",
      retriable: error.retriable,
      provider: error.provider,
      providerCode: error.code,
      detail: error.detail,
      cause: error,
    });
  }
}

export type ActionExecutionFailure = ActionAuthorizationCheckFailedError | ActionExecutorError;

const ActionApprovalBindingMismatchErrorBase = ErrorFactory({
  name: "ActionApprovalBindingMismatchError",
  message: ({ expected, actual }) =>
    `Approval bindingが実行対象と一致しません: expected=${expected}, actual=${actual}`,
  fields: ErrorFactory.fields<{
    code: "approval_binding_mismatch";
    expected: string;
    actual: string;
  }>(),
});

export class ActionApprovalBindingMismatchError extends ActionApprovalBindingMismatchErrorBase {}

export function validateApprovalBindingForExecution(input: {
  plan: MaterializedApprovalPlan;
  state: ApprovalRuntimeState | null;
}): Result.Result<void, ActionApprovalBindingMismatchError> {
  if (input.plan.flow.type === "none") return Result.succeed(undefined);

  if (!input.state) {
    return Result.fail(
      new ActionApprovalBindingMismatchError({
        code: "approval_binding_mismatch",
        expected: String(input.plan.approvalBindingFingerprint),
        actual: "missing_runtime_projection",
      }),
    );
  }

  if (
    String(input.state.actionRequestId) !== String(input.plan.actionRequestId) ||
    String(input.state.approvalPlanChecksum) !== String(input.plan.approvalPlanChecksum) ||
    input.state.status !== "approved"
  ) {
    return Result.fail(
      new ActionApprovalBindingMismatchError({
        code: "approval_binding_mismatch",
        expected: String(input.plan.approvalBindingFingerprint),
        actual: "runtime_projection_not_approved_for_plan",
      }),
    );
  }

  for (const task of input.state.tasks) {
    for (const decision of task.decisions) {
      const actual = decision.approvalBindingFingerprint;
      if (
        actual === undefined ||
        String(actual) !== String(input.plan.approvalBindingFingerprint)
      ) {
        return Result.fail(
          new ActionApprovalBindingMismatchError({
            code: "approval_binding_mismatch",
            expected: String(input.plan.approvalBindingFingerprint),
            actual: actual === undefined ? "missing_decision_binding" : String(actual),
          }),
        );
      }
    }
  }

  return Result.succeed(undefined);
}

export type ActionReauthorizationOutcome =
  | {
      type: "authorized";
      authorizationEvidence: AuthorizationEvidence;
    }
  | {
      type: "authorization_revoked";
      code: string;
      reason: string;
    };

export type ActionExecutionOutcome =
  | {
      type: "executed";
      idempotencyKey: string;
      guaranteeLevel: ActionExecutionGuaranteeLevel;
      authorizationEvidence: AuthorizationEvidence;
      result: ActionExecutionResult;
    }
  | Extract<ActionReauthorizationOutcome, { type: "authorization_revoked" }>;

export function createActionExecutionIdempotencyKey(
  organizationId: OrganizationId,
  actionRequestId: ActionRequestId,
  actionFingerprint: ActionFingerprint,
): string {
  return `ue:v1:${encodeURIComponent(String(organizationId))}:${encodeURIComponent(
    String(actionRequestId),
  )}:${encodeURIComponent(String(actionFingerprint))}`;
}

/** Durable runtimeからRe-Authorizationを独立stepとして実行できるphase。 */
export async function reauthorizeActionForExecution(input: {
  authorizer: ActionAuthorizer;
  request: ActionRequest;
  evaluatedAt: string;
}): Result.ResultAsync<ActionReauthorizationOutcome, ActionAuthorizationCheckFailedError> {
  const authorization = await reauthorizeActionRequest(input);
  if (Result.isFailure(authorization)) {
    return Result.fail(new ActionAuthorizationCheckFailedError(authorization.error));
  }
  if (authorization.value.type === "deny") {
    return Result.succeed({
      type: "authorization_revoked",
      code: authorization.value.code,
      reason: authorization.value.reason,
    });
  }
  return Result.succeed({
    type: "authorized",
    authorizationEvidence: authorization.value.evidence,
  });
}

/** Durable runtimeから外部side effectを独立stepとしてretryできるphase。 */
export async function executeAuthorizedAction(input: {
  executor: ActionExecutor;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  action: MaterializedActionSnapshot;
  authorizationEvidence: AuthorizationEvidence;
}): Result.ResultAsync<Extract<ActionExecutionOutcome, { type: "executed" }>, ActionExecutorError> {
  const idempotencyKey = createActionExecutionIdempotencyKey(
    input.organizationId,
    input.actionRequestId,
    input.actionFingerprint,
  );
  const executed = await input.executor.execute({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    actionFingerprint: input.actionFingerprint,
    idempotencyKey,
    action: input.action,
    authorizationEvidence: input.authorizationEvidence,
  });
  if (Result.isFailure(executed)) return Result.fail(executed.error);

  return Result.succeed({
    type: "executed",
    idempotencyKey,
    guaranteeLevel: input.executor.guaranteeLevel,
    authorizationEvidence: input.authorizationEvidence,
    result: executed.value,
  });
}

/**
 * Approval有無に依存しない最終Action実行経路。
 *
 * Durable runtimeはphase単位でretry境界を持てるよう、
 * reauthorizeActionForExecution / executeAuthorizedActionを直接利用できる。
 */
export async function executeActionRequest(input: {
  authorizer: ActionAuthorizer;
  executor: ActionExecutor;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  request: ActionRequest;
  actionFingerprint: ActionFingerprint;
  action: MaterializedActionSnapshot;
  evaluatedAt: string;
}): Result.ResultAsync<ActionExecutionOutcome, ActionExecutionFailure> {
  const authorization = await reauthorizeActionForExecution({
    authorizer: input.authorizer,
    request: input.request,
    evaluatedAt: input.evaluatedAt,
  });
  if (Result.isFailure(authorization)) return authorization;
  if (authorization.value.type === "authorization_revoked") {
    return Result.succeed(authorization.value);
  }

  return executeAuthorizedAction({
    executor: input.executor,
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    actionFingerprint: input.actionFingerprint,
    action: input.action,
    authorizationEvidence: authorization.value.authorizationEvidence,
  });
}
