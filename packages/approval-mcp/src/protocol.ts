import { Result } from "@praha/byethrow";

/**
 * MCP Gatewayが従うwire contract。
 *
 * - MCP protocol revision: 2026-07-28（per-requestの `_meta` でclient capabilityを宣言するstateless revision）
 * - Tasks extension: `io.modelcontextprotocol/tasks`（SEP-2663）
 *
 * SDKへ依存せず、ここで定義したmethod / payload / error codeをcontract testで固定する。
 */
export const MCP_PROTOCOL_REVISION = "2026-07-28" as const;
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;
export const MCP_TASKS_EXTENSION_SEP = "SEP-2663" as const;
export const MCP_TASKS_SPECIFICATION_URL =
  "https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks" as const;

/** per-request client capabilityを運ぶ `_meta` key（2026-07-28）。 */
export const MCP_CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities" as const;
/**
 * clientが同じlogical `tools/call` を再送するときに付けるstableなkey。
 * JSON-RPC request idやtransport sessionはlogical invocation identityに使わない。
 */
export const MCP_INVOCATION_KEY_META_KEY = "dev.ultra-easy/invocationKey" as const;
/** downstream MCP serverへ渡すexecution idempotency key。 */
export const MCP_EXECUTION_IDEMPOTENCY_KEY_META_KEY = "dev.ultra-easy/idempotencyKey" as const;
/** downstream MCP serverへ渡すActionRequest ID（telemetry相関用）。 */
export const MCP_ACTION_REQUEST_ID_META_KEY = "dev.ultra-easy/actionRequestId" as const;

export const MCP_INVOCATION_KEY_MAX_LENGTH = 255;

export const JSONRPC_PARSE_ERROR = -32700 as const;
export const JSONRPC_INVALID_REQUEST = -32600 as const;
export const JSONRPC_METHOD_NOT_FOUND = -32601 as const;
export const JSONRPC_INVALID_PARAMS = -32602 as const;
export const JSONRPC_INTERNAL_ERROR = -32603 as const;
export const MCP_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021 as const;
/** 以下はimplementation-defined server error（-32000〜-32099）。 */
export const MCP_RATE_LIMITED = -32029 as const;
export const MCP_INVOCATION_CONFLICT = -32030 as const;
export const MCP_INVOCATION_IN_PROGRESS = -32031 as const;
export const MCP_TASK_OPERATION_FORBIDDEN = -32032 as const;

export type McpJsonSchema = Record<string, unknown>;
export type McpRequestMeta = Record<string, unknown>;
export type McpExtensions = Record<string, Record<string, unknown>>;

export type McpContent =
  | { type: "text"; text: string }
  | ({ type: string } & Record<string, unknown>);

export type McpCallToolResult = {
  resultType: "complete";
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpTaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";

export type McpTask = {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
};

export type McpCreateTaskResult = McpTask & {
  resultType: "task";
};

export type McpProtocolError = {
  code: number;
  message: string;
  data?: Record<string, unknown>;
};

/**
 * `tasks/get` の結果。
 * `completed` はtool resultを返したrequest（`result.isError=true` を含む）、
 * `failed` はJSON-RPC errorになったrequestだけに使う。
 */
export type McpGetTaskResult = McpTask & {
  resultType: "complete";
  result?: McpCallToolResult;
  error?: McpProtocolError;
  inputRequests?: Record<string, unknown>;
};

export type McpEmptyResult = { resultType: "complete" };

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  annotations?: Record<string, unknown>;
};

export type McpListToolsResult = {
  resultType: "complete";
  tools: McpToolDefinition[];
  nextCursor?: string;
};

export type McpDiscoverResult = {
  resultType: "complete";
  supportedVersions: string[];
  capabilities: {
    tools: { listChanged: boolean };
    extensions: McpExtensions;
  };
  serverInfo: { name: string; version: string };
};

export type McpOutcome<ResultValue> =
  | { type: "result"; result: ResultValue }
  | { type: "error"; error: McpProtocolError };

export type McpCallToolParams = {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: McpRequestMeta;
};

export type McpTaskParams = {
  taskId: string;
  _meta?: McpRequestMeta;
};

export type McpUpdateTaskParams = McpTaskParams & {
  inputResponses: Record<string, unknown>;
};

export type McpListToolsParams = {
  cursor?: string;
  _meta?: McpRequestMeta;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` を読む。 */
export function clientExtensions(meta: McpRequestMeta | undefined): McpExtensions | undefined {
  const capabilities = meta?.[MCP_CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) return undefined;
  return capabilities.extensions as McpExtensions;
}

export function clientSupportsTasks(meta: McpRequestMeta | undefined): boolean {
  return isRecord(clientExtensions(meta)?.[MCP_TASKS_EXTENSION]);
}

/** Tasks capabilityを宣言した `_meta`（client / testが組み立てる用）。 */
export function tasksCapableMeta(extra: McpRequestMeta = {}): McpRequestMeta {
  return {
    ...extra,
    [MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
  };
}

export function readInvocationKey(
  meta: McpRequestMeta | undefined,
): Result.Result<string | undefined, McpProtocolError> {
  const value = meta?.[MCP_INVOCATION_KEY_META_KEY];
  if (value === undefined) return Result.succeed(undefined);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MCP_INVOCATION_KEY_MAX_LENGTH
  ) {
    return Result.fail(
      invalidParamsError(
        `${MCP_INVOCATION_KEY_META_KEY} must be a non-empty string up to ${MCP_INVOCATION_KEY_MAX_LENGTH} characters`,
      ),
    );
  }
  return Result.succeed(value);
}

export function parseCallToolParams(
  params: unknown,
): Result.Result<McpCallToolParams, McpProtocolError> {
  if (!isRecord(params) || typeof params.name !== "string" || params.name.length === 0) {
    return Result.fail(invalidParamsError("tools/call requires params.name"));
  }
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    return Result.fail(invalidParamsError("tools/call params.arguments must be an object"));
  }
  if (params._meta !== undefined && !isRecord(params._meta)) {
    return Result.fail(invalidParamsError("params._meta must be an object"));
  }
  return Result.succeed({
    name: params.name,
    ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
    ...(params._meta !== undefined ? { _meta: params._meta } : {}),
  });
}

export function parseTaskParams(params: unknown): Result.Result<McpTaskParams, McpProtocolError> {
  if (!isRecord(params) || typeof params.taskId !== "string" || params.taskId.length === 0) {
    return Result.fail(invalidParamsError("params.taskId is required"));
  }
  if (params._meta !== undefined && !isRecord(params._meta)) {
    return Result.fail(invalidParamsError("params._meta must be an object"));
  }
  return Result.succeed({
    taskId: params.taskId,
    ...(params._meta !== undefined ? { _meta: params._meta } : {}),
  });
}

export function parseUpdateTaskParams(
  params: unknown,
): Result.Result<McpUpdateTaskParams, McpProtocolError> {
  const base = parseTaskParams(params);
  if (Result.isFailure(base)) return base;
  const inputResponses = isRecord(params) ? params.inputResponses : undefined;
  if (!isRecord(inputResponses)) {
    return Result.fail(invalidParamsError("tasks/update requires params.inputResponses"));
  }
  return Result.succeed({ ...base.value, inputResponses });
}

export function parseListToolsParams(
  params: unknown,
): Result.Result<McpListToolsParams, McpProtocolError> {
  if (params === undefined) return Result.succeed({});
  if (!isRecord(params)) return Result.fail(invalidParamsError("params must be an object"));
  if (params.cursor !== undefined && typeof params.cursor !== "string") {
    return Result.fail(invalidParamsError("params.cursor must be a string"));
  }
  if (params._meta !== undefined && !isRecord(params._meta)) {
    return Result.fail(invalidParamsError("params._meta must be an object"));
  }
  return Result.succeed({
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    ...(params._meta !== undefined ? { _meta: params._meta } : {}),
  });
}

export function invalidParamsError(
  message: string,
  data?: Record<string, unknown>,
): McpProtocolError {
  return { code: JSONRPC_INVALID_PARAMS, message, ...(data ? { data } : {}) };
}

export function internalError(data?: Record<string, unknown>): McpProtocolError {
  return { code: JSONRPC_INTERNAL_ERROR, message: "Internal error", ...(data ? { data } : {}) };
}

/** hidden toolとunknown toolを外部から区別できないよう、同じerrorを返す。 */
export function unknownToolError(name: string): McpProtocolError {
  return { code: JSONRPC_INVALID_PARAMS, message: `Unknown tool: ${name}` };
}

export function requiredTasksCapabilityError(): McpProtocolError {
  return {
    code: MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
    message: "Missing required client capability",
    data: {
      requiredCapabilities: {
        extensions: {
          [MCP_TASKS_EXTENSION]: {},
        },
      },
    },
  };
}

/** 存在しない / 他ownerのtaskを区別せず同じerrorにする。 */
export function taskNotFoundError(): McpProtocolError {
  return {
    code: JSONRPC_INVALID_PARAMS,
    message: "Failed to retrieve task: Task not found",
  };
}

export function taskOperationForbiddenError(operation: string, code: string): McpProtocolError {
  return {
    code: MCP_TASK_OPERATION_FORBIDDEN,
    message: `Task operation is not permitted: ${operation}`,
    data: { code },
  };
}

export function rateLimitedError(input: {
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  resetAt: string;
}): McpProtocolError {
  return {
    code: MCP_RATE_LIMITED,
    message: "Too Many Requests",
    data: {
      retryAfterSeconds: input.retryAfterSeconds,
      limit: input.limit,
      remaining: input.remaining,
      resetAt: input.resetAt,
    },
  };
}

export function invocationConflictError(): McpProtocolError {
  return {
    code: MCP_INVOCATION_CONFLICT,
    message: "Invocation key was reused with a different request",
  };
}

export function invocationInProgressError(retryAfterMs: number): McpProtocolError {
  return {
    code: MCP_INVOCATION_IN_PROGRESS,
    message: "The same logical invocation is being processed",
    data: { retriable: true, retryAfterMs },
  };
}

export function textResult(
  payload: Record<string, unknown>,
  options: { isError?: boolean } = {},
): McpCallToolResult {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(options.isError ? { isError: true } : {}),
  };
}

/** downstream / 保存済みpayloadがCallToolResultとして妥当か確認する。 */
export function parseCallToolResult(value: unknown): McpCallToolResult | null {
  if (!isRecord(value) || !Array.isArray(value.content)) return null;
  if (value.resultType !== undefined && value.resultType !== "complete") return null;
  if (!value.content.every((item) => isRecord(item) && typeof item.type === "string")) return null;
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) return null;
  if (value.isError !== undefined && typeof value.isError !== "boolean") return null;
  return {
    resultType: "complete",
    content: value.content as McpContent[],
    ...(value.structuredContent !== undefined
      ? { structuredContent: value.structuredContent }
      : {}),
    ...(value.isError === true ? { isError: true } : {}),
  };
}

export function parseProtocolError(value: unknown): McpProtocolError | null {
  if (!isRecord(value) || typeof value.code !== "number" || !Number.isInteger(value.code)) {
    return null;
  }
  if (typeof value.message !== "string") return null;
  return {
    code: value.code,
    message: value.message,
    ...(isRecord(value.data) ? { data: value.data } : {}),
  };
}
