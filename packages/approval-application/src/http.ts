import { Result } from "@praha/byethrow";

import {
  DEFAULT_ACTION_REQUEST_RATE_LIMIT,
  actionCorrelation,
  safeLogRecord,
} from "@app/approval-core";
import type {
  Action,
  ActionType,
  OrganizationId,
  RateLimiter,
  RateLimitPolicy,
  ResourceId,
  TelemetrySink,
  ResourceType,
} from "@app/approval-core";

import {
  ActionRequestApplicationError,
  type ActionRequestApplicationService,
  type TrustedActionRequestContext,
} from "./action-request-service.ts";
import { pathParameters } from "./path-parameters.ts";

export class HttpTrustedContextError extends Error {
  readonly name = "HttpTrustedContextError";

  constructor(
    readonly status: 401 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpTrustedContextProvider {
  resolve(input: {
    request: Request;
    organizationId: OrganizationId;
    delegationGrantId?: string;
    clientReference?: string;
  }): Result.ResultAsync<TrustedActionRequestContext, HttpTrustedContextError>;
}

export type ActionRequestCreateBody = {
  action: Action;
  delegationGrantId?: string;
  clientReference?: string;
};

export function actionRequestProblem(input: {
  status: number;
  code: string;
  title: string;
  detail?: string;
  actionRequestId?: string;
  headers?: HeadersInit;
}): Response {
  const headers = new Headers(input.headers);
  headers.set("content-type", "application/problem+json");
  return new Response(
    JSON.stringify({
      type: `urn:ultra-easy:problem:${input.code}`,
      title: input.title,
      status: input.status,
      code: input.code,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.actionRequestId ? { actionRequestId: input.actionRequestId } : {}),
    }),
    {
      status: input.status,
      headers,
    },
  );
}

export function actionRequestJson(value: unknown, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function parseActionRequestCreateBody(value: unknown): ActionRequestCreateBody | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["action", "delegationGrantId", "clientReference"])) {
    return null;
  }
  if (!isRecord(value.action) || !hasOnlyKeys(value.action, ["type", "resource", "input"])) {
    return null;
  }

  const action = value.action;
  if (
    typeof action.type !== "string" ||
    action.type.length === 0 ||
    !isRecord(action.resource) ||
    !hasOnlyKeys(action.resource, ["type", "id"]) ||
    typeof action.resource.type !== "string" ||
    action.resource.type.length === 0 ||
    typeof action.resource.id !== "string" ||
    action.resource.id.length === 0 ||
    !isRecord(action.input)
  ) {
    return null;
  }

  if (
    value.delegationGrantId !== undefined &&
    (typeof value.delegationGrantId !== "string" || value.delegationGrantId.length === 0)
  ) {
    return null;
  }
  if (
    value.clientReference !== undefined &&
    (typeof value.clientReference !== "string" || value.clientReference.length > 255)
  ) {
    return null;
  }

  return {
    action: {
      type: action.type as ActionType,
      resource: {
        type: action.resource.type as ResourceType,
        id: action.resource.id as ResourceId,
      },
      input: action.input,
    },
    ...(typeof value.delegationGrantId === "string"
      ? { delegationGrantId: value.delegationGrantId }
      : {}),
    ...(typeof value.clientReference === "string"
      ? { clientReference: value.clientReference }
      : {}),
  };
}

/**
 * ActionRequestApplicationErrorCodeからHTTP statusへの対応表（#93）。
 * - 利用者の入力誤り: 4xx（未知のaction type・input不正は422、重複は409）
 * - 依存サービス障害: retriableなら503、それ以外（設定不備等）は500
 * - 契約違反・設定不備（schema未登録、prepared改変）: 500
 * immediate executionの失敗はActionRequestが終端済みのため422（再試行しても結果は変わらない）。
 */
export function actionRequestErrorStatus(error: ActionRequestApplicationError): number {
  switch (error.code) {
    case "action_type_not_found":
    case "action_input_validation_failed":
    case "action_input_not_object":
    case "policy_evaluation_failed":
    case "materialization_failed":
    case "execution_failed":
      return 422;
    case "action_request_already_exists":
      return 409;
    case "schema_not_found":
    case "prepared_action_request_invalid":
      return 500;
    case "action_definition_resolution_failed":
    case "schema_resolution_failed":
    case "authorization_provider_failed":
    case "policy_binding_resolution_failed":
    case "plan_persistence_failed":
    case "audit_persistence_failed":
    case "workflow_start_failed":
      return error.retriable ? 503 : 500;
  }
}

/** 利用者へ返してよいdetail。依存サービスや例外のmessageは返さない（error codeで識別する）。 */
function safeActionRequestErrorDetail(error: ActionRequestApplicationError): string | undefined {
  switch (error.code) {
    case "action_input_validation_failed":
    case "action_type_not_found":
      return error.message;
    case "execution_failed":
      return "Actionの実行に失敗しました。結果はActionRequestを取得して確認してください";
    default:
      return undefined;
  }
}

export function actionRequestApplicationErrorResponse(
  error: ActionRequestApplicationError,
): Response {
  const status = actionRequestErrorStatus(error);
  const detail = safeActionRequestErrorDetail(error);
  return actionRequestProblem({
    status,
    code: error.code,
    title:
      status === 503
        ? "依存サービスを利用できません"
        : status >= 500
          ? "ActionRequestを処理できません（内部エラー）"
          : status === 409
            ? "ActionRequestの状態が競合しました"
            : "ActionRequestを処理できません",
    ...(detail !== undefined ? { detail } : {}),
  });
}

export function createActionRequestHttpApi(input: {
  service: ActionRequestApplicationService;
  trustedContextProvider: HttpTrustedContextProvider;
  rateLimiter?: RateLimiter;
  rateLimitPolicy?: RateLimitPolicy;
  telemetry?: TelemetrySink;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = pathParameters(/^\/v1\/organizations\/([^/]+)\/action-requests$/, url.pathname);
      if (match instanceof Response) return match;
      if (request.method !== "POST" || !match?.[1]) {
        return new Response("Not Found", { status: 404 });
      }

      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length > 255) {
        return actionRequestProblem({
          status: 400,
          code: "invalid_idempotency_key",
          title: "Idempotency-Keyが必要です",
        });
      }

      const parsedJson = await request.json().catch(() => null);
      const body = parseActionRequestCreateBody(parsedJson);
      if (!body) {
        return actionRequestProblem({
          status: 400,
          code: "invalid_action_request",
          title: "ActionRequest bodyが不正です",
        });
      }

      const organizationId = match[1] as OrganizationId;
      const trusted = await input.trustedContextProvider.resolve({
        request,
        organizationId,
        ...(body.delegationGrantId ? { delegationGrantId: body.delegationGrantId } : {}),
        ...(body.clientReference ? { clientReference: body.clientReference } : {}),
      });
      if (Result.isFailure(trusted)) {
        return actionRequestProblem({
          status: trusted.error.status,
          code: trusted.error.code,
          title: trusted.error.status === 401 ? "Authentication required" : "Forbidden",
          detail: trusted.error.message,
        });
      }

      if (input.rateLimiter) {
        const limited = await input.rateLimiter.consume({
          organizationId,
          principal: trusted.value.actor,
          operation: "action_request.submit",
          policy: input.rateLimitPolicy ?? DEFAULT_ACTION_REQUEST_RATE_LIMIT,
          now: trusted.value.now,
        });
        if (Result.isFailure(limited)) {
          return actionRequestProblem({
            status: 503,
            code: limited.error.code,
            title: "Rate limit service unavailable",
          });
        }
        if (!limited.value.allowed) {
          return actionRequestProblem({
            status: 429,
            code: "rate_limit_exceeded",
            title: "Too Many Requests",
            headers: {
              "retry-after": String(limited.value.retryAfterSeconds),
              "x-ratelimit-limit": String(limited.value.limit),
              "x-ratelimit-remaining": String(limited.value.remaining),
              "x-ratelimit-reset": limited.value.resetAt,
            },
          });
        }
      }

      const submitted = await input.service.submit({
        action: body.action,
        trustedContext: trusted.value,
        idempotencyKey,
        ...(body.clientReference ? { clientReference: body.clientReference } : {}),
      });
      if (Result.isFailure(submitted))
        return actionRequestApplicationErrorResponse(submitted.error);

      if (submitted.value.type === "authorization_denied") {
        input.telemetry?.emit(
          safeLogRecord({
            level: "warn",
            event: "request.denied",
            correlation: actionCorrelation({
              organizationId,
              actionRequestId: submitted.value.actionRequestId,
              component: "http",
              operation: "action_request.submit",
            }),
            attributes: { errorCode: submitted.value.code, status: "authorization_denied" },
          }),
        );
        return actionRequestProblem({
          status: 403,
          code: submitted.value.code,
          title: "Action authorization denied",
          detail: submitted.value.reason,
          actionRequestId: String(submitted.value.actionRequestId),
        });
      }

      input.telemetry?.emit(
        safeLogRecord({
          level: "info",
          event: "request.accepted",
          correlation: actionCorrelation({
            organizationId,
            actionRequestId: submitted.value.actionRequestId,
            component: "http",
            operation: "action_request.submit",
          }),
          attributes: { status: submitted.value.view.status },
        }),
      );

      return actionRequestJson(submitted.value.view, {
        status: 201,
        headers: {
          location: `/v1/organizations/${encodeURIComponent(
            submitted.value.view.organizationId,
          )}/action-requests/${encodeURIComponent(submitted.value.view.id)}`,
        },
      });
    },
  };
}
