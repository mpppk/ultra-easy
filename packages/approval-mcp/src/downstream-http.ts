import { Result } from "@praha/byethrow";

import type { McpGatewayError } from "./binding.ts";
import {
  McpDownstreamTransportError,
  type McpDownstreamCallOutcome,
  type McpDownstreamClient,
  type McpDownstreamServer,
} from "./executor.ts";
import {
  MCP_ACTION_REQUEST_ID_META_KEY,
  MCP_EXECUTION_IDEMPOTENCY_KEY_META_KEY,
  MCP_PROTOCOL_REVISION,
  parseCallToolResult,
  parseProtocolError,
} from "./protocol.ts";

/** downstream認証の境界。credentialはbinding / route snapshotへ保存せず、ここで都度解決する。 */
export interface McpDownstreamCredentialProvider {
  headers(input: {
    server: McpDownstreamServer;
  }): Result.ResultAsync<Record<string, string>, McpGatewayError>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const parseJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: () => null,
});

/** SSE response bodyから、指定idのJSON-RPC responseを取り出す。 */
function jsonRpcMessageFromSse(body: string, id: string): unknown {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    const parsed = parseJson(data);
    if (Result.isSuccess(parsed) && isRecord(parsed.value) && parsed.value.id === id) {
      return parsed.value;
    }
  }
  return null;
}

function statusFailure(status: number): McpDownstreamTransportError {
  if (status === 401 || status === 403) {
    return new McpDownstreamTransportError(
      "mcp_downstream_unauthorized",
      "rejected",
      false,
      `downstream MCP serverが認証を拒否しました (HTTP ${status})`,
    );
  }
  if (status === 429 || status === 503) {
    return new McpDownstreamTransportError(
      "mcp_downstream_unavailable",
      "rejected",
      true,
      `downstream MCP serverが一時的に利用できません (HTTP ${status})`,
    );
  }
  if (status >= 500 || status === 408) {
    return new McpDownstreamTransportError(
      "mcp_downstream_http_error",
      "ambiguous",
      false,
      `downstream MCP serverがerrorを返しました (HTTP ${status})`,
    );
  }
  return new McpDownstreamTransportError(
    "mcp_downstream_http_error",
    "rejected",
    false,
    `downstream MCP serverがrequestを拒否しました (HTTP ${status})`,
  );
}

/**
 * MCP 2026-07-28 Streamable HTTP transportでdownstreamの `tools/call` を1回POSTするclient。
 * stateless revisionなのでsession / initializeは使わず、Tasks capabilityも宣言しない
 * （downstreamはCreateTaskResultを返してはならない）。
 */
export class StreamableHttpMcpDownstreamClient implements McpDownstreamClient {
  constructor(
    private readonly dependencies: {
      credentials?: McpDownstreamCredentialProvider;
      fetch?: FetchLike;
      requestId?: () => string;
    } = {},
  ) {}

  async callTool(input: {
    server: McpDownstreamServer;
    toolName: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    actionRequestId: string;
  }): Result.ResultAsync<McpDownstreamCallOutcome, McpDownstreamTransportError> {
    const headers: Record<string, string> = {};
    if (this.dependencies.credentials) {
      const resolved = await this.dependencies.credentials.headers({ server: input.server });
      if (Result.isFailure(resolved)) {
        return Result.fail(
          new McpDownstreamTransportError(
            "mcp_downstream_credentials_unavailable",
            "not_sent",
            true,
            resolved.error.message,
          ),
        );
      }
      Object.assign(headers, resolved.value);
    }

    const id = this.dependencies.requestId?.() ?? crypto.randomUUID();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.arguments,
        _meta: {
          [MCP_EXECUTION_IDEMPOTENCY_KEY_META_KEY]: input.idempotencyKey,
          [MCP_ACTION_REQUEST_ID_META_KEY]: input.actionRequestId,
        },
      },
    });
    const fetcher = this.dependencies.fetch ?? ((url, init) => fetch(url, init));
    const response = await Result.fn({
      try: async () =>
        fetcher(input.server.endpoint, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_REVISION,
          },
          body,
          signal: AbortSignal.timeout(input.server.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        }),
      catch: (error) =>
        new McpDownstreamTransportError(
          error instanceof Error && error.name === "TimeoutError"
            ? "mcp_downstream_timeout"
            : "mcp_downstream_network_error",
          "ambiguous",
          false,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    if (Result.isFailure(response)) return response;
    if (!response.value.ok) return Result.fail(statusFailure(response.value.status));

    const text = await Result.fn({
      try: async () => response.value.text(),
      catch: (error) =>
        new McpDownstreamTransportError(
          "mcp_downstream_network_error",
          "ambiguous",
          false,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    if (Result.isFailure(text)) return text;

    const contentType = response.value.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.parseResponse(jsonRpcMessageFromSse(text.value, id), id);
    }
    const parsed = parseJson(text.value);
    return this.parseResponse(Result.isSuccess(parsed) ? parsed.value : null, id);
  }

  private parseResponse(
    message: unknown,
    id: string,
  ): Result.Result<McpDownstreamCallOutcome, McpDownstreamTransportError> {
    const invalid = (detail: string) =>
      Result.fail(
        new McpDownstreamTransportError(
          "mcp_downstream_invalid_response",
          "ambiguous",
          false,
          detail,
        ),
      );
    if (!isRecord(message) || message.jsonrpc !== "2.0" || message.id !== id) {
      return invalid("downstream responseがJSON-RPC 2.0 responseではありません");
    }
    if (message.error !== undefined) {
      const error = parseProtocolError(message.error);
      return error
        ? Result.succeed({ type: "jsonrpc_error", error })
        : invalid("downstream JSON-RPC errorの形式が不正です");
    }
    if (isRecord(message.result) && message.result.resultType === "task") {
      return invalid("Tasks非宣言requestへdownstreamがCreateTaskResultを返しました");
    }
    const result = parseCallToolResult(message.result);
    return result
      ? Result.succeed({ type: "result", result })
      : invalid("CallToolResultが不正です");
  }
}
