import { Result } from "@praha/byethrow";

import type { ActionDefinitionKey, OrganizationId } from "@app/approval-core";
import {
  McpGatewayError,
  mcpActionRouteFingerprint,
  type McpActionRoute,
  type McpActionRouteRepository,
} from "@app/approval-mcp";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

type RouteRow = { route_json: string; route_fingerprint: string };

const firstRouteRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<RouteRow | null> =>
    statement.first<RouteRow>(),
  catch: (error): McpGatewayError =>
    new McpGatewayError(
      "mcp_action_route_repository_error",
      true,
      error instanceof Error ? error.message : "MCP action routeの取得に失敗しました",
    ),
});

const parseRoute = Result.fn({
  try: (value: string): McpActionRoute => JSON.parse(value) as McpActionRoute,
  catch: (): McpGatewayError =>
    new McpGatewayError("mcp_action_route_corrupted", false, "MCP action routeをparseできません"),
});

/**
 * 登録済みMCP action route（`mcp_action_routes`、insert-only）の読み取り。
 * 書き込みはreviewed catalog migrationだけが行い、runtimeには書き込み経路を持たせない。
 * 読み出したrouteは保存時のfingerprintと照合し、改変された行では実行しない（fail-closed）。
 */
export class D1McpActionRouteRepository implements McpActionRouteRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }): Result.ResultAsync<McpActionRoute | null, McpGatewayError> {
    const row = await firstRouteRow(
      this.db
        .prepare(
          `SELECT route_json, route_fingerprint FROM mcp_action_routes
            WHERE organization_id = ? AND action_definition_key = ? AND action_definition_version = ?`,
        )
        .bind(
          String(input.organizationId),
          String(input.actionDefinitionKey),
          input.actionDefinitionVersion,
        ),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const route = parseRoute(row.value.route_json);
    if (Result.isFailure(route)) return route;
    const fingerprint = await mcpActionRouteFingerprint(route.value);
    if (Result.isFailure(fingerprint)) return fingerprint;
    if (
      fingerprint.value !== row.value.route_fingerprint ||
      String(route.value.organizationId) !== String(input.organizationId) ||
      String(route.value.actionDefinitionKey) !== String(input.actionDefinitionKey) ||
      route.value.actionDefinitionVersion !== input.actionDefinitionVersion
    ) {
      return Result.fail(
        new McpGatewayError(
          "mcp_action_route_corrupted",
          false,
          "MCP action routeが登録時のfingerprintと一致しません",
        ),
      );
    }
    return Result.succeed(route.value);
  }
}
