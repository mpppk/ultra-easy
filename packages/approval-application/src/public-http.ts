import { Result } from "@praha/byethrow";

import { DEFAULT_APPROVAL_DECISION_RATE_LIMIT, sha256CanonicalJson } from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalTaskId,
  JsonValue,
  OrganizationId,
  RateLimiter,
  RateLimitPolicy,
  UserId,
} from "@app/approval-core";

import type { HttpTrustedContextError } from "./http.ts";
import {
  ApprovalCommandApplicationError,
  type ApprovalDecisionCommandService,
  type ApprovalReadRepository,
  type ApprovalTaskView,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type PublicApiRepositoryError,
} from "./read-command.ts";

export interface PublicHttpIdentityProvider {
  resolveSubject(input: {
    request: Request;
    organizationId: OrganizationId;
  }): Result.ResultAsync<string, HttpTrustedContextError>;

  resolveUser(input: {
    request: Request;
    organizationId: OrganizationId;
  }): Result.ResultAsync<UserId, HttpTrustedContextError>;
}

export interface PublicHttpClock {
  now(): string;
}

function responseJson(value: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { status, headers: merged });
}

function problem(input: {
  status: number;
  code: string;
  title: string;
  detail?: string;
  commandId?: string;
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
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    }),
    {
      status: input.status,
      headers,
    },
  );
}

function repositoryErrorResponse(error: PublicApiRepositoryError): Response {
  return problem({
    status: error.retriable ? 503 : 500,
    code: error.code,
    title: "Public API read modelを利用できません",
    detail: error.message,
  });
}

function commandErrorResponse(error: ApprovalCommandApplicationError): Response {
  if (error.code === "approval_task_not_found" || error.code === "approval_command_not_found") {
    return problem({
      status: 404,
      code: error.code,
      title: "Resource not found",
      detail: error.message,
    });
  }
  if (error.code === "approval_command_conflict") {
    return problem({
      status: 409,
      code: error.code,
      title: "Approval command conflict",
      detail: error.message,
    });
  }
  return problem({
    status: error.retriable ? 503 : 422,
    code: error.code,
    title: "Approval commandを処理できません",
    detail: error.message,
  });
}

function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) return null;
  return value;
}

function taskStatus(value: string | null): ApprovalTaskView["status"] | undefined | null {
  if (value === null) return undefined;
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "expired"
  ) {
    return value;
  }
  return null;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

async function hashRequest(operation: string, request: Request) {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  return sha256CanonicalJson({
    operation,
    body: asJsonValue(body),
  });
}

async function idempotent(input: {
  request: Request;
  organizationId: OrganizationId;
  operation: string;
  repository: IdempotencyRepository;
  clock: PublicHttpClock;
  execute: () => Promise<Response>;
}): Promise<Response> {
  const key = input.request.headers.get("idempotency-key");
  if (!key || key.length > 255) {
    return problem({
      status: 400,
      code: "invalid_idempotency_key",
      title: "Idempotency-Keyが必要です",
    });
  }

  const hashed = await hashRequest(input.operation, input.request);
  if (Result.isFailure(hashed)) {
    return problem({
      status: 400,
      code: "idempotency_payload_hash_failed",
      title: "Request payloadを正規化できません",
      detail: hashed.error.message,
    });
  }
  const now = input.clock.now();
  const record: IdempotencyRecord = {
    organizationId: input.organizationId,
    operation: input.operation,
    key,
    requestHash: String(hashed.value),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const reserved = await input.repository.reserve(record);
  if (Result.isFailure(reserved)) return repositoryErrorResponse(reserved.error);

  if (reserved.value.type === "conflict") {
    return problem({
      status: 409,
      code: "idempotency_key_reused",
      title: "Idempotency-Keyが異なるpayloadへ再利用されました",
    });
  }
  if (reserved.value.type === "in_progress") {
    return problem({
      status: 409,
      code: "idempotency_request_in_progress",
      title: "同じlogical operationを処理中です",
    });
  }
  if (reserved.value.type === "replay") {
    const completed = reserved.value.record;
    if (completed.responseStatus === undefined || completed.responseBody === undefined) {
      return problem({
        status: 500,
        code: "invalid_idempotency_record",
        title: "保存済みidempotency responseが不正です",
      });
    }
    return responseJson(
      completed.responseBody,
      completed.responseStatus,
      completed.responseLocation ? { location: completed.responseLocation } : undefined,
    );
  }

  const response = await input.execute();
  // 5xxもcompleteとして記録する。予約をpendingのまま残すと、
  // 同じkeyでの正当なretryが永久に409 in_progressになる。
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const completed = await input.repository.complete({
    organizationId: input.organizationId,
    operation: input.operation,
    key,
    requestHash: String(hashed.value),
    responseStatus: response.status,
    responseBody: asJsonValue(body),
    ...(response.headers.get("location")
      ? { responseLocation: response.headers.get("location") ?? undefined }
      : {}),
    completedAt: input.clock.now(),
  });
  if (Result.isFailure(completed)) {
    return repositoryErrorResponse(completed.error);
  }
  return response;
}

async function resolveSubject(input: {
  identityProvider: PublicHttpIdentityProvider;
  request: Request;
  organizationId: OrganizationId;
}): Promise<string | Response> {
  const identity = await input.identityProvider.resolveSubject(input);
  if (Result.isFailure(identity)) {
    return problem({
      status: identity.error.status,
      code: identity.error.code,
      title: identity.error.status === 401 ? "Authentication required" : "Forbidden",
      detail: identity.error.message,
    });
  }
  return identity.value;
}

async function resolveUser(input: {
  identityProvider: PublicHttpIdentityProvider;
  request: Request;
  organizationId: OrganizationId;
}): Promise<UserId | Response> {
  const identity = await input.identityProvider.resolveUser(input);
  if (Result.isFailure(identity)) {
    return problem({
      status: identity.error.status,
      code: identity.error.code,
      title: identity.error.status === 401 ? "Authentication required" : "Forbidden",
      detail: identity.error.message,
    });
  }
  return identity.value;
}

function decisionBody(value: unknown): { decision: "approve" | "reject"; comment?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "decision" || key === "comment")) return null;
  if (record.decision !== "approve" && record.decision !== "reject") return null;
  if (
    record.comment !== undefined &&
    (typeof record.comment !== "string" || record.comment.length > 10_000)
  ) {
    return null;
  }
  return {
    decision: record.decision,
    ...(typeof record.comment === "string" ? { comment: record.comment } : {}),
  };
}

export function createPublicHttpApi(input: {
  actionRequestApi: { fetch(request: Request): Promise<Response> };
  readRepository: ApprovalReadRepository;
  decisionService: ApprovalDecisionCommandService;
  identityProvider: PublicHttpIdentityProvider;
  idempotencyRepository: IdempotencyRepository;
  clock: PublicHttpClock;
  rateLimiter?: RateLimiter;
  approvalDecisionRateLimitPolicy?: RateLimitPolicy;
  onDecisionAccepted?: (command: {
    organizationId: OrganizationId;
    commandId: string;
  }) => Promise<unknown>;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      const createMatch = /^\/v1\/organizations\/([^/]+)\/action-requests$/.exec(url.pathname);
      if (request.method === "POST" && createMatch?.[1]) {
        const organizationId = decodeURIComponent(createMatch[1]) as OrganizationId;
        const subject = await resolveSubject({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (subject instanceof Response) return subject;
        return idempotent({
          request,
          organizationId,
          operation: `action-request:create:${subject}`,
          repository: input.idempotencyRepository,
          clock: input.clock,
          execute: () => input.actionRequestApi.fetch(request),
        });
      }

      const actionMatch = /^\/v1\/organizations\/([^/]+)\/action-requests\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && actionMatch?.[1] && actionMatch[2]) {
        const organizationId = decodeURIComponent(actionMatch[1]) as OrganizationId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;
        const loaded = await input.readRepository.getActionRequest({
          organizationId,
          actionRequestId: decodeURIComponent(actionMatch[2]) as ActionRequestId,
        });
        if (Result.isFailure(loaded)) return repositoryErrorResponse(loaded.error);
        if (!loaded.value) {
          return problem({
            status: 404,
            code: "action_request_not_found",
            title: "ActionRequest not found",
          });
        }
        return responseJson(loaded.value);
      }

      const actionTasksMatch =
        /^\/v1\/organizations\/([^/]+)\/action-requests\/([^/]+)\/tasks$/.exec(url.pathname);
      if (request.method === "GET" && actionTasksMatch?.[1] && actionTasksMatch[2]) {
        const organizationId = decodeURIComponent(actionTasksMatch[1]) as OrganizationId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;
        const actionRequestId = decodeURIComponent(actionTasksMatch[2]) as ActionRequestId;
        const action = await input.readRepository.getActionRequest({
          organizationId,
          actionRequestId,
        });
        if (Result.isFailure(action)) return repositoryErrorResponse(action.error);
        if (!action.value) {
          return problem({
            status: 404,
            code: "action_request_not_found",
            title: "ActionRequest not found",
          });
        }

        const limit = parseLimit(url);
        if (limit === null) {
          return problem({ status: 400, code: "invalid_limit", title: "limitが不正です" });
        }
        const tasks = await input.readRepository.listActionRequestTasks({
          organizationId,
          actionRequestId,
          limit,
          viewerUserId: user,
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") ?? undefined }
            : {}),
        });
        return Result.isFailure(tasks)
          ? repositoryErrorResponse(tasks.error)
          : responseJson(tasks.value);
      }

      const inboxMatch = /^\/v1\/organizations\/([^/]+)\/me\/approval-tasks$/.exec(url.pathname);
      if (request.method === "GET" && inboxMatch?.[1]) {
        const organizationId = decodeURIComponent(inboxMatch[1]) as OrganizationId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;
        const limit = parseLimit(url);
        const status = taskStatus(url.searchParams.get("status"));
        if (limit === null || status === null) {
          return problem({
            status: 400,
            code: "invalid_approval_task_query",
            title: "Approval task queryが不正です",
          });
        }
        const tasks = await input.readRepository.listMyApprovalTasks({
          organizationId,
          userId: user,
          limit,
          ...(status !== undefined ? { status } : {}),
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") ?? undefined }
            : {}),
          ...(url.searchParams.get("actionType")
            ? { actionType: url.searchParams.get("actionType") ?? undefined }
            : {}),
          ...(url.searchParams.get("resourceType")
            ? { resourceType: url.searchParams.get("resourceType") ?? undefined }
            : {}),
        });
        return Result.isFailure(tasks)
          ? repositoryErrorResponse(tasks.error)
          : responseJson(tasks.value);
      }

      const taskMatch = /^\/v1\/organizations\/([^/]+)\/approval-tasks\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && taskMatch?.[1] && taskMatch[2]) {
        const organizationId = decodeURIComponent(taskMatch[1]) as OrganizationId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;
        const task = await input.readRepository.getApprovalTask({
          organizationId,
          taskId: decodeURIComponent(taskMatch[2]) as ApprovalTaskId,
          viewerUserId: user,
        });
        if (Result.isFailure(task)) return repositoryErrorResponse(task.error);
        if (!task.value) {
          return problem({
            status: 404,
            code: "approval_task_not_found",
            title: "Approval task not found",
          });
        }
        return responseJson(task.value);
      }

      const decisionMatch =
        /^\/v1\/organizations\/([^/]+)\/approval-tasks\/([^/]+)\/decisions$/.exec(url.pathname);
      if (request.method === "POST" && decisionMatch?.[1] && decisionMatch[2]) {
        const organizationId = decodeURIComponent(decisionMatch[1]) as OrganizationId;
        const taskId = decodeURIComponent(decisionMatch[2]) as ApprovalTaskId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;

        if (input.rateLimiter) {
          const limited = await input.rateLimiter.consume({
            organizationId,
            principal: { type: "user", id: user },
            operation: "approval_decision.submit",
            policy: input.approvalDecisionRateLimitPolicy ?? DEFAULT_APPROVAL_DECISION_RATE_LIMIT,
            now: input.clock.now(),
          });
          if (Result.isFailure(limited)) {
            return problem({
              status: 503,
              code: limited.error.code,
              title: "Rate limit service unavailable",
            });
          }
          if (!limited.value.allowed) {
            return problem({
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

        return idempotent({
          request,
          organizationId,
          operation: `approval-decision:${String(taskId)}:${String(user)}`,
          repository: input.idempotencyRepository,
          clock: input.clock,
          execute: async () => {
            const raw = await request
              .clone()
              .json()
              .catch(() => null);
            const body = decisionBody(raw);
            if (!body) {
              return problem({
                status: 400,
                code: "invalid_approval_decision",
                title: "Approval decision bodyが不正です",
              });
            }
            const accepted = await input.decisionService.accept({
              organizationId,
              taskId,
              userId: user,
              decision: body.decision,
              ...(body.comment !== undefined ? { comment: body.comment } : {}),
              now: input.clock.now(),
            });
            if (Result.isFailure(accepted)) return commandErrorResponse(accepted.error);
            if (input.onDecisionAccepted) {
              await input.onDecisionAccepted({
                organizationId,
                commandId: accepted.value.id,
              });
            }
            return responseJson(accepted.value, 202);
          },
        });
      }

      const commandMatch = /^\/v1\/organizations\/([^/]+)\/approval-commands\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && commandMatch?.[1] && commandMatch[2]) {
        const organizationId = decodeURIComponent(commandMatch[1]) as OrganizationId;
        const user = await resolveUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
        });
        if (user instanceof Response) return user;
        const command = await input.decisionService.get({
          organizationId,
          commandId: decodeURIComponent(commandMatch[2]),
        });
        if (Result.isFailure(command)) return commandErrorResponse(command.error);
        if (!command.value) {
          return problem({
            status: 404,
            code: "approval_command_not_found",
            title: "Approval command not found",
          });
        }
        return responseJson(command.value);
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
