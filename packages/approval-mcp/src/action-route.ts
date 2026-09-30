import { Result } from "@praha/byethrow";

import {
  actionCorrelation,
  ActionExecutorError,
  safeLogRecord,
  sha256CanonicalJson,
} from "@app/approval-core";
import type {
  ActionDefinitionKey,
  ActionExecutionGuaranteeLevel,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionType,
  JsonValue,
  OrganizationId,
  ResourceType,
  TelemetrySink,
} from "@app/approval-core";

import { McpGatewayError } from "./binding.ts";
import {
  McpDownstreamTransportError,
  type McpDownstreamClient,
  type McpDownstreamServer,
  type McpDownstreamServerRegistry,
} from "./executor.ts";
import { mcpJsonRpcExecutorErrorCode } from "./projection.ts";

/** Catalog経由で実行するMCP-backed primitive ActionのexecutorKey prefix（`mcp:<serverId>`）。 */
export const MCP_CATALOG_EXECUTOR_KEY_PREFIX = "mcp:";

export function mcpCatalogExecutorKey(serverId: string): string {
  return `${MCP_CATALOG_EXECUTOR_KEY_PREFIX}${serverId}`;
}

/**
 * Action Catalogに登録されたActionDefinition version → downstream MCP toolのrouting（#198）。
 *
 * Gatewayの `tools/call` を経由しないActionRequest（公開APIのsubmit、Workflowのchild Action）は
 * admission時のroute snapshotを持たない。代わりに、Materialized Planがsnapshotした
 * ActionDefinition (key, version) にbindされたこのrouteで実行する。routeはinsert-onlyで
 * 登録され、同じ (key, version) を別targetへ差し替えられない（routingの変更は新しいversion）。
 */
export type McpActionRoute = {
  organizationId: OrganizationId;
  actionDefinitionKey: ActionDefinitionKey;
  actionDefinitionVersion: number;
  actionType: ActionType;
  target: { mcpServerId: string; toolName: string };
  argumentMapping: { resourceType: ResourceType; resourceIdArgument: string };
};

export interface McpActionRouteRepository {
  load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }): Result.ResultAsync<McpActionRoute | null, McpGatewayError>;
}

/** routeの同一性（登録済みrouteとの衝突検出・監査記録用）。 */
export async function mcpActionRouteFingerprint(
  route: McpActionRoute,
): Result.ResultAsync<string, McpGatewayError> {
  const digest = await sha256CanonicalJson({
    organizationId: String(route.organizationId),
    actionDefinitionKey: String(route.actionDefinitionKey),
    actionDefinitionVersion: route.actionDefinitionVersion,
    actionType: String(route.actionType),
    target: route.target,
    argumentMapping: {
      resourceType: String(route.argumentMapping.resourceType),
      resourceIdArgument: route.argumentMapping.resourceIdArgument,
    },
  } as unknown as JsonValue);
  if (Result.isFailure(digest)) {
    return Result.fail(
      new McpGatewayError("route_fingerprint_failed", false, digest.error.message),
    );
  }
  return Result.succeed(String(digest.value));
}

export class InMemoryMcpActionRouteRepository implements McpActionRouteRepository {
  private readonly routes = new Map<string, McpActionRoute>();

  constructor(routes: readonly McpActionRoute[] = []) {
    for (const route of routes) this.routes.set(this.key(route), structuredClone(route));
  }

  load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }) {
    const route = this.routes.get(this.key(input));
    return Promise.resolve(Result.succeed(route ? structuredClone(route) : null));
  }

  private key(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }): string {
    return JSON.stringify([
      String(input.organizationId),
      String(input.actionDefinitionKey),
      input.actionDefinitionVersion,
    ]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_ERROR_CODE = /^[a-z][a-z0-9_.:-]{0,127}$/;

/**
 * Catalogに登録されたMCP-backed primitive Actionを実行するexecutor（executorKey = `mcp:<serverId>`）。
 *
 * - routingはActionDefinition (key, version) にbindされた登録済みrouteだけを使う
 *   （Action inputやbindingの現在値からtargetを決めない）
 * - executorは1 downstream serverに固定し、routeのserverが一致しなければ実行しない
 * - downstreamの `isError: true` はActionの失敗として扱う（Workflowのchild Actionが失敗を
 *   成功扱いで先へ進めない）。`structuredContent.code` / `retriable` を引き継ぐ
 * - 成功時のoutputは `structuredContent`（Workflowが `nodes.<id>.output.*` で参照する）
 */
export class McpCatalogActionExecutor implements ActionExecutor {
  readonly guaranteeLevel: ActionExecutionGuaranteeLevel;

  constructor(
    private readonly dependencies: {
      serverId: string;
      routes: McpActionRouteRepository;
      serverRegistry: McpDownstreamServerRegistry;
      client: McpDownstreamClient;
      /** downstreamが `dev.ultra-easy/idempotencyKey` でdedupeする場合だけ `idempotent`。 */
      guaranteeLevel?: ActionExecutionGuaranteeLevel;
      telemetry?: TelemetrySink;
    },
  ) {
    this.guaranteeLevel = dependencies.guaranteeLevel ?? "best_effort_at_most_once";
  }

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const definition = request.action.definition;
    const loaded = await this.dependencies.routes.load({
      organizationId: request.organizationId,
      actionDefinitionKey: definition.key,
      actionDefinitionVersion: definition.version,
    });
    if (Result.isFailure(loaded)) {
      return this.fail(request, null, {
        code: "mcp_action_route_unavailable",
        retriable: loaded.error.retriable,
        detail: loaded.error.message,
      });
    }
    const route = loaded.value;
    if (!route) {
      return this.fail(request, null, {
        code: "mcp_action_route_missing",
        retriable: false,
        detail: "ActionDefinition versionにMCP routeが登録されていません",
      });
    }
    if (
      String(route.actionType) !== String(request.action.type) ||
      String(route.actionType) !== String(definition.actionType) ||
      String(route.argumentMapping.resourceType) !== String(request.action.resource.type) ||
      route.target.mcpServerId !== this.dependencies.serverId
    ) {
      return this.fail(request, route, {
        code: "mcp_action_route_mismatch",
        retriable: false,
        detail: "登録済みMCP routeが承認されたActionと一致しません",
      });
    }

    const server = await this.dependencies.serverRegistry.resolve(route.target.mcpServerId);
    if (Result.isFailure(server)) {
      return this.fail(request, route, {
        code: "mcp_server_registry_unavailable",
        retriable: server.error.retriable,
        detail: server.error.message,
      });
    }
    if (!server.value) {
      return this.fail(request, route, {
        code: "mcp_server_not_configured",
        retriable: true,
        detail: `downstream MCP serverが設定されていません: ${route.target.mcpServerId}`,
      });
    }

    const args: Record<string, unknown> = {
      ...request.action.input,
      [route.argumentMapping.resourceIdArgument]: String(request.action.resource.id),
    };
    const called = await Result.fn({
      try: async () =>
        this.dependencies.client.callTool({
          server: server.value as McpDownstreamServer,
          toolName: route.target.toolName,
          arguments: args,
          idempotencyKey: request.idempotencyKey,
          actionRequestId: String(request.actionRequestId),
        }),
      catch: (error) =>
        new McpDownstreamTransportError(
          "mcp_downstream_client_threw",
          "ambiguous",
          false,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    const outcome = Result.isFailure(called) ? called : called.value;
    if (Result.isFailure(outcome)) {
      return this.fail(request, route, {
        code: outcome.error.code,
        retriable: this.transportRetriable(outcome.error),
        detail: outcome.error.message,
        details: { effect: outcome.error.effect },
      });
    }
    if (outcome.value.type === "jsonrpc_error") {
      return this.fail(request, route, {
        code: mcpJsonRpcExecutorErrorCode(outcome.value.error.code),
        retriable: false,
        detail: outcome.value.error.message,
        details: { jsonrpcCode: outcome.value.error.code },
      });
    }

    const result = outcome.value.result;
    const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
    if (result.isError === true) {
      const code =
        typeof structured?.["code"] === "string" && TOOL_ERROR_CODE.test(structured["code"])
          ? structured["code"]
          : "mcp_tool_error";
      const message =
        typeof structured?.["message"] === "string"
          ? structured["message"]
          : "downstream toolがerrorを返しました";
      return this.fail(request, route, {
        code,
        // tool-level errorはdownstreamが処理した結果なので、再送してよいのはdownstreamが
        // retriableと明示し、かつidempotency keyでdedupeする場合だけ。
        retriable: structured?.["retriable"] === true && this.guaranteeLevel === "idempotent",
        detail: message,
      });
    }
    this.emit(request, route, "info", { status: "succeeded" });
    return Result.succeed({
      status: "succeeded",
      output: (structured ?? { content: result.content }) as unknown as JsonValue,
    });
  }

  private transportRetriable(error: McpDownstreamTransportError): boolean {
    if (error.effect === "not_sent") return true;
    if (error.effect === "rejected") return error.retryable;
    return this.guaranteeLevel === "idempotent";
  }

  private fail(
    request: ActionExecutionRequest,
    route: McpActionRoute | null,
    input: { code: string; retriable: boolean; detail: string; details?: JsonValue },
  ): Result.Result<never, ActionExecutorError> {
    this.emit(request, route, "error", { errorCode: input.code, retriable: input.retriable });
    return Result.fail(
      new ActionExecutorError({
        code: input.code,
        retriable: input.retriable,
        detail: input.detail,
        ...(input.details !== undefined ? { details: input.details } : {}),
      }),
    );
  }

  private emit(
    request: ActionExecutionRequest,
    route: McpActionRoute | null,
    level: "info" | "error",
    attributes: { status?: string; errorCode?: string; retriable?: boolean },
  ): void {
    this.dependencies.telemetry?.emit(
      safeLogRecord({
        level,
        event: level === "info" ? "executor.completed" : "executor.failed",
        correlation: actionCorrelation({
          component: "executor",
          operation: "mcp.catalog.tools_call",
          organizationId: request.organizationId,
          actionRequestId: request.actionRequestId,
        }),
        attributes: {
          ...attributes,
          mcpServerId: this.dependencies.serverId,
          ...(route ? { toolName: route.target.toolName } : {}),
        },
      }),
    );
  }
}
