import { Result } from "@praha/byethrow";

import {
  ActionExecutorError,
  AuthorizationProviderError,
  type ActionAuthorizer,
  type ActionExecutionGuaranteeLevel,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
  type AuthorizationConsistency,
  type AuthorizationDecision,
  type ExecutorKey,
  type ActionRequestId,
  type JsonValue,
  type OrganizationId,
} from "@app/approval-core";
import type { ActionRequest } from "@app/approval-core";

export interface ActionServiceBinding {
  fetch(input: Request): Promise<Response>;
}

type ErrorResponse = {
  code?: unknown;
  retriable?: unknown;
  detail?: unknown;
  details?: unknown;
};

const fetchBinding = Result.fn({
  try: async (input: { binding: ActionServiceBinding; request: Request }): Promise<Response> =>
    input.binding.fetch(input.request),
  catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
});

const parseJson = Result.fn({
  try: async (response: Response): Promise<unknown> => response.json(),
  catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
});

function defaultRetriable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function errorResponse(value: unknown): ErrorResponse {
  return typeof value === "object" && value !== null ? (value as ErrorResponse) : {};
}

function responseCode(value: ErrorResponse, fallback: string): string {
  return typeof value.code === "string" ? value.code : fallback;
}

function responseDetail(value: ErrorResponse, fallback: string): string {
  return typeof value.detail === "string" ? value.detail : fallback;
}

function responseRetriable(value: ErrorResponse, status: number): boolean {
  return typeof value.retriable === "boolean" ? value.retriable : defaultRetriable(status);
}

/**
 * Application側のActionAuthorizerへService Binding経由で委譲するadapter。
 * Generic Workflowはaction type→relation等のapplication固有mappingを知らない。
 */
export class ServiceBindingActionAuthorizer implements ActionAuthorizer {
  constructor(
    private readonly binding: ActionServiceBinding,
    private readonly organizationId: OrganizationId,
    private readonly actionRequestId?: ActionRequestId,
  ) {}

  async check(input: {
    request: ActionRequest;
    evaluatedAt: string;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<AuthorizationDecision, AuthorizationProviderError> {
    const fetched = await fetchBinding({
      binding: this.binding,
      request: new Request("https://action-authorizer.internal/check", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ue-organization-id": String(this.organizationId),
          ...(this.actionRequestId
            ? {
                "x-ue-action-request-id": String(this.actionRequestId),
                "x-ue-correlation-id": String(this.actionRequestId),
              }
            : {}),
        },
        body: JSON.stringify({ ...input, organizationId: this.organizationId }),
      }),
    });
    if (Result.isFailure(fetched)) {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "service_binding",
          code: "authorization_service_unavailable",
          retriable: true,
          detail: fetched.error.message,
          cause: fetched.error,
        }),
      );
    }

    const parsed = await parseJson(fetched.value);
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "service_binding",
          code: "invalid_authorization_response",
          retriable: defaultRetriable(fetched.value.status),
          detail: parsed.error.message,
          cause: parsed.error,
        }),
      );
    }

    if (!fetched.value.ok) {
      const error = errorResponse(parsed.value);
      return Result.fail(
        new AuthorizationProviderError({
          provider: "service_binding",
          code: responseCode(error, `authorization_http_${fetched.value.status}`),
          retriable: responseRetriable(error, fetched.value.status),
          detail: responseDetail(
            error,
            `Action Authorization service returned HTTP ${fetched.value.status}`,
          ),
        }),
      );
    }

    if (typeof parsed.value !== "object" || parsed.value === null || !("type" in parsed.value)) {
      return Result.fail(
        new AuthorizationProviderError({
          provider: "service_binding",
          code: "invalid_authorization_response",
          retriable: false,
          detail: "Authorization responseにtypeがありません",
        }),
      );
    }

    const value = parsed.value as Record<string, unknown>;
    if (
      value.type === "deny" &&
      typeof value.code === "string" &&
      typeof value.reason === "string"
    ) {
      return Result.succeed({ type: "deny", code: value.code, reason: value.reason });
    }
    if (value.type === "allow") {
      const evidence =
        typeof value.evidence === "object" && value.evidence !== null
          ? (value.evidence as Record<string, unknown>)
          : {};
      return Result.succeed({
        type: "allow",
        evidence: {
          evaluatedAt: input.evaluatedAt,
          consistency: input.consistency,
          ...(typeof evidence.provider === "string" ? { provider: evidence.provider } : {}),
          ...(typeof evidence.contextChecksum === "string"
            ? { contextChecksum: evidence.contextChecksum }
            : {}),
          ...(typeof evidence.authorizationModelId === "string"
            ? { authorizationModelId: evidence.authorizationModelId }
            : {}),
        },
      });
    }

    return Result.fail(
      new AuthorizationProviderError({
        provider: "service_binding",
        code: "invalid_authorization_response",
        retriable: false,
        detail: "Authorization responseがallow/deny contractを満たしていません",
      }),
    );
  }
}

/**
 * Materialized Action DefinitionのexecutorKeyをService Bindingのpathへ投影するadapter。
 * Downstream Workerがexecutor registryとしてdispatchする。
 */
export class ServiceBindingActionExecutor implements ActionExecutor {
  constructor(
    private readonly binding: ActionServiceBinding,
    private readonly executorKey: ExecutorKey,
    readonly guaranteeLevel: ActionExecutionGuaranteeLevel = "best_effort_at_most_once",
  ) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const fetched = await fetchBinding({
      binding: this.binding,
      request: new Request(
        `https://action-executor.internal/execute/${encodeURIComponent(String(this.executorKey))}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": request.idempotencyKey,
            "x-ue-organization-id": String(request.organizationId),
            "x-ue-action-request-id": String(request.actionRequestId),
            "x-ue-correlation-id": String(request.actionRequestId),
          },
          body: JSON.stringify(request),
        },
      ),
    });
    if (Result.isFailure(fetched)) {
      return Result.fail(
        new ActionExecutorError({
          code: "executor_service_unavailable",
          retriable: true,
          detail: fetched.error.message,
          cause: fetched.error,
        }),
      );
    }

    const parsed = await parseJson(fetched.value);
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new ActionExecutorError({
          code: "invalid_executor_response",
          retriable: defaultRetriable(fetched.value.status),
          detail: parsed.error.message,
          cause: parsed.error,
        }),
      );
    }

    if (!fetched.value.ok) {
      const error = errorResponse(parsed.value);
      return Result.fail(
        new ActionExecutorError({
          code: responseCode(error, `executor_http_${fetched.value.status}`),
          retriable: responseRetriable(error, fetched.value.status),
          detail: responseDetail(
            error,
            `Action Executor service returned HTTP ${fetched.value.status}`,
          ),
          ...(error.details !== undefined ? { details: error.details as JsonValue } : {}),
        }),
      );
    }

    if (
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      !("status" in parsed.value) ||
      parsed.value.status !== "succeeded"
    ) {
      return Result.fail(
        new ActionExecutorError({
          code: "invalid_executor_response",
          retriable: false,
          detail: "Action Executor responseがstatus=succeeded contractを満たしていません",
        }),
      );
    }

    const output = "output" in parsed.value ? (parsed.value.output as JsonValue) : undefined;
    return Result.succeed({
      status: "succeeded",
      ...(output !== undefined ? { output } : {}),
    });
  }
}
