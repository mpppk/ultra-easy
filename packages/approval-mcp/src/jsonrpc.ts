import type { OrganizationId } from "@app/approval-core";

import type { McpGateway } from "./gateway.ts";
import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  MCP_PROTOCOL_REVISION,
  type McpOutcome,
  type McpProtocolError,
} from "./protocol.ts";

export type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: McpProtocolError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, error: McpProtocolError): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error };
}

function toResponse(id: JsonRpcId, outcome: McpOutcome<unknown>): JsonRpcResponse {
  return outcome.type === "result"
    ? { jsonrpc: "2.0", id, result: outcome.result }
    : errorResponse(id, outcome.error);
}

/**
 * MCP Gateway methodのJSON-RPC dispatcher。
 * request idはresponse相関だけに使い、logical invocation identityには使わない。
 * notification（id無し）とbatchは受け付けない。
 */
export async function handleMcpGatewayJsonRpc(input: {
  gateway: McpGateway;
  organizationId: OrganizationId;
  message: unknown;
}): Promise<JsonRpcResponse | null> {
  const message = input.message;
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(null, { code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" });
  }
  if (!("id" in message)) return null;
  const id = message.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return errorResponse(null, { code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" });
  }

  const request = { organizationId: input.organizationId, params: message.params };
  switch (message.method) {
    case "server/discover":
      return { jsonrpc: "2.0", id, result: input.gateway.discover() };
    case "tools/list":
      return toResponse(id, await input.gateway.listTools(request));
    case "tools/call":
      return toResponse(id, await input.gateway.callTool(request));
    case "tasks/get":
      return toResponse(id, await input.gateway.getTask(request));
    case "tasks/update":
      return toResponse(id, await input.gateway.updateTask(request));
    case "tasks/cancel":
      return toResponse(id, await input.gateway.cancelTask(request));
    default:
      return errorResponse(id, {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: `Method not found: ${message.method}`,
      });
  }
}

/**
 * Streamable HTTP（POST / JSON response）でGatewayを公開するhandler。
 * organizationは認証済みrouteから渡し、request bodyからは受け取らない。
 */
export async function handleMcpGatewayHttpRequest(input: {
  request: Request;
  organizationId: OrganizationId;
  gateway: McpGateway;
}): Promise<Response> {
  if (input.request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const version = input.request.headers.get("mcp-protocol-version");
  if (version !== null && version !== MCP_PROTOCOL_REVISION) {
    return Response.json(
      errorResponse(null, {
        code: JSONRPC_INVALID_REQUEST,
        message: "Unsupported protocol version",
        data: { supported: [MCP_PROTOCOL_REVISION], requested: version },
      }),
      { status: 400 },
    );
  }
  const message = await input.request.json().catch(() => undefined);
  if (message === undefined) {
    return Response.json(
      errorResponse(null, { code: JSONRPC_PARSE_ERROR, message: "Parse error" }),
      { status: 400 },
    );
  }
  const response = await handleMcpGatewayJsonRpc({
    gateway: input.gateway,
    organizationId: input.organizationId,
    message,
  });
  return response === null ? new Response(null, { status: 202 }) : Response.json(response);
}
