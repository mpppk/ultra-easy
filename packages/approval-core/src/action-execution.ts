import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ActionRequest } from "./domain/action.ts";
import type { ActionFingerprint, ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { JsonValue } from "./domain/json.ts";
import type { PrincipalRef } from "./domain/principal.ts";
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
  /** Trusted actor captured by the ActionRequest boundary. Never populate from action.input. */
  actor?: PrincipalRef;
};

export type ActionExecutionResult = {
  status: "succeeded";
  output?: JsonValue;
};

/**
 * Executorの配送結果（#165）。
 * - completed: 同期executorが最終結果まで確定した（従来の`execute`と同じ意味）
 * - accepted: 外部 / durableな実行を開始したが最終結果は未確定。ActionRequestは`executing`に留まり、
 *   trusted completion port（`ActionExecutionCompletionService`）からの完了だけで終端する
 */
export type ActionExecutionDispatch =
  | { type: "completed"; result: ActionExecutionResult }
  | { type: "accepted"; executionRef: string };

export type ActionExecutionGuaranteeLevel = "idempotent" | "best_effort_at_most_once";

export type ActionExecutionTerminalStatus =
  | "executed"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed"
  /** at-most-onceのexecutorが一時障害で失敗し、外部副作用の有無が不明。人手でreconcileする。 */
  | "execution_unknown";

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

  /**
   * actionごとに保証が異なるexecutor（registry等）が、実際に委譲する先の保証を返す。
   * 未実装ならguaranteeLevelを使う。
   */
  guaranteeLevelFor?(action: MaterializedActionSnapshot): ActionExecutionGuaranteeLevel;

  execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError>;

  /**
   * 開始受付と最終完了が分離しうるexecutor（Composite Action / long-running job等, #165）。
   * 未実装のexecutorは同期executorとして`execute`の結果を`completed`に写像する。
   */
  dispatch?(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionDispatch, ActionExecutorError>;
}

/** executorへ配送する。同期executor（dispatch未実装）は従来通りcompletedになる。 */
export async function dispatchActionExecution(
  executor: ActionExecutor,
  request: ActionExecutionRequest,
): Result.ResultAsync<ActionExecutionDispatch, ActionExecutorError> {
  if (executor.dispatch) return executor.dispatch(request);
  const executed = await executor.execute(request);
  if (Result.isFailure(executed)) return executed;
  return Result.succeed({ type: "completed", result: executed.value });
}

/** registryに無いexecutorKey。成功扱いにせず非retriableなexecution_failedにする。 */
export function unknownExecutorKeyError(executorKey: string): ActionExecutorError {
  return new ActionExecutorError({
    code: "unknown_executor_key",
    retriable: false,
    detail: `未対応のexecutorKeyです: ${executorKey}`,
  });
}

/**
 * executorKeyごとの登録情報。承認不要の同期実行とWorkflow経路（service binding越し）の
 * どちらも同じregistryでdispatchし、executorKeyを取り違えないようにする。
 * guaranteeLevelは委譲先の値を返す（registry自体の既定値は最も弱いbest_effort）。
 */
export class ActionExecutorRegistry implements ActionExecutor {
  readonly guaranteeLevel: ActionExecutionGuaranteeLevel = "best_effort_at_most_once";

  constructor(private readonly delegates: Readonly<Record<string, ActionExecutor>>) {}

  lookup(executorKey: string): ActionExecutor | undefined {
    return Object.hasOwn(this.delegates, executorKey) ? this.delegates[executorKey] : undefined;
  }

  guaranteeLevelFor(action: MaterializedActionSnapshot): ActionExecutionGuaranteeLevel {
    const delegate = this.lookup(String(action.definition.executorKey));
    return delegate
      ? (delegate.guaranteeLevelFor?.(action) ?? delegate.guaranteeLevel)
      : this.guaranteeLevel;
  }

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const key = String(request.action.definition.executorKey);
    const delegate = this.lookup(key);
    if (!delegate) return Result.fail(unknownExecutorKeyError(key));
    return delegate.execute(request);
  }

  async dispatch(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionDispatch, ActionExecutorError> {
    const key = String(request.action.definition.executorKey);
    const delegate = this.lookup(key);
    if (!delegate) return Result.fail(unknownExecutorKeyError(key));
    return dispatchActionExecution(delegate, request);
  }
}

export function executorGuaranteeLevel(
  executor: ActionExecutor,
  action: MaterializedActionSnapshot,
): ActionExecutionGuaranteeLevel {
  return executor.guaranteeLevelFor?.(action) ?? executor.guaranteeLevel;
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
  | {
      /** async executorが受け付けた（#165）。最終結果はtrusted completionで確定する。 */
      type: "accepted";
      idempotencyKey: string;
      guaranteeLevel: ActionExecutionGuaranteeLevel;
      authorizationEvidence: AuthorizationEvidence;
      executionRef: string;
    }
  | Extract<ActionReauthorizationOutcome, { type: "authorization_revoked" }>;

export type ActionDispatchOutcome = Extract<
  ActionExecutionOutcome,
  { type: "executed" | "accepted" }
>;

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
  actor?: PrincipalRef;
}): Result.ResultAsync<ActionDispatchOutcome, ActionExecutorError> {
  const idempotencyKey = createActionExecutionIdempotencyKey(
    input.organizationId,
    input.actionRequestId,
    input.actionFingerprint,
  );
  const executed = await dispatchActionExecution(input.executor, {
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    actionFingerprint: input.actionFingerprint,
    idempotencyKey,
    action: input.action,
    authorizationEvidence: input.authorizationEvidence,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  if (Result.isFailure(executed)) return Result.fail(executed.error);

  const guaranteeLevel = executorGuaranteeLevel(input.executor, input.action);
  if (executed.value.type === "accepted") {
    return Result.succeed({
      type: "accepted",
      idempotencyKey,
      guaranteeLevel,
      authorizationEvidence: input.authorizationEvidence,
      executionRef: executed.value.executionRef,
    });
  }
  return Result.succeed({
    type: "executed",
    idempotencyKey,
    guaranteeLevel,
    authorizationEvidence: input.authorizationEvidence,
    result: executed.value.result,
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
    actor: input.request.actor,
  });
}
