import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { ActionType, OrganizationId, RelationName } from "@app/approval-core";
import {
  ClientCredentialsTokenProvider,
  OpenFgaActionAuthorizer,
  OpenFgaClient,
} from "@app/approval-fga";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorBody(code: string, detail: string, retriable: boolean, status: number): Response {
  return Response.json({ code, detail, retriable }, { status });
}

/**
 * Staging用のActionAuthorizer。同一Workerのnamed entrypointとして公開し、
 * 本番と同じServiceBindingActionAuthorizer contractを通す。
 * 認可判定は実OpenFGA（staging store/model）で行う。
 */
export class StagingActionAuthorizer extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not Found", { status: 404 });
    }
    const env = this.env as unknown as Record<string, string | undefined>;
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || !isRecord(body.request)) {
      return errorBody(
        "invalid_staging_authorization_request",
        "request objectが必要です",
        false,
        400,
      );
    }
    const action = (body.request as Record<string, unknown>).action as
      | Record<string, unknown>
      | undefined;
    const authority = (body.request as Record<string, unknown>).authority as
      | Record<string, unknown>
      | undefined;
    const actionType = typeof action?.type === "string" ? action.type : null;
    const principal = isRecord(authority?.principal) ? authority.principal : null;
    const evaluatedAt = typeof body.evaluatedAt === "string" ? body.evaluatedAt : null;
    if (!actionType || !principal || !evaluatedAt) {
      return errorBody(
        "invalid_staging_authorization_request",
        "action.type / authority.principal / evaluatedAtが必要です",
        false,
        400,
      );
    }

    const storeId = env["OPENFGA_STORE_ID"];
    const modelId = env["OPENFGA_AUTHORIZATION_MODEL_ID"];
    const clientId = env["FGA_CLIENT_ID"];
    const clientSecret = env["FGA_CLIENT_SECRET"];
    if (!storeId || !modelId || !clientId || !clientSecret) {
      return errorBody("fga_not_configured", "FGA接続設定がありません", true, 500);
    }
    const tokenSupplier = new ClientCredentialsTokenProvider({
      tokenUrl: "https://auth.fga.dev/oauth/token",
      audience: "https://api.us1.fga.dev/",
      clientId,
      clientSecret,
    });
    const organizationId = String(
      (body.organizationId as string | undefined) ??
        request.headers.get("x-ue-organization-id") ??
        "",
    );
    const authorizer = new OpenFgaActionAuthorizer(
      new OpenFgaClient({
        apiUrl: env["OPENFGA_API_URL"] ?? "https://api.us1.fga.dev",
        storeId,
        authorizationModelId: modelId,
        organizationId: organizationId as OrganizationId,
        tokenSupplier,
      }),
      (type: ActionType): RelationName =>
        // staging modelはticket系のみ。未知typeは存在しないrelationへ落としてfail closed.
        type === "ticket.update"
          ? ("can_execute" as RelationName)
          : (`undefined_relation:${String(type)}` as RelationName),
    );
    const checked = await authorizer.check({
      request: body.request as Parameters<OpenFgaActionAuthorizer["check"]>[0]["request"],
      evaluatedAt,
      consistency: "higher_consistency",
    });
    if (Result.isFailure(checked)) {
      return errorBody(checked.error.code, checked.error.message, checked.error.retriable, 500);
    }
    if (checked.value.type === "deny") {
      return Response.json(
        { type: "deny", code: checked.value.code, reason: checked.value.reason },
        { status: 200 },
      );
    }
    return Response.json(
      {
        type: "allow",
        evidence: { provider: "openfga", ...checked.value.evidence },
      },
      { status: 200 },
    );
  }
}
