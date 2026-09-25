import { Result } from "@praha/byethrow";

import { DEFAULT_APPROVAL_DECISION_RATE_LIMIT, sha256CanonicalJson } from "@app/approval-core";
import type {
  ActionRequestId,
  JsonValue,
  OrganizationId,
  PrincipalRef,
  RateLimiter,
  RateLimitPolicy,
  UserId,
} from "@app/approval-core";

import type { ActionRequestView } from "./action-request-service.ts";
import { routeParameters } from "./path-parameters.ts";
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

/** Public APIの操作種別。identity providerは操作ごとに必要なscope / principal種別を検証する。 */
export type PublicApiOperation =
  | "action_request.read"
  | "action_request.submit"
  | "approval_decision.submit";

export interface PublicHttpIdentityProvider {
  /**
   * requestを認証し、organizationへの所属とoperationに必要な権限を検証したprincipalを返す。
   * user以外（M2M client等）はagent / service principalとして返す。
   */
  authenticate(input: {
    request: Request;
    organizationId: OrganizationId;
    operation: PublicApiOperation;
  }): Result.ResultAsync<PrincipalRef, HttpTrustedContextError>;
}

/**
 * 組織の運用者（operator）として、関係者でなくてもActionRequest / Decision commandを
 * 読めるかを判定するport。未設定なら関係者以外は常に読めない。
 */
export interface PublicApiOperatorAccess {
  canReadAll(input: {
    organizationId: OrganizationId;
    principal: PrincipalRef;
  }): Result.ResultAsync<boolean, PublicApiRepositoryError>;
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
  // D1 / providerのmessageは返さない（error codeで識別する）。
  return problem({
    status: error.retriable ? 503 : 500,
    code: error.code,
    title: "Public API read modelを利用できません",
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
  if (error.code === "approval_task_closed" || error.code === "approval_user_already_decided") {
    return problem({
      status: 409,
      code: error.code,
      title: "Approval taskはこのDecisionを受け付けません",
      detail: error.message,
    });
  }
  if (
    error.code === "approval_self_approval_denied" ||
    error.code === "approval_candidate_rejected"
  ) {
    return problem({
      status: 403,
      code: error.code,
      title: "このApproval taskを承認できません",
      detail: error.message,
    });
  }
  if (error.code === "approval_comment_required") {
    return problem({
      status: 422,
      code: error.code,
      title: "commentが必要です",
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
  // repository障害等。内部messageは返さない。
  return problem({
    status: error.retriable ? 503 : 500,
    code: error.code,
    title: "Approval commandを処理できません",
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
  const text = await request
    .clone()
    .text()
    .catch(() => "");
  const parsed = parseJsonText(text);
  // JSONとして読めないbodyはraw textでhashし、別payload同士がnullとして衝突しないようにする。
  return sha256CanonicalJson(
    Result.isSuccess(parsed)
      ? { operation, body: asJsonValue(parsed.value) }
      : { operation, rawBody: text },
  );
}

const parseJsonText = Result.fn({
  try: (text: string): unknown => JSON.parse(text),
  catch: () => null,
});

/** 同じkeyで再試行すれば成功しうる応答。予約をreleaseしてcompletedとして再生しない。 */
const RETRIABLE_RESPONSE_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_IDEMPOTENCY_LEASE_MS = 60_000;

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

async function idempotent(input: {
  request: Request;
  organizationId: OrganizationId;
  operation: string;
  repository: IdempotencyRepository;
  clock: PublicHttpClock;
  leaseMs?: number;
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
    });
  }
  const now = input.clock.now();
  const record: IdempotencyRecord = {
    organizationId: input.organizationId,
    operation: input.operation,
    key,
    requestHash: String(hashed.value),
    status: "pending",
    lockedUntil: addMs(now, input.leaseMs ?? DEFAULT_IDEMPOTENCY_LEASE_MS),
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
    const lockedUntil = reserved.value.record.lockedUntil;
    const retryAfterSeconds =
      lockedUntil === undefined
        ? 1
        : Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.parse(now)) / 1000));
    return problem({
      status: 409,
      code: "idempotency_request_in_progress",
      title: "同じlogical operationを処理中です",
      headers: { "retry-after": String(retryAfterSeconds) },
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
  if (RETRIABLE_RESPONSE_STATUSES.has(response.status)) {
    // 一時障害は記録せず予約を解放し、同じkeyでの再試行で処理を再実行できるようにする。
    // releaseに失敗してもlease期限後には引き継げるため、応答はそのまま返す。
    await input.repository.release({
      organizationId: input.organizationId,
      operation: input.operation,
      key,
      requestHash: String(hashed.value),
    });
    return response;
  }
  // 非retriableな応答（2xx / 4xx / 確定した500）だけをcompletedとして再生する。
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

async function authenticate(input: {
  identityProvider: PublicHttpIdentityProvider;
  request: Request;
  organizationId: OrganizationId;
  operation: PublicApiOperation;
}): Promise<PrincipalRef | Response> {
  const identity = await input.identityProvider.authenticate(input);
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

async function authenticateUser(input: {
  identityProvider: PublicHttpIdentityProvider;
  request: Request;
  organizationId: OrganizationId;
  operation: PublicApiOperation;
}): Promise<UserId | Response> {
  const principal = await authenticate(input);
  if (principal instanceof Response) return principal;
  if (principal.type !== "user") {
    return problem({
      status: 403,
      code: "machine_principal_not_allowed",
      title: "Forbidden",
      detail: "この操作はuser principalのみ実行できます",
    });
  }
  return principal.id;
}

function samePrincipal(left: PrincipalRef | undefined, right: PrincipalRef): boolean {
  return left?.type === right.type && String(left.id) === String(right.id);
}

/**
 * ActionRequestの読み取りポリシー: actor / authority / caller、当該ActionRequestのTask候補者・
 * Decision者、operatorだけが読める。それ以外は存在を秘匿するため呼び出し側で404に揃える。
 */
async function canReadActionRequest(input: {
  view: ActionRequestView;
  viewer: PrincipalRef;
  organizationId: OrganizationId;
  readRepository: ApprovalReadRepository;
  operatorAccess?: PublicApiOperatorAccess;
}): Result.ResultAsync<boolean, PublicApiRepositoryError> {
  if (
    samePrincipal(input.view.actor, input.viewer) ||
    samePrincipal(input.view.authorityPrincipal, input.viewer) ||
    samePrincipal(input.view.caller, input.viewer)
  ) {
    return Result.succeed(true);
  }
  if (input.viewer.type === "user") {
    const participant = await input.readRepository.isActionRequestParticipant({
      organizationId: input.organizationId,
      actionRequestId: input.view.id,
      userId: input.viewer.id,
    });
    if (Result.isFailure(participant) || participant.value) return participant;
  }
  return canReadAsOperator(input);
}

async function canReadAsOperator(input: {
  viewer: PrincipalRef;
  organizationId: OrganizationId;
  operatorAccess?: PublicApiOperatorAccess;
}): Result.ResultAsync<boolean, PublicApiRepositoryError> {
  if (!input.operatorAccess) return Result.succeed(false);
  return input.operatorAccess.canReadAll({
    organizationId: input.organizationId,
    principal: input.viewer,
  });
}

function actionRequestNotFound(): Response {
  return problem({
    status: 404,
    code: "action_request_not_found",
    title: "ActionRequest not found",
  });
}

/** 読み取り可能なActionRequestだけを返す。存在しない・読めない場合はどちらも404にする。 */
async function loadReadableActionRequest(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  viewer: PrincipalRef;
  readRepository: ApprovalReadRepository;
  operatorAccess?: PublicApiOperatorAccess;
}): Promise<ActionRequestView | Response> {
  const loaded = await input.readRepository.getActionRequest(input);
  if (Result.isFailure(loaded)) return repositoryErrorResponse(loaded.error);
  if (!loaded.value) return actionRequestNotFound();
  const allowed = await canReadActionRequest({ ...input, view: loaded.value });
  if (Result.isFailure(allowed)) return repositoryErrorResponse(allowed.error);
  return allowed.value ? loaded.value : actionRequestNotFound();
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
  operatorAccess?: PublicApiOperatorAccess;
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

      const createMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/action-requests$/,
        url.pathname,
        ["OrganizationId"],
      );
      if (createMatch instanceof Response) return createMatch;
      if (request.method === "POST" && createMatch) {
        const organizationId = createMatch[0];
        const principal = await authenticate({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.submit",
        });
        if (principal instanceof Response) return principal;
        return idempotent({
          request,
          organizationId,
          operation: `action-request:create:${String(principal.id)}`,
          repository: input.idempotencyRepository,
          clock: input.clock,
          execute: () => input.actionRequestApi.fetch(request),
        });
      }

      const actionMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/action-requests\/([^/]+)$/,
        url.pathname,
        ["OrganizationId", "ActionRequestId"],
      );
      if (actionMatch instanceof Response) return actionMatch;
      if (request.method === "GET" && actionMatch) {
        const organizationId = actionMatch[0];
        const viewer = await authenticate({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.read",
        });
        if (viewer instanceof Response) return viewer;
        const loaded = await loadReadableActionRequest({
          organizationId,
          actionRequestId: actionMatch[1],
          viewer,
          readRepository: input.readRepository,
          ...(input.operatorAccess ? { operatorAccess: input.operatorAccess } : {}),
        });
        return loaded instanceof Response ? loaded : responseJson(loaded);
      }

      const actionTasksMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/action-requests\/([^/]+)\/tasks$/,
        url.pathname,
        ["OrganizationId", "ActionRequestId"],
      );
      if (actionTasksMatch instanceof Response) return actionTasksMatch;
      if (request.method === "GET" && actionTasksMatch) {
        const organizationId = actionTasksMatch[0];
        const viewer = await authenticate({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.read",
        });
        if (viewer instanceof Response) return viewer;
        const actionRequestId = actionTasksMatch[1];
        const action = await loadReadableActionRequest({
          organizationId,
          actionRequestId,
          viewer,
          readRepository: input.readRepository,
          ...(input.operatorAccess ? { operatorAccess: input.operatorAccess } : {}),
        });
        if (action instanceof Response) return action;

        const limit = parseLimit(url);
        if (limit === null) {
          return problem({ status: 400, code: "invalid_limit", title: "limitが不正です" });
        }
        const tasks = await input.readRepository.listActionRequestTasks({
          organizationId,
          actionRequestId,
          limit,
          ...(viewer.type === "user" ? { viewerUserId: viewer.id } : {}),
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") ?? undefined }
            : {}),
        });
        return Result.isFailure(tasks)
          ? repositoryErrorResponse(tasks.error)
          : responseJson(tasks.value);
      }

      const inboxMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/me\/approval-tasks$/,
        url.pathname,
        ["OrganizationId"],
      );
      if (inboxMatch instanceof Response) return inboxMatch;
      if (request.method === "GET" && inboxMatch) {
        const organizationId = inboxMatch[0];
        const user = await authenticateUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.read",
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

      const taskMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/approval-tasks\/([^/]+)$/,
        url.pathname,
        ["OrganizationId", "ApprovalTaskId"],
      );
      if (taskMatch instanceof Response) return taskMatch;
      if (request.method === "GET" && taskMatch) {
        const organizationId = taskMatch[0];
        const viewer = await authenticate({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.read",
        });
        if (viewer instanceof Response) return viewer;
        const taskNotFound = problem({
          status: 404,
          code: "approval_task_not_found",
          title: "Approval task not found",
        });
        const task = await input.readRepository.getApprovalTask({
          organizationId,
          taskId: taskMatch[1],
          ...(viewer.type === "user" ? { viewerUserId: viewer.id } : {}),
        });
        if (Result.isFailure(task)) return repositoryErrorResponse(task.error);
        if (!task.value) return taskNotFound;
        // Taskは所属するActionRequestと同じ読み取りポリシーに従う。
        const action = await loadReadableActionRequest({
          organizationId,
          actionRequestId: task.value.actionRequestId,
          viewer,
          readRepository: input.readRepository,
          ...(input.operatorAccess ? { operatorAccess: input.operatorAccess } : {}),
        });
        if (action instanceof Response) return action.status === 404 ? taskNotFound : action;
        return responseJson(task.value);
      }

      const decisionMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/approval-tasks\/([^/]+)\/decisions$/,
        url.pathname,
        ["OrganizationId", "ApprovalTaskId"],
      );
      if (decisionMatch instanceof Response) return decisionMatch;
      if (request.method === "POST" && decisionMatch) {
        const organizationId = decisionMatch[0];
        const taskId = decisionMatch[1];
        const user = await authenticateUser({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "approval_decision.submit",
        });
        if (user instanceof Response) return user;

        return idempotent({
          request,
          organizationId,
          operation: `approval-decision:${String(taskId)}:${String(user)}`,
          repository: input.idempotencyRepository,
          clock: input.clock,
          execute: async () => {
            // replayはrate limitを消費しない（idempotency予約後にだけconsumeする）。
            if (input.rateLimiter) {
              const limited = await input.rateLimiter.consume({
                organizationId,
                principal: { type: "user", id: user },
                operation: "approval_decision.submit",
                policy:
                  input.approvalDecisionRateLimitPolicy ?? DEFAULT_APPROVAL_DECISION_RATE_LIMIT,
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

      const commandMatch = routeParameters(
        /^\/v1\/organizations\/([^/]+)\/approval-commands\/([^/]+)$/,
        url.pathname,
        ["OrganizationId", "string"],
      );
      if (commandMatch instanceof Response) return commandMatch;
      if (request.method === "GET" && commandMatch) {
        const organizationId = commandMatch[0];
        const viewer = await authenticate({
          identityProvider: input.identityProvider,
          request,
          organizationId,
          operation: "action_request.read",
        });
        if (viewer instanceof Response) return viewer;
        const commandNotFound = problem({
          status: 404,
          code: "approval_command_not_found",
          title: "Approval command not found",
        });
        const record = await input.decisionService.get({
          organizationId,
          commandId: commandMatch[1],
        });
        if (Result.isFailure(record)) return commandErrorResponse(record.error);
        if (!record.value) return commandNotFound;
        // Decision commandは発行者本人とoperatorだけが読める。
        const issuer =
          record.value.actorUserId !== undefined &&
          viewer.type === "user" &&
          String(viewer.id) === String(record.value.actorUserId);
        if (!issuer) {
          const operator = await canReadAsOperator({
            viewer,
            organizationId,
            ...(input.operatorAccess ? { operatorAccess: input.operatorAccess } : {}),
          });
          if (Result.isFailure(operator)) return repositoryErrorResponse(operator.error);
          if (!operator.value) return commandNotFound;
        }
        return responseJson(record.value.command);
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
