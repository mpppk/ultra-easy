import { Result } from "@praha/byethrow";

import type {
  Action,
  ActionType,
  OrganizationId,
  ResourceId,
  ResourceType,
} from "@app/approval-core";

import {
  ActionRequestApplicationError,
  type ActionRequestApplicationService,
  type TrustedActionRequestContext,
} from "./action-request-service.ts";

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
}): Response {
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
      headers: { "content-type": "application/problem+json" },
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

export function actionRequestApplicationErrorResponse(error: ActionRequestApplicationError): Response {
  if (
    error.code === "action_input_validation_failed" ||
    error.code === "action_input_not_object" ||
    error.code === "policy_evaluation_failed" ||
    error.code === "materialization_failed"
  ) {
    return actionRequestProblem({
      status: 422,
      code: error.code,
      title: "ActionRequestを処理できません",
      detail: error.message,
    });
  }

  if (error.retriable) {
    return actionRequestProblem({
      status: 503,
      code: error.code,
      title: "依存サービスを利用できません",
      detail: error.message,
    });
  }

  return actionRequestProblem({
    status: 409,
    code: error.code,
    title: "ActionRequestの状態が競合しました",
    detail: error.message,
  });
}

export function createActionRequestHttpApi(input: {
  service: ActionRequestApplicationService;
  trustedContextProvider: HttpTrustedContextProvider;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = /^\/v1\/organizations\/([^/]+)\/action-requests$/.exec(url.pathname);
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

      const organizationId = decodeURIComponent(match[1]) as OrganizationId;
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

      const submitted = await input.service.submit({
        action: body.action,
        trustedContext: trusted.value,
        idempotencyKey,
        ...(body.clientReference ? { clientReference: body.clientReference } : {}),
      });
      if (Result.isFailure(submitted)) return actionRequestApplicationErrorResponse(submitted.error);

      if (submitted.value.type === "authorization_denied") {
        return actionRequestProblem({
          status: 403,
          code: submitted.value.code,
          title: "Action authorization denied",
          detail: submitted.value.reason,
          actionRequestId: String(submitted.value.actionRequestId),
        });
      }

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
