import { Result } from "@praha/byethrow";

import { actionCorrelation, ActionExecutorError, safeLogRecord } from "@app/approval-core";
import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  JsonValue,
  TelemetrySink,
} from "@app/approval-core";

import { McpGatewayError } from "./binding.ts";
import type { McpRouteSnapshot, McpRouteSnapshotRepository } from "./invocation.ts";
import {
  MCP_CALL_TOOL_OUTPUT_KIND,
  mcpJsonRpcExecutorErrorCode,
  type McpCallToolOutput,
} from "./projection.ts";
import type { McpCallToolResult, McpProtocolError } from "./protocol.ts";

/** downstream MCP serverの接続先。credentialそのものは持たず参照だけを持つ。 */
export type McpDownstreamServer = {
  id: string;
  endpoint: string;
  /** secret storeのkey等。値は `McpDownstreamCredentialProvider` だけが解決する。 */
  credentialRef?: string;
  timeoutMs?: number;
};

export interface McpDownstreamServerRegistry {
  resolve(serverId: string): Result.ResultAsync<McpDownstreamServer | null, McpGatewayError>;
}

export class StaticMcpDownstreamServerRegistry implements McpDownstreamServerRegistry {
  private readonly servers: Map<string, McpDownstreamServer>;

  constructor(servers: readonly McpDownstreamServer[]) {
    this.servers = new Map(servers.map((server) => [server.id, structuredClone(server)]));
  }

  resolve(serverId: string) {
    const server = this.servers.get(serverId);
    return Promise.resolve(Result.succeed(server ? structuredClone(server) : null));
  }
}

/**
 * downstream呼び出しの失敗が外部side effectに対してどういう状態か。
 * - not_sent: requestはserverへ届いていない
 * - rejected: serverが処理せずに拒否した（429 / 503 / 4xx）
 * - ambiguous: tool side effectが起きたか不明（network断 / timeout / 5xx / 不正response）
 */
export type McpDownstreamFailureEffect = "not_sent" | "rejected" | "ambiguous";

export class McpDownstreamTransportError extends Error {
  readonly name = "McpDownstreamTransportError";

  constructor(
    readonly code: string,
    readonly effect: McpDownstreamFailureEffect,
    /** effect=rejectedのとき、同じrequestを後で再送してよいか（429 / 503）。 */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type McpDownstreamCallOutcome =
  | { type: "result"; result: McpCallToolResult }
  | { type: "jsonrpc_error"; error: McpProtocolError };

export interface McpDownstreamClient {
  callTool(input: {
    server: McpDownstreamServer;
    toolName: string;
    arguments: Record<string, unknown>;
    /** execution idempotency key（同じActionRequestのretryでは常に同じ値）。 */
    idempotencyKey: string;
    actionRequestId: string;
  }): Result.ResultAsync<McpDownstreamCallOutcome, McpDownstreamTransportError>;
}

/**
 * Approval完了後、Re-Authorizationを通過したActionをdownstream MCP serverの `tools/call` へproxyする。
 *
 * - routingは承認時のroute snapshotだけを使う（bindingの現在値でtargetを差し替えない）
 * - downstreamの `CallToolResult`（isError=trueを含む）はActionの実行結果としてoutputへ保存する
 * - downstreamのJSON-RPC errorはnon-retriableなActionExecutorErrorにし、codeへJSON-RPC codeを保持する
 * - exactly-onceは主張しない。side effectが曖昧な失敗は、guaranteeLevel=idempotent
 *   （downstreamがidempotency keyでdedupeする）の場合だけretriableにする
 */
export class McpActionExecutor implements ActionExecutor {
  readonly guaranteeLevel: ActionExecutionGuaranteeLevel;

  constructor(
    private readonly dependencies: {
      routeSnapshotRepository: McpRouteSnapshotRepository;
      serverRegistry: McpDownstreamServerRegistry;
      client: McpDownstreamClient;
      guaranteeLevel?: ActionExecutionGuaranteeLevel;
      telemetry?: TelemetrySink;
    },
  ) {
    this.guaranteeLevel = dependencies.guaranteeLevel ?? "best_effort_at_most_once";
  }

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const route = await this.dependencies.routeSnapshotRepository.load({
      organizationId: request.organizationId,
      actionRequestId: request.actionRequestId,
    });
    if (Result.isFailure(route)) {
      return this.fail(request, null, {
        code: "mcp_route_snapshot_unavailable",
        retriable: route.error.retriable,
        detail: route.error.message,
      });
    }
    const snapshot = route.value;
    if (!snapshot) {
      return this.fail(request, null, {
        code: "mcp_route_snapshot_missing",
        retriable: false,
        detail: "ActionRequestにMCP route snapshotがありません",
      });
    }
    if (
      String(snapshot.actionFingerprint) !== String(request.actionFingerprint) ||
      String(snapshot.actionType) !== String(request.action.type) ||
      String(snapshot.argumentMapping.resourceType) !== String(request.action.resource.type)
    ) {
      return this.fail(request, snapshot, {
        code: "mcp_route_snapshot_mismatch",
        retriable: false,
        detail: "route snapshotが承認されたActionと一致しません",
      });
    }

    const server = await this.dependencies.serverRegistry.resolve(snapshot.target.mcpServerId);
    if (Result.isFailure(server)) {
      return this.fail(request, snapshot, {
        code: "mcp_server_registry_unavailable",
        retriable: server.error.retriable,
        detail: server.error.message,
      });
    }
    if (!server.value) {
      return this.fail(request, snapshot, {
        code: "mcp_server_not_found",
        retriable: false,
        detail: `downstream MCP serverが見つかりません: ${snapshot.target.mcpServerId}`,
      });
    }

    const args: Record<string, unknown> = {
      ...request.action.input,
      [snapshot.argumentMapping.resourceIdArgument]: String(request.action.resource.id),
    };
    const called = await Result.fn({
      try: async () =>
        this.dependencies.client.callTool({
          server: server.value as McpDownstreamServer,
          toolName: snapshot.target.toolName,
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
      return this.fail(request, snapshot, {
        code: outcome.error.code,
        retriable: this.transportRetriable(outcome.error),
        detail: outcome.error.message,
        details: { effect: outcome.error.effect },
      });
    }

    if (outcome.value.type === "jsonrpc_error") {
      return this.fail(request, snapshot, {
        code: mcpJsonRpcExecutorErrorCode(outcome.value.error.code),
        retriable: false,
        detail: outcome.value.error.message,
        details: { jsonrpcCode: outcome.value.error.code },
      });
    }

    const output: McpCallToolOutput = {
      kind: MCP_CALL_TOOL_OUTPUT_KIND,
      mcpServerId: snapshot.target.mcpServerId,
      toolName: snapshot.target.toolName,
      result: outcome.value.result,
    };
    this.emit(request, snapshot, "info", { status: "succeeded" });
    return Result.succeed({ status: "succeeded", output: output as unknown as JsonValue });
  }

  private transportRetriable(error: McpDownstreamTransportError): boolean {
    if (error.effect === "not_sent") return true;
    if (error.effect === "rejected") return error.retryable;
    return this.guaranteeLevel === "idempotent";
  }

  private fail(
    request: ActionExecutionRequest,
    snapshot: McpRouteSnapshot | null,
    input: { code: string; retriable: boolean; detail: string; details?: JsonValue },
  ): Result.Result<never, ActionExecutorError> {
    this.emit(request, snapshot, "error", {
      errorCode: input.code,
      retriable: input.retriable,
    });
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
    snapshot: McpRouteSnapshot | null,
    level: "info" | "error",
    attributes: { status?: string; errorCode?: string; retriable?: boolean },
  ): void {
    this.dependencies.telemetry?.emit(
      safeLogRecord({
        level,
        event: level === "info" ? "executor.completed" : "executor.failed",
        correlation: actionCorrelation({
          organizationId: request.organizationId,
          actionRequestId: request.actionRequestId,
          component: "executor",
          operation: "mcp.tools.call",
        }),
        attributes: {
          ...attributes,
          ...(snapshot
            ? {
                toolName: snapshot.exposedToolName,
                mcpServerId: snapshot.target.mcpServerId,
                bindingVersion: snapshot.bindingVersion,
              }
            : {}),
        },
      }),
    );
  }
}
