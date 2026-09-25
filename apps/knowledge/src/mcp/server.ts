import { Result } from "@praha/byethrow";

import {
  runTool,
  toolDescriptors,
  findTool,
  type ToolDependencies,
  type ToolOutcome,
} from "./tools.ts";

/**
 * Streamable HTTP MCP endpoint (`POST /mcp`) for the ultra-easy MCP Gateway.
 *
 * Wire contract matches the Gateway's pinned revision (docs/mcp-gateway.md):
 * stateless `2026-07-28`, `server/discover` / `tools/list` / `tools/call`,
 * `dev.ultra-easy/idempotencyKey` for persistent downstream dedupe. Like the
 * Gateway, it speaks the protocol directly instead of depending on an SDK.
 */
export const MCP_PROTOCOL_REVISION = "2026-07-28";
export const IDEMPOTENCY_KEY_META = "dev.ultra-easy/idempotencyKey";
export const ACTION_REQUEST_ID_META = "dev.ultra-easy/actionRequestId";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export type McpServerDependencies = ToolDependencies & {
  /** Service credential the Gateway presents (Bearer). Undefined fails closed. */
  token: string | undefined;
};

type JsonRpcId = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function toolResult(outcome: ToolOutcome) {
  if (outcome.type === "success") {
    return {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
    };
  }
  const structured = {
    code: outcome.code,
    message: outcome.message,
    retriable: outcome.retriable,
    ...outcome.data,
  };
  return {
    resultType: "complete",
    content: [{ type: "text", text: `${outcome.code}: ${outcome.message}` }],
    structuredContent: structured,
    isError: true,
  };
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < x.length; index += 1) diff |= (x[index] ?? 0) ^ (y[index] ?? 0);
  return diff === 0;
}

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), token);
}

async function callTool(
  id: JsonRpcId,
  params: Record<string, unknown>,
  dependencies: McpServerDependencies,
): Promise<Response> {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = findTool(name);
  if (!tool) return rpcError(id, JSONRPC_INVALID_PARAMS, "Unknown tool");
  const meta = isRecord(params._meta) ? params._meta : {};
  const idempotencyKey =
    typeof meta[IDEMPOTENCY_KEY_META] === "string" ? meta[IDEMPOTENCY_KEY_META] : null;
  const argumentsJson = JSON.stringify(params.arguments ?? {});

  // Persistent downstream dedupe: a replayed ActionRequest execution returns
  // the recorded result instead of repeating the mutation.
  if (idempotencyKey !== null && !tool.readOnly) {
    const stored = await dependencies.repos.effects.findInvocation(idempotencyKey);
    if (Result.isFailure(stored)) {
      return rpcError(id, JSONRPC_INTERNAL_ERROR, "Knowledge store unavailable", {
        code: "knowledge_store_unavailable",
        retriable: true,
      });
    }
    if (stored.value) {
      if (stored.value.toolName !== name || stored.value.argumentsJson !== argumentsJson) {
        return rpcError(id, JSONRPC_INVALID_PARAMS, "Idempotency key reused for another call");
      }
      const replayed = Result.try({
        try: (): unknown => JSON.parse(stored.value?.resultJson ?? "null"),
        catch: () => null,
      });
      if (Result.isSuccess(replayed)) return rpcResult(id, replayed.value);
    }
  }

  const outcome = await runTool(name, params.arguments, dependencies);
  if (!outcome) return rpcError(id, JSONRPC_INVALID_PARAMS, "Unknown tool");
  const result = toolResult(outcome);
  const final = outcome.type === "success" || !outcome.retriable;
  if (idempotencyKey !== null && !tool.readOnly && final) {
    // Recording is best-effort: every tool is itself idempotent on replay.
    await dependencies.repos.effects.recordInvocation({
      idempotencyKey,
      toolName: name,
      argumentsJson,
      resultJson: JSON.stringify(result),
      now: dependencies.now(),
    });
  }
  return rpcResult(id, result);
}

export async function handleMcpRequest(
  request: Request,
  dependencies: McpServerDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!(await authorized(request, dependencies.token))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="knowledge-mcp"' },
    });
  }
  if (request.headers.get("mcp-protocol-version") !== MCP_PROTOCOL_REVISION) {
    return new Response("Unsupported MCP-Protocol-Version", { status: 400 });
  }
  const text = await Result.try({ try: () => request.text(), catch: () => null });
  if (Result.isFailure(text)) return rpcError(null, JSONRPC_PARSE_ERROR, "Parse error");
  const message = Result.try({ try: (): unknown => JSON.parse(text.value), catch: () => null });
  if (Result.isFailure(message)) return rpcError(null, JSONRPC_PARSE_ERROR, "Parse error");
  const body = message.value;
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid Request");
  }
  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  // Notifications carry no id and get no response body.
  if (id === null) return new Response(null, { status: 202 });
  const params = isRecord(body.params) ? body.params : {};

  switch (body.method) {
    case "server/discover":
      return rpcResult(id, {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_REVISION],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ultra-easy-knowledge", version: "0.1.0" },
      });
    case "tools/list":
      return rpcResult(id, { resultType: "complete", tools: toolDescriptors() });
    case "tools/call":
      return callTool(id, params, dependencies);
    default:
      return rpcError(id, JSONRPC_METHOD_NOT_FOUND, "Method not found");
  }
}
