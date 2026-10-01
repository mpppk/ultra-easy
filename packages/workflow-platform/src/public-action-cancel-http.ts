import { Result } from "@praha/byethrow";

import {
  authenticatePublicApi,
  idempotent,
  matchHttpRoute,
  type ApprovalReadRepository,
  type IdempotencyRepository,
  type PublicHttpClock,
  type PublicHttpIdentityProvider,
} from "@app/approval-application";
import { parseBrand, type ActionRequestId, type OrganizationId } from "@app/approval-core";

export const PUBLIC_ACTION_CANCELLATION_ROUTES = [
  "/v1/organizations/{organizationId}/action-requests/{actionRequestId}/cancel",
] as const;

export type PublicActionCancellationControl = {
  cancelPending(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    now: string;
  }): Result.ResultAsync<{ duplicate: boolean }, { code: string; retriable: boolean }>;
  cancelRunning(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    now: string;
  }): Result.ResultAsync<{ runId: string }, { code: string; retriable: boolean }>;
};

function problem(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `urn:ultra-easy:problem:${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function failure(input: { code: string; retriable: boolean }): Response {
  // The ActionRequest was already loaded. A missing projection or run is a
  // transient materialization gap, so the same idempotency key must be retryable.
  if (
    input.code === "force_cancel_target_not_found" ||
    input.code === "workflow_run_not_found" ||
    input.code === "force_cancel_target_not_pending"
  )
    return problem(503, "action_cancel_not_ready", "Cancellation is not ready");
  if (input.code === "already_settled" || input.code === "non_workflow_action")
    return problem(409, "action_request_not_cancellable", "ActionRequest cannot be cancelled");
  return problem(input.retriable ? 503 : 500, "action_cancel_failed", "Cancellation unavailable");
}

/** Read at most 64 KiB before the shared idempotency layer hashes the body. */
async function readBoundedBody(request: Request): Promise<string | Response> {
  const read = await Result.try({
    try: async (): Promise<{ text: string } | { tooLarge: true }> => {
      const stream = request.clone().body;
      if (!stream) return { text: "" };
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) {
          void reader.cancel().catch(() => undefined);
          return { tooLarge: true };
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { text: text + decoder.decode() };
    },
    catch: () => ({ tooLarge: true as const }),
  });
  if (Result.isFailure(read) || "tooLarge" in read.value)
    return problem(413, "cancel_body_too_large", "Cancellation body is too large");
  return read.value.text;
}

function reasonFrom(text: string): string | Response {
  if (text.trim().length === 0) return "Cancelled by requester";
  const parsed = Result.fn({ try: () => JSON.parse(text) as unknown, catch: () => null })();
  if (
    Result.isFailure(parsed) ||
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  )
    return problem(400, "invalid_cancel_body", "Invalid cancellation body");
  const entries = Object.entries(parsed.value);
  if (entries.length === 0) return "Cancelled by requester";
  if (entries.length !== 1 || entries[0]?.[0] !== "reason")
    return problem(400, "invalid_cancel_body", "Invalid cancellation body");
  const reason = entries[0]?.[1];
  return typeof reason === "string" && reason.length <= 10_000
    ? reason
    : problem(400, "invalid_cancel_body", "Invalid cancellation body");
}

/** Public, actor-scoped command for pending approvals and active composite runs. */
export function createPublicActionCancellationApi(input: {
  readRepository: Pick<ApprovalReadRepository, "getActionRequest">;
  identityProvider: PublicHttpIdentityProvider;
  idempotencyRepository: IdempotencyRepository;
  clock: PublicHttpClock;
  control: PublicActionCancellationControl;
}): { handles(request: Request): boolean; fetch(request: Request): Promise<Response> } {
  return {
    handles(request) {
      return (
        request.method === "POST" &&
        matchHttpRoute(PUBLIC_ACTION_CANCELLATION_ROUTES, new URL(request.url).pathname) !== null
      );
    },
    async fetch(request) {
      const matched = matchHttpRoute(
        PUBLIC_ACTION_CANCELLATION_ROUTES,
        new URL(request.url).pathname,
      );
      if (request.method !== "POST" || !matched)
        return problem(404, "action_request_not_found", "ActionRequest not found");
      const organization = parseBrand("OrganizationId", matched.parameters["organizationId"]);
      const actionId = parseBrand("ActionRequestId", matched.parameters["actionRequestId"]);
      if (Result.isFailure(organization) || Result.isFailure(actionId))
        return problem(400, "invalid_path_parameter", "Invalid path parameter");
      const organizationId = organization.value;
      const actionRequestId = actionId.value;
      const caller = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: "action_request.submit",
      });
      if (caller instanceof Response) return caller;
      const action = await input.readRepository.getActionRequest({
        organizationId,
        actionRequestId,
      });
      if (Result.isFailure(action)) return failure(action.error);
      if (!action.value) return problem(404, "action_request_not_found", "ActionRequest not found");
      const scopedCaller = await authenticatePublicApi({
        identityProvider: input.identityProvider,
        request,
        organizationId,
        operation: "action_request.submit",
        actionType: String(action.value.action.type),
        resourceType: String(action.value.action.resource.type),
      });
      if (scopedCaller instanceof Response) return scopedCaller;
      if (
        scopedCaller.type !== caller.type ||
        String(scopedCaller.id) !== String(caller.id) ||
        action.value.actor.type !== scopedCaller.type ||
        String(action.value.actor.id) !== String(scopedCaller.id)
      )
        return problem(403, "action_cancel_forbidden", "Forbidden");
      const text = await readBoundedBody(request);
      if (text instanceof Response) return text;
      const reason = reasonFrom(text);
      if (reason instanceof Response) return reason;
      return idempotent({
        request,
        organizationId,
        operation: `action_request.cancel:${String(actionRequestId)}:${scopedCaller.type}:${String(scopedCaller.id)}`,
        repository: input.idempotencyRepository,
        clock: input.clock,
        execute: async () => {
          const latest = await input.readRepository.getActionRequest({
            organizationId,
            actionRequestId,
          });
          if (Result.isFailure(latest)) return failure(latest.error);
          if (!latest.value)
            return problem(404, "action_request_not_found", "ActionRequest not found");
          const command = { organizationId, actionRequestId, reason, now: input.clock.now() };
          if (latest.value.status === "pending_approval") {
            const cancelled = await Result.try({
              try: () => input.control.cancelPending(command),
              catch: () => ({ code: "cancel_control_unavailable", retriable: true }),
            });
            if (Result.isFailure(cancelled)) return failure(cancelled.error);
            if (Result.isFailure(cancelled.value)) return failure(cancelled.value.error);
            return Response.json({ actionRequestId, status: "cancelled" }, { status: 202 });
          }
          if (latest.value.status === "executing") {
            const cancelled = await Result.try({
              try: () => input.control.cancelRunning(command),
              catch: () => ({ code: "cancel_control_unavailable", retriable: true }),
            });
            if (Result.isFailure(cancelled)) return failure(cancelled.error);
            if (Result.isFailure(cancelled.value)) return failure(cancelled.value.error);
            return Response.json(
              { actionRequestId, runId: cancelled.value.value.runId, status: "cancel_requested" },
              { status: 202 },
            );
          }
          if (latest.value.status === "approved" || latest.value.status === "evaluating")
            return problem(503, "action_cancel_not_ready", "Cancellation is not ready");
          return problem(
            409,
            "action_request_not_cancellable",
            "ActionRequest cannot be cancelled",
          );
        },
      });
    },
  };
}
