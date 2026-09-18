import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ActionRequest } from "./domain/action.ts";
import type { ActionFingerprint, ActionRequestId } from "./domain/brand.ts";
import type { JsonValue } from "./domain/json.ts";
import type { MaterializedActionSnapshot } from "./materialization.ts";
import {
  reauthorizeActionRequest,
  type ActionAuthorizer,
  type AuthorizationEvidence,
  type AuthorizationProviderError,
} from "./authorization.ts";

export type ActionExecutionRequest = {
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

export type ActionExecutionOutcome =
  | {
      type: "executed";
      idempotencyKey: string;
      authorizationEvidence: AuthorizationEvidence;
      result: ActionExecutionResult;
    }
  | {
      type: "authorization_revoked";
      code: string;
      reason: string;
    };

export function createActionExecutionIdempotencyKey(
  actionRequestId: ActionRequestId,
  actionFingerprint: ActionFingerprint,
): string {
  return `${String(actionRequestId)}:${String(actionFingerprint)}`;
}

/**
 * Approval有無に依存しない最終Action実行経路。
 *
 * 実行直前に必ずhigher consistencyで再認可し、denyならExecutorを呼ばない。
 * Authorization provider failureとExecutor failureはFailure値として区別する。
 */
export async function executeActionRequest(input: {
  authorizer: ActionAuthorizer;
  executor: ActionExecutor;
  actionRequestId: ActionRequestId;
  request: ActionRequest;
  actionFingerprint: ActionFingerprint;
  action: MaterializedActionSnapshot;
  evaluatedAt: string;
}): Result.ResultAsync<ActionExecutionOutcome, ActionExecutionFailure> {
  const authorization = await reauthorizeActionRequest({
    authorizer: input.authorizer,
    request: input.request,
    evaluatedAt: input.evaluatedAt,
  });
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

  const idempotencyKey = createActionExecutionIdempotencyKey(
    input.actionRequestId,
    input.actionFingerprint,
  );
  const executed = await input.executor.execute({
    actionRequestId: input.actionRequestId,
    actionFingerprint: input.actionFingerprint,
    idempotencyKey,
    action: input.action,
    authorizationEvidence: authorization.value.evidence,
  });
  if (Result.isFailure(executed)) return Result.fail(executed.error);

  return Result.succeed({
    type: "executed",
    idempotencyKey,
    authorizationEvidence: authorization.value.evidence,
    result: executed.value,
  });
}
