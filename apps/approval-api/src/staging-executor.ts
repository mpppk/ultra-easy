import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import { AUTHORIZATION_EXECUTOR_KEY, type ActionExecutionRequest } from "@app/approval-core";

import { relationshipExecutor, type RelationshipMutationEnv } from "./relationship-mutation.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Workflow経路のAction Executor registry (service binding)。
 * - `authorization`: governed relationship mutation (M9-2, 実FGA tuple write)
 * - それ以外: staging用side-effect sink。外部副作用を持たず、idempotencyと
 *   correlationの契約検証後に成功を返す。
 * Workflow側がaction_resultsへ永続化する。
 */
export class StagingActionExecutor extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/execute\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match?.[1]) {
      return new Response("Not Found", { status: 404 });
    }
    const body = await request.json().catch(() => null);
    const headerIdempotencyKey = request.headers.get("idempotency-key");
    const correlationId = request.headers.get("x-ue-correlation-id");
    const bodyIdempotencyKey =
      isRecord(body) && typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    const bodyActionRequestId =
      isRecord(body) && typeof body.actionRequestId === "string" ? body.actionRequestId : undefined;
    if (
      !headerIdempotencyKey ||
      !bodyIdempotencyKey ||
      headerIdempotencyKey !== bodyIdempotencyKey ||
      !correlationId ||
      correlationId !== bodyActionRequestId
    ) {
      return Response.json(
        {
          code: "invalid_staging_execution_request",
          retriable: false,
          detail: "idempotency/correlation contractを満たしていません",
        },
        { status: 400 },
      );
    }
    if (decodeURIComponent(match[1]) === String(AUTHORIZATION_EXECUTOR_KEY)) {
      return this.executeRelationshipMutation(body as ActionExecutionRequest);
    }
    return Response.json(
      {
        status: "succeeded",
        output: {
          executorKey: decodeURIComponent(match[1]),
          actionRequestId: bodyActionRequestId,
          idempotencyKey: bodyIdempotencyKey,
          executedAt: new Date().toISOString(),
        },
      },
      { status: 200 },
    );
  }

  private async executeRelationshipMutation(request: ActionExecutionRequest): Promise<Response> {
    const executor = relationshipExecutor(this.env as unknown as RelationshipMutationEnv);
    if (!executor) {
      return Response.json(
        { code: "fga_not_configured", retriable: true, detail: "FGA接続設定がありません" },
        { status: 503 },
      );
    }
    const executed = await executor.execute(request);
    if (Result.isFailure(executed)) {
      return Response.json(
        {
          code: executed.error.code,
          retriable: executed.error.retriable,
          detail: executed.error.detail,
          ...(executed.error.details !== undefined ? { details: executed.error.details } : {}),
        },
        { status: executed.error.retriable ? 503 : 422 },
      );
    }
    return Response.json(executed.value, { status: 200 });
  }
}
