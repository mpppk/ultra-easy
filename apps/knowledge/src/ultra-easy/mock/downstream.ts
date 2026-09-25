import { Result } from "@praha/byethrow";

export type DownstreamOutcome =
  | { type: "success"; data: Record<string, unknown> }
  | {
      type: "tool_error";
      code: string;
      message: string;
      retriable: boolean;
      data: Record<string, unknown>;
    }
  | { type: "transport_error"; code: string; message: string };

/** What the (mock) MCP ActionExecutor needs: one `tools/call` per execution. */
export interface McpDownstream {
  callTool(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    actionRequestId: string;
  }): Promise<DownstreamOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Streamable HTTP `tools/call` in the same shape as ultra-easy's
 * `StreamableHttpMcpDownstreamClient` (2026-07-28, idempotency key in `_meta`).
 * `send` is `fetch` to the Knowledge `/mcp` endpoint, or the in-process handler.
 */
export function streamableHttpDownstream(input: {
  endpoint: string;
  token: string;
  send: (request: Request) => Promise<Response>;
}): McpDownstream {
  return {
    async callTool(call) {
      const id = crypto.randomUUID();
      const response = await Result.try({
        try: () =>
          input.send(
            new Request(input.endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${input.token}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2026-07-28",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name: call.toolName,
                  arguments: call.arguments,
                  _meta: {
                    "dev.ultra-easy/idempotencyKey": call.idempotencyKey,
                    "dev.ultra-easy/actionRequestId": call.actionRequestId,
                  },
                },
              }),
            }),
          ),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      });
      if (Result.isFailure(response)) {
        return {
          type: "transport_error",
          code: "mcp_downstream_network_error",
          message: response.error,
        };
      }
      if (!response.value.ok) {
        return {
          type: "transport_error",
          code: "mcp_downstream_http_error",
          message: `HTTP ${response.value.status}`,
        };
      }
      const body = await Result.try({
        try: async (): Promise<unknown> => response.value.json(),
        catch: () => null,
      });
      const message = Result.isSuccess(body) ? body.value : null;
      if (!isRecord(message) || message.id !== id) {
        return {
          type: "transport_error",
          code: "mcp_downstream_invalid_response",
          message: "not a JSON-RPC response",
        };
      }
      if (isRecord(message.error)) {
        return {
          type: "tool_error",
          code: "mcp_protocol_error",
          message: typeof message.error.message === "string" ? message.error.message : "error",
          retriable: false,
          data: {},
        };
      }
      const result = isRecord(message.result) ? message.result : {};
      const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
      if (result.isError === true) {
        return {
          type: "tool_error",
          code: typeof structured.code === "string" ? structured.code : "tool_error",
          message: typeof structured.message === "string" ? structured.message : "tool failed",
          retriable: structured.retriable === true,
          data: structured,
        };
      }
      return { type: "success", data: structured };
    },
  };
}
