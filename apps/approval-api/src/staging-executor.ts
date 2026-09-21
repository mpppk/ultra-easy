import { WorkerEntrypoint } from "cloudflare:workers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Staging用のside-effect sink。外部副作用を持たず、idempotencyとcorrelationの
 * 契約検証後に成功を返す。Workflow側がaction_resultsへ永続化する。
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
}
