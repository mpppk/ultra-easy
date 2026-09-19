import { Result } from "@praha/byethrow";

import type {
  Action,
  ActionRequestId,
  JsonValue,
  OrganizationId,
} from "@app/approval-core";
import type {
  ActionRequestApplicationService,
  ActionRequestSubmitResult,
  ActionRequestView,
  ApprovalReadRepository,
  PublicApiRepositoryError,
  TrustedActionRequestContext,
} from "@app/approval-application";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;
export const MCP_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021 as const;

export type McpExtensions = Record<string, Record<string, unknown>>;

export type McpToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type McpCallToolResult = {
  resultType: "complete";
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "cancelled"
  | "failed";

export type McpTask = {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  result?: McpCallToolResult;
};

export type McpCreateTaskResult = McpTask & {
  resultType: "task";
};

export type McpGetTaskResult = McpTask & {
  resultType: "complete";
};

export type McpProtocolError = {
  code: number;
  message: string;
  data?: Record<string, unknown>;
};

export type McpOutcome<ResultValue> =
  | { type: "result"; result: ResultValue }
  | { type: "error"; error: McpProtocolError };

export class McpAdapterError extends Error {
  readonly name = "McpAdapterError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface McpToolActionMapper {
  map(input: McpToolCall): Result.ResultAsync<Action, McpAdapterError>;
}

export interface McpTrustedContextProvider {
  resolve(input: {
    organizationId: OrganizationId;
    toolCall: McpToolCall;
  }): Result.ResultAsync<TrustedActionRequestContext, McpAdapterError>;
}

export type McpTaskProjectionRecord = {
  taskId: string;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  createdAt: string;
};

export interface McpTaskProjectionRepository {
  save(
    record: McpTaskProjectionRecord,
  ): Result.ResultAsync<void, McpAdapterError>;
  load(
    taskId: string,
  ): Result.ResultAsync<McpTaskProjectionRecord | null, McpAdapterError>;
}

export interface McpTaskIdGenerator {
  next(): string;
}

export interface McpClock {
  now(): string;
}

type ApplicationService = Pick<ActionRequestApplicationService, "submit">;
type ActionRequestReader = Pick<ApprovalReadRepository, "getActionRequest">;

function supportsTasks(extensions: McpExtensions | undefined): boolean {
  return extensions?.[MCP_TASKS_EXTENSION] !== undefined;
}

function requiredTasksCapabilityError(): McpProtocolError {
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

function internalError(error: Error): McpProtocolError {
  return {
    code: -32603,
    message: "Internal error",
    data: { detail: error.message },
  };
}

function invalidTaskError(): McpProtocolError {
  return {
    code: -32602,
    message: "Failed to retrieve task: Task not found",
  };
}

function asStructuredContent(view: ActionRequestView): Record<string, unknown> {
  return view as unknown as Record<string, unknown>;
}

function completeResult(view: ActionRequestView, isError = false): McpCallToolResult {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(view) }],
    structuredContent: asStructuredContent(view),
    ...(isError ? { isError: true } : {}),
  };
}

function deniedResult(result: Extract<ActionRequestSubmitResult, { type: "authorization_denied" }>) {
  const payload = {
    actionRequestId: String(result.actionRequestId),
    code: result.code,
    reason: result.reason,
  };
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  } satisfies McpCallToolResult;
}

function terminalFailure(status: ActionRequestView["status"]): boolean {
  return (
    status === "rejected" ||
    status === "expired" ||
    status === "authorization_revoked" ||
    status === "authorization_check_failed" ||
    status === "execution_failed"
  );
}

function projectTask(input: {
  record: McpTaskProjectionRecord;
  view: ActionRequestView;
  pollIntervalMs: number;
}): McpGetTaskResult {
  const base = {
    resultType: "complete" as const,
    taskId: input.record.taskId,
    createdAt: input.record.createdAt,
    lastUpdatedAt: input.view.updatedAt,
    ttlMs: null,
    pollIntervalMs: input.pollIntervalMs,
  };

  if (input.view.status === "cancelled") {
    return {
      ...base,
      status: "cancelled",
      statusMessage: "ActionRequest was cancelled",
    };
  }

  if (input.view.status === "executed") {
    return {
      ...base,
      status: "completed",
      result: completeResult(input.view),
    };
  }

  if (terminalFailure(input.view.status)) {
    return {
      ...base,
      status: "failed",
      statusMessage: `ActionRequest finished with status ${input.view.status}`,
      result: completeResult(input.view, true),
    };
  }

  return {
    ...base,
    status: "working",
    statusMessage: "ActionRequest is waiting for approval or execution",
  };
}

export class ApprovalMcpAdapter {
  constructor(
    private readonly dependencies: {
      applicationService: ApplicationService;
      actionMapper: McpToolActionMapper;
      trustedContextProvider: McpTrustedContextProvider;
      taskRepository: McpTaskProjectionRepository;
      actionRequestReader: ActionRequestReader;
      taskIdGenerator: McpTaskIdGenerator;
      clock: McpClock;
      pollIntervalMs?: number;
    },
  ) {}

  async callTool(input: {
    organizationId: OrganizationId;
    toolCall: McpToolCall;
    extensions?: McpExtensions;
  }): Promise<McpOutcome<McpCallToolResult | McpCreateTaskResult>> {
    const action = await this.dependencies.actionMapper.map(input.toolCall);
    if (Result.isFailure(action)) {
      return { type: "error", error: internalError(action.error) };
    }

    const trustedContext = await this.dependencies.trustedContextProvider.resolve({
      organizationId: input.organizationId,
      toolCall: input.toolCall,
    });
    if (Result.isFailure(trustedContext)) {
      return { type: "error", error: internalError(trustedContext.error) };
    }

    const submitted = await this.dependencies.applicationService.submit({
      action: action.value,
      trustedContext: trustedContext.value,
    });
    if (Result.isFailure(submitted)) {
      return { type: "error", error: internalError(submitted.error) };
    }
    if (submitted.value.type === "authorization_denied") {
      return { type: "result", result: deniedResult(submitted.value) };
    }

    if (submitted.value.view.status !== "pending_approval") {
      return {
        type: "result",
        result: completeResult(
          submitted.value.view,
          submitted.value.view.status !== "executed",
        ),
      };
    }

    if (!supportsTasks(input.extensions)) {
      return { type: "error", error: requiredTasksCapabilityError() };
    }

    const taskId = this.dependencies.taskIdGenerator.next();
    const createdAt = this.dependencies.clock.now();
    const saved = await this.dependencies.taskRepository.save({
      taskId,
      organizationId: input.organizationId,
      actionRequestId: submitted.value.actionRequestId,
      createdAt,
    });
    if (Result.isFailure(saved)) {
      return { type: "error", error: internalError(saved.error) };
    }

    return {
      type: "result",
      result: {
        resultType: "task",
        taskId,
        status: "working",
        statusMessage: "ActionRequest is waiting for approval",
        createdAt,
        lastUpdatedAt: createdAt,
        ttlMs: null,
        pollIntervalMs: this.dependencies.pollIntervalMs ?? 1000,
      },
    };
  }

  async getTask(input: {
    taskId: string;
    extensions?: McpExtensions;
  }): Promise<McpOutcome<McpGetTaskResult>> {
    if (!supportsTasks(input.extensions)) {
      return { type: "error", error: requiredTasksCapabilityError() };
    }

    const record = await this.dependencies.taskRepository.load(input.taskId);
    if (Result.isFailure(record)) {
      return { type: "error", error: internalError(record.error) };
    }
    if (!record.value) {
      return { type: "error", error: invalidTaskError() };
    }

    const loaded = await this.dependencies.actionRequestReader.getActionRequest({
      organizationId: record.value.organizationId,
      actionRequestId: record.value.actionRequestId,
    });
    if (Result.isFailure(loaded)) {
      return { type: "error", error: internalError(loaded.error) };
    }
    if (!loaded.value) {
      return { type: "error", error: invalidTaskError() };
    }

    return {
      type: "result",
      result: projectTask({
        record: record.value,
        view: loaded.value,
        pollIntervalMs: this.dependencies.pollIntervalMs ?? 1000,
      }),
    };
  }
}
