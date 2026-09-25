import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { ActionRequest, RelationName } from "@app/approval-core";
import {
  DEFAULT_FGA_API_URL,
  OpenFgaActionAuthorizer,
  OpenFgaClient,
  sharedFgaTokenProvider,
} from "@app/approval-fga";
import { parseBrand } from "@app/approval-core";
import { telemetrySinkFromEnv, type TelemetryEnv } from "@app/approval-runtime-cloudflare";

import { stagingActionRelation } from "./action-relations.ts";

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
    if (!actionType || !principal || !evaluatedAt || !isRecord(action?.resource)) {
      return errorBody(
        "invalid_staging_authorization_request",
        "action.type / action.resource / authority.principal / evaluatedAtが必要です",
        false,
        400,
      );
    }

    const relation: RelationName | null = stagingActionRelation(
      (body.request as unknown as ActionRequest).action,
    );
    if (!relation) {
      // Unmapped action (or a governed action on an unexpected resource): deny
      // without calling the provider. Approval can never turn this into allow.
      return Response.json(
        {
          type: "deny",
          code: "action_relation_unmapped",
          reason: `Action typeに対応するrelationがありません: ${actionType}`,
        },
        { status: 200 },
      );
    }

    const storeId = env["OPENFGA_STORE_ID"];
    const modelId = env["OPENFGA_AUTHORIZATION_MODEL_ID"];
    const clientId = env["FGA_CLIENT_ID"];
    const clientSecret = env["FGA_CLIENT_SECRET"];
    if (!storeId || !modelId || !clientId || !clientSecret) {
      return errorBody("fga_not_configured", "FGA接続設定がありません", true, 500);
    }
    // isolate内で共有し、認可checkのたびにtoken exchangeしない（#90）。
    const tokenSupplier = sharedFgaTokenProvider({
      clientId,
      clientSecret,
      ...(env["OPENFGA_API_URL"] ? { OPENFGA_API_URL: env["OPENFGA_API_URL"] } : {}),
      ...(env["FGA_API_TOKEN_ISSUER"] ? { FGA_API_TOKEN_ISSUER: env["FGA_API_TOKEN_ISSUER"] } : {}),
      ...(env["FGA_API_AUDIENCE"] ? { FGA_API_AUDIENCE: env["FGA_API_AUDIENCE"] } : {}),
    });
    const organizationId = parseBrand(
      "OrganizationId",
      (body.organizationId as string | undefined) ?? request.headers.get("x-ue-organization-id"),
    );
    if (Result.isFailure(organizationId)) {
      return errorBody("invalid_organization_id", "organizationIdが不正です", false, 400);
    }
    // Workflow再認可経路ではServiceBindingActionAuthorizerがx-ue-action-request-idを付与する。
    // 存在する場合のみFGA latency/error telemetryをemitする（submit時は未採番のため対象外）。
    const parsedActionRequestId = parseBrand(
      "ActionRequestId",
      request.headers.get("x-ue-action-request-id")?.trim(),
    );
    const actionRequestId = Result.isSuccess(parsedActionRequestId)
      ? parsedActionRequestId.value
      : null;
    const authorizer = new OpenFgaActionAuthorizer(
      new OpenFgaClient({
        apiUrl: env["OPENFGA_API_URL"] ?? DEFAULT_FGA_API_URL,
        storeId,
        authorizationModelId: modelId,
        organizationId: organizationId.value,
        tokenSupplier,
        ...(actionRequestId
          ? {
              actionRequestId,
              telemetry: telemetrySinkFromEnv(this.env as TelemetryEnv),
            }
          : {}),
      }),
      () => relation,
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
