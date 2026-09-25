import type { JsonValue } from "@app/approval-core";
import type { ActionRequestView } from "@app/approval-application";

import type { McpInvocationRecord, McpStoredResponse } from "./invocation.ts";
import {
  JSONRPC_INTERNAL_ERROR,
  parseCallToolResult,
  textResult,
  type McpCallToolResult,
  type McpGetTaskResult,
  type McpProtocolError,
  type McpTask,
} from "./protocol.ts";

/** McpActionExecutorがActionExecutionResult.outputへ入れるdownstream結果のenvelope。 */
export const MCP_CALL_TOOL_OUTPUT_KIND = "mcp.call_tool_result" as const;

export type McpCallToolOutput = {
  kind: typeof MCP_CALL_TOOL_OUTPUT_KIND;
  mcpServerId: string;
  toolName: string;
  result: McpCallToolResult;
};

const JSONRPC_EXECUTOR_ERROR_PREFIX = "mcp_jsonrpc_error:";

/**
 * downstreamがJSON-RPC errorを返したことをActionExecutorError.codeへ保存する形式。
 * ActionRequestのresult projectionはcode / messageだけを永続化するため、
 * JSON-RPC error codeをcodeへ埋め込みTask projectionで `failed + error` へ復元する。
 */
export function mcpJsonRpcExecutorErrorCode(code: number): string {
  return `${JSONRPC_EXECUTOR_ERROR_PREFIX}${code}`;
}

export function parseMcpJsonRpcExecutorErrorCode(code: string | undefined): number | null {
  if (code === undefined || !code.startsWith(JSONRPC_EXECUTOR_ERROR_PREFIX)) return null;
  const parsed = Number(code.slice(JSONRPC_EXECUTOR_ERROR_PREFIX.length));
  return Number.isInteger(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mcpCallToolOutput(output: JsonValue | undefined): McpCallToolOutput | null {
  if (!isRecord(output) || output.kind !== MCP_CALL_TOOL_OUTPUT_KIND) return null;
  const result = parseCallToolResult(output.result);
  if (!result || typeof output.mcpServerId !== "string" || typeof output.toolName !== "string") {
    return null;
  }
  return {
    kind: MCP_CALL_TOOL_OUTPUT_KIND,
    mcpServerId: output.mcpServerId,
    toolName: output.toolName,
    result,
  };
}

function toolLevelError(view: ActionRequestView, message: string): McpCallToolResult {
  return textResult(
    {
      actionRequestId: view.id,
      status: view.status,
      message,
      ...(view.result?.code !== undefined ? { code: view.result.code } : {}),
    },
    { isError: true },
  );
}

/** executed ActionRequestのtool result。downstream CallToolResult（isError含む）をそのまま返す。 */
export function executedCallToolResult(view: ActionRequestView): McpCallToolResult {
  const output = mcpCallToolOutput(view.result?.output);
  if (output) return output.result;
  return textResult({
    actionRequestId: view.id,
    status: view.status,
    ...(view.result?.output !== undefined ? { output: view.result.output } : {}),
  });
}

/** execution / Re-Authorization providerの失敗をJSON-RPC errorとして表す。 */
export function executionProtocolError(input: {
  actionRequestId: string;
  code: string | undefined;
  message: string | undefined;
  provenance: "downstream" | "execution" | "reauthorization";
}): McpProtocolError {
  const jsonRpcCode = parseMcpJsonRpcExecutorErrorCode(input.code);
  if (jsonRpcCode !== null) {
    return {
      code: jsonRpcCode,
      message: input.message ?? "Downstream MCP tool call failed",
      data: { actionRequestId: input.actionRequestId, provenance: "downstream" },
    };
  }
  return {
    code: JSONRPC_INTERNAL_ERROR,
    message: "Internal error",
    data: {
      actionRequestId: input.actionRequestId,
      provenance: input.provenance,
      ...(input.code !== undefined ? { code: input.code } : {}),
    },
  };
}

export type McpTerminalProjection =
  | { status: "working"; statusMessage: string }
  | { status: "completed"; statusMessage: string; result: McpCallToolResult }
  | { status: "failed"; statusMessage: string; error: McpProtocolError }
  | { status: "cancelled"; statusMessage: string };

/**
 * ActionRequest viewをTask状態へ投影する。status文字列だけでなくresult / error provenanceを見て、
 * tool result（isError含む）は `completed`、JSON-RPC errorだけを `failed` にする。
 */
export function projectActionRequest(view: ActionRequestView): McpTerminalProjection {
  switch (view.status) {
    case "evaluating":
    case "pending_approval":
    case "approved":
    case "executing":
      return {
        status: "working",
        statusMessage:
          view.status === "pending_approval"
            ? "ActionRequest is waiting for approval"
            : "ActionRequest is being executed",
      };
    case "executed":
      return {
        status: "completed",
        statusMessage: "ActionRequest was executed",
        result: executedCallToolResult(view),
      };
    case "rejected":
      return {
        status: "completed",
        statusMessage: "ActionRequest was rejected",
        result: toolLevelError(view, "ActionRequest was rejected by an approver"),
      };
    case "expired":
      return {
        status: "completed",
        statusMessage: "ActionRequest approval expired",
        result: toolLevelError(view, "ActionRequest approval expired"),
      };
    case "authorization_revoked":
      return {
        status: "completed",
        statusMessage: "ActionRequest authorization was revoked before execution",
        result: toolLevelError(view, "Authorization was revoked before execution"),
      };
    case "authorization_check_failed":
      return {
        status: "failed",
        statusMessage: "Authorization could not be re-checked before execution",
        error: executionProtocolError({
          actionRequestId: view.id,
          code: view.result?.code,
          message: view.result?.message,
          provenance: "reauthorization",
        }),
      };
    case "execution_failed":
      return {
        status: "failed",
        statusMessage: "Tool execution failed",
        error: executionProtocolError({
          actionRequestId: view.id,
          code: view.result?.code,
          message: view.result?.message,
          provenance: "execution",
        }),
      };
    case "execution_unknown":
      return {
        status: "failed",
        statusMessage: "Tool execution outcome is unknown and requires reconciliation",
        error: executionProtocolError({
          actionRequestId: view.id,
          code: view.result?.code,
          message: view.result?.message,
          provenance: "execution",
        }),
      };
    case "cancelled":
      return { status: "cancelled", statusMessage: "ActionRequest was cancelled" };
  }
}

function projectStoredResponse(response: McpStoredResponse): McpTerminalProjection {
  switch (response.type) {
    case "result":
      return { status: "completed", statusMessage: "Tool call completed", result: response.result };
    case "error":
      return { status: "failed", statusMessage: "Tool call failed", error: response.error };
    case "cancelled":
      return { status: "cancelled", statusMessage: "Tool call was cancelled before admission" };
  }
}

export function taskFields(input: {
  record: McpInvocationRecord;
  projection: McpTerminalProjection;
  lastUpdatedAt: string;
  pollIntervalMs: number;
}): McpTask {
  return {
    taskId: input.record.taskId ?? "",
    status: input.projection.status,
    statusMessage: input.projection.statusMessage,
    createdAt: input.record.taskCreatedAt ?? input.record.createdAt,
    lastUpdatedAt: input.lastUpdatedAt,
    ttlMs: input.record.ttlMs ?? null,
    pollIntervalMs: input.pollIntervalMs,
  };
}

/** invocation record（+ commit済みならActionRequest view）からtasks/get結果を作る。 */
export function projectMcpTask(input: {
  record: McpInvocationRecord;
  view: ActionRequestView | null;
  pollIntervalMs: number;
}): McpGetTaskResult {
  const { record, view } = input;
  const projection: McpTerminalProjection =
    record.status === "completed" && record.response
      ? projectStoredResponse(record.response)
      : record.status === "committed" && view
        ? projectActionRequest(view)
        : {
            status: "working",
            statusMessage:
              record.status === "committed"
                ? "ActionRequest projection is not yet available"
                : "Tool call admission is pending",
          };
  const lastUpdatedAt =
    view && view.updatedAt > record.updatedAt ? view.updatedAt : record.updatedAt;
  return {
    resultType: "complete",
    ...taskFields({ record, projection, lastUpdatedAt, pollIntervalMs: input.pollIntervalMs }),
    ...(projection.status === "completed" ? { result: projection.result } : {}),
    ...(projection.status === "failed" ? { error: projection.error } : {}),
  };
}
