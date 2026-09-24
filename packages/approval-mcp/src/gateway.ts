import { Result } from "@praha/byethrow";

import {
  DEFAULT_MCP_TOOL_CALL_RATE_LIMIT,
  mcpInvocationCorrelation,
  safeLogRecord,
} from "@app/approval-core";
import type {
  ActionRequestId,
  OrganizationId,
  RateLimiter,
  RateLimitPolicy,
  SafeLogAttributes,
  SafeLogEvent,
  TelemetrySink,
} from "@app/approval-core";
import type {
  ActionRequestApplicationService,
  ActionRequestPreparation,
  ActionRequestView,
  ApprovalReadRepository,
  TrustedActionRequestContext,
} from "@app/approval-application";

import {
  mapMcpToolArguments,
  mcpToolBindingFingerprint,
  mcpToolDefinition,
  McpGatewayError,
  type McpToolBinding,
  type McpToolBindingRegistry,
} from "./binding.ts";
import { checkMcpToolExposure, type McpToolExposureAuthorizer } from "./exposure.ts";
import {
  invocationOwner,
  mcpInvocationId,
  mcpInvocationRequestHash,
  sameInvocationOwner,
  type McpInvocationOwner,
  type McpInvocationPatch,
  type McpInvocationRecord,
  type McpInvocationRepository,
  type McpRouteSnapshotRepository,
  type McpStoredResponse,
} from "./invocation.ts";
import {
  executionProtocolError,
  projectActionRequest,
  projectMcpTask,
  taskFields,
} from "./projection.ts";
import {
  clientSupportsTasks,
  internalError,
  invalidParamsError,
  invocationConflictError,
  invocationInProgressError,
  MCP_PROTOCOL_REVISION,
  MCP_TASKS_EXTENSION,
  parseCallToolParams,
  parseListToolsParams,
  parseTaskParams,
  parseUpdateTaskParams,
  rateLimitedError,
  readInvocationKey,
  requiredTasksCapabilityError,
  taskNotFoundError,
  taskOperationForbiddenError,
  textResult,
  unknownToolError,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpCreateTaskResult,
  type McpDiscoverResult,
  type McpEmptyResult,
  type McpGetTaskResult,
  type McpListToolsResult,
  type McpOutcome,
  type McpProtocolError,
} from "./protocol.ts";

export type McpGatewayOperation =
  | "tools/list"
  | "tools/call"
  | "tasks/get"
  | "tasks/update"
  | "tasks/cancel";

/**
 * per-requestの認証済みidentityからtrusted contextを解決するPort。
 * actor / authority / caller / organization / delegationはtool argumentsから一切読まない。
 * 返すcontextは `origin.type = "mcp"` かつ要求organizationと一致しなければならない（fail-closed）。
 */
export interface McpTrustedContextProvider {
  resolve(input: {
    organizationId: OrganizationId;
    operation: McpGatewayOperation;
    toolName?: string;
  }): Result.ResultAsync<TrustedActionRequestContext, McpGatewayError>;
}

/** owner以外へ明示的にTask read permissionを与えるPort（update / cancelには使わない）。 */
export interface McpTaskAccessAuthorizer {
  canRead(input: {
    organizationId: OrganizationId;
    taskId: string;
    actionRequestId?: ActionRequestId;
    owner: McpInvocationOwner;
    requester: McpInvocationOwner;
  }): Result.ResultAsync<boolean, McpGatewayError>;
}

export type McpActionRequestCancellationResult =
  | { type: "accepted" }
  | { type: "already_terminal" }
  | { type: "denied"; code: string };

/**
 * `tasks/cancel` を既存ActionRequest cancellation semantics / authorizationへ委ねるPort。
 * Task ownerであることやread可能であることだけではcancelを許可しない。
 */
export interface McpActionRequestCanceller {
  cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    requestedBy: TrustedActionRequestContext;
    requestedAt: string;
  }): Result.ResultAsync<McpActionRequestCancellationResult, McpGatewayError>;
}

export interface McpGatewayIdGenerator {
  /** Task ID / lease token / server側invocation key用の高entropyなopaque ID。 */
  next(): string;
}

export interface McpClock {
  now(): string;
}

type ApplicationService = Pick<ActionRequestApplicationService, "prepare" | "commit">;
type ActionRequestReader = Pick<ApprovalReadRepository, "getActionRequest">;

export type McpGatewayDependencies = {
  applicationService: ApplicationService;
  bindingRegistry: McpToolBindingRegistry;
  exposureAuthorizer: McpToolExposureAuthorizer;
  trustedContextProvider: McpTrustedContextProvider;
  invocationRepository: McpInvocationRepository;
  routeSnapshotRepository: McpRouteSnapshotRepository;
  actionRequestReader: ActionRequestReader;
  idGenerator?: McpGatewayIdGenerator;
  clock?: McpClock;
  pollIntervalMs?: number;
  /**
   * reserved / prepared invocationのlease。crash時はこの時間経過後に回収できる。
   * 処理中の再送が並行commitしないよう、commit + downstream timeoutより長くする。
   */
  leaseMs?: number;
  taskTtlMs?: number | null;
  listPageSize?: number;
  rateLimiter?: RateLimiter;
  rateLimitPolicy?: RateLimitPolicy;
  telemetry?: TelemetrySink;
  taskAccessAuthorizer?: McpTaskAccessAuthorizer;
  canceller?: McpActionRequestCanceller;
  serverInfo?: { name: string; version: string };
};

/** commit（immediate executionのdownstream timeoutを含む）より長くする。 */
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LIST_PAGE_SIZE = 50;

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** commit再開（resume）で回収すべき失敗。Plan保存前の検証失敗 / Plan conflictだけはterminal。 */
function isRecoverableCommitFailure(error: { code: string; retriable: boolean }): boolean {
  return (
    error.retriable ||
    error.code === "audit_persistence_failed" ||
    error.code === "workflow_start_failed"
  );
}

function isInputValidationError(code: string): boolean {
  return code === "action_input_validation_failed" || code === "action_input_not_object";
}

const decodeCursor = Result.fn({
  try: (cursor: string): string => {
    const parsed: unknown = JSON.parse(atob(cursor));
    return typeof parsed === "object" &&
      parsed !== null &&
      "after" in parsed &&
      typeof parsed.after === "string"
      ? parsed.after
      : "";
  },
  catch: () => invalidParamsError("Invalid cursor"),
});

type CallContext = {
  organizationId: OrganizationId;
  trustedContext: TrustedActionRequestContext;
  binding: McpToolBinding;
  params: McpCallToolParams;
  tasksCapable: boolean;
};

type CallOutcome = McpOutcome<McpCallToolResult | McpCreateTaskResult>;

/**
 * MCP tool firewall + approval gateway。
 *
 * tools/call:
 *   trusted context → binding → Tool Exposure → logical invocation reserve
 *   → arguments → Action → prepare（Full Authorization / Policy / Plan確定）
 *   → admission（approval requiredならTasks capability + durable Task予約）
 *   → commit（prepared Planをそのまま保存 / Workflow開始 or immediate execution）
 *
 * Authorization / Approval / execution lifecycleの正本はActionRequestで、
 * Gatewayはprotocol projection / routing / invocation metadataだけを保持する。
 */
export class McpGateway {
  private readonly clock: McpClock;
  private readonly ids: McpGatewayIdGenerator;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly dependencies: McpGatewayDependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date().toISOString() };
    this.ids = dependencies.idGenerator ?? { next: () => crypto.randomUUID() };
    this.leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  discover(): McpDiscoverResult {
    return {
      resultType: "complete",
      supportedVersions: [MCP_PROTOCOL_REVISION],
      capabilities: {
        tools: { listChanged: false },
        extensions: { [MCP_TASKS_EXTENSION]: {} },
      },
      serverInfo: this.dependencies.serverInfo ?? {
        name: "ultra-easy-mcp-gateway",
        version: "1.0.0",
      },
    };
  }

  // ---------------------------------------------------------------- tools/list

  async listTools(input: {
    organizationId: OrganizationId;
    params?: unknown;
  }): Promise<McpOutcome<McpListToolsResult>> {
    const params = parseListToolsParams(input.params);
    if (Result.isFailure(params)) return { type: "error", error: params.error };
    let cursorAfter = "";
    if (params.value.cursor !== undefined) {
      const decoded = decodeCursor(params.value.cursor);
      if (Result.isFailure(decoded)) return { type: "error", error: decoded.error };
      cursorAfter = decoded.value;
    }

    const trusted = await this.resolveTrustedContext(input.organizationId, "tools/list");
    if (Result.isFailure(trusted)) return { type: "error", error: trusted.error };

    const bindings = await this.dependencies.bindingRegistry.listActive({
      organizationId: input.organizationId,
    });
    if (Result.isFailure(bindings)) {
      return { type: "error", error: internalError({ code: bindings.error.code }) };
    }

    const visible: McpToolBinding[] = [];
    // cursorと同じcode unit順で並べる（localeCompareはcursor比較と順序が一致しない）。
    const sorted = [...bindings.value].sort((left, right) =>
      left.exposedTool.name < right.exposedTool.name
        ? -1
        : left.exposedTool.name > right.exposedTool.name
          ? 1
          : 0,
    );
    for (const binding of sorted) {
      if (binding.exposedTool.name <= cursorAfter) continue;
      const exposure = await this.checkExposure(trusted.value, binding);
      if (Result.isFailure(exposure)) {
        // provider errorはfail-closed。部分的なtool一覧を返さない。
        return { type: "error", error: exposure.error };
      }
      if (exposure.value) visible.push(binding);
    }

    const pageSize = this.dependencies.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    const page = visible.slice(0, pageSize);
    const last = page.at(-1);
    return {
      type: "result",
      result: {
        resultType: "complete",
        tools: page.map(mcpToolDefinition),
        ...(visible.length > pageSize && last
          ? { nextCursor: btoa(JSON.stringify({ after: last.exposedTool.name })) }
          : {}),
      },
    };
  }

  // ---------------------------------------------------------------- tools/call

  async callTool(input: { organizationId: OrganizationId; params: unknown }): Promise<CallOutcome> {
    const params = parseCallToolParams(input.params);
    if (Result.isFailure(params)) return { type: "error", error: params.error };
    const invocationKey = readInvocationKey(params.value._meta);
    if (Result.isFailure(invocationKey)) return { type: "error", error: invocationKey.error };

    const trusted = await this.resolveTrustedContext(
      input.organizationId,
      "tools/call",
      params.value.name,
    );
    if (Result.isFailure(trusted)) return { type: "error", error: trusted.error };

    const binding = await this.dependencies.bindingRegistry.resolveByToolName({
      organizationId: input.organizationId,
      toolName: params.value.name,
    });
    if (Result.isFailure(binding)) {
      return { type: "error", error: internalError({ code: binding.error.code }) };
    }
    if (!binding.value) return { type: "error", error: unknownToolError(params.value.name) };

    // Exposure denyのtoolはActionRequest pipelineへ入れない。unknown toolと同じerrorにする。
    const exposure = await this.checkExposure(trusted.value, binding.value);
    if (Result.isFailure(exposure)) return { type: "error", error: exposure.error };
    if (!exposure.value) {
      this.emit("request.denied", "warn", {
        organizationId: input.organizationId,
        trustedContext: trusted.value,
        binding: binding.value,
        attributes: { errorCode: "mcp_tool_not_exposed" },
      });
      return { type: "error", error: unknownToolError(params.value.name) };
    }

    const context: CallContext = {
      organizationId: input.organizationId,
      trustedContext: trusted.value,
      binding: binding.value,
      params: params.value,
      tasksCapable: clientSupportsTasks(params.value._meta),
    };

    const requestHash = await mcpInvocationRequestHash({
      toolName: params.value.name,
      arguments: params.value.arguments,
    });
    if (Result.isFailure(requestHash)) return { type: "error", error: requestHash.error };

    const owner = invocationOwner({
      organizationId: input.organizationId,
      actor: trusted.value.actor,
      authority: trusted.value.authority,
      origin: trusted.value.origin,
    });
    const key = invocationKey.value ?? `server:${this.ids.next()}`;
    const invocationId = await mcpInvocationId({ owner, invocationKey: key });
    if (Result.isFailure(invocationId)) {
      return { type: "error", error: internalError({ code: invocationId.error.code }) };
    }

    const now = this.clock.now();
    const reserved = await this.dependencies.invocationRepository.reserve({
      organizationId: input.organizationId,
      invocationId: invocationId.value,
      owner,
      invocationKey: key,
      keySource: invocationKey.value === undefined ? "server" : "client",
      requestHash: requestHash.value,
      toolName: params.value.name,
      status: "reserved",
      leaseToken: this.ids.next(),
      leaseExpiresAt: addMs(now, this.leaseMs),
      createdAt: now,
      updatedAt: now,
    });
    if (Result.isFailure(reserved)) {
      return { type: "error", error: internalError({ code: reserved.error.code }) };
    }
    if (reserved.value.type === "existing") {
      return this.handleExisting(context, reserved.value.record, requestHash.value);
    }

    const limited = await this.consumeRateLimit(context);
    if (limited) {
      await this.release(reserved.value.record);
      return { type: "error", error: limited };
    }
    return this.admit(context, reserved.value.record);
  }

  private async handleExisting(
    context: CallContext,
    record: McpInvocationRecord,
    requestHash: string,
  ): Promise<CallOutcome> {
    if (record.requestHash !== requestHash) {
      this.emit("request.denied", "warn", {
        organizationId: context.organizationId,
        trustedContext: context.trustedContext,
        binding: context.binding,
        record,
        attributes: { errorCode: "mcp_invocation_conflict" },
      });
      return { type: "error", error: invocationConflictError() };
    }

    if (record.status === "completed" && record.response) {
      this.emit("request.replayed", "info", {
        organizationId: context.organizationId,
        trustedContext: context.trustedContext,
        binding: context.binding,
        record,
        attributes: { status: "completed" },
      });
      if (record.response.type === "result") {
        return { type: "result", result: record.response.result };
      }
      if (record.response.type === "error") return { type: "error", error: record.response.error };
      return this.createTaskResult(context, record);
    }

    if (record.status === "committed") {
      this.emit("request.replayed", "info", {
        organizationId: context.organizationId,
        trustedContext: context.trustedContext,
        binding: context.binding,
        record,
        attributes: { status: "committed" },
      });
      return this.createTaskResult(context, record);
    }

    const now = this.clock.now();
    if (record.leaseExpiresAt > now) {
      return {
        type: "error",
        error: invocationInProgressError(Date.parse(record.leaseExpiresAt) - Date.parse(now)),
      };
    }
    const taken = await this.dependencies.invocationRepository.takeOver({
      organizationId: context.organizationId,
      invocationId: record.invocationId,
      expectedLeaseToken: record.leaseToken,
      leaseToken: this.ids.next(),
      leaseExpiresAt: addMs(now, this.leaseMs),
      now,
    });
    if (Result.isFailure(taken)) {
      return { type: "error", error: internalError({ code: taken.error.code }) };
    }
    if (!taken.value) return { type: "error", error: invocationInProgressError(this.leaseMs) };

    if (taken.value.status === "reserved") {
      // prepare前にcrashしたinvocation。副作用が無いので最初からやり直す。
      return this.admit(context, taken.value);
    }
    if (taken.value.taskId !== undefined && !context.tasksCapable) {
      await this.update(taken.value, { leaseExpiresAt: now, updatedAt: now });
      return { type: "error", error: requiredTasksCapabilityError() };
    }
    // admission後・commit完了前に失敗したinvocation。同じprepared Planでcommitを再開する。
    return this.commitPrepared(context, taken.value, true);
  }

  private async admit(context: CallContext, record: McpInvocationRecord): Promise<CallOutcome> {
    const action = mapMcpToolArguments(context.binding, context.params.arguments);
    if (Result.isFailure(action)) {
      await this.release(record);
      return {
        type: "error",
        error: invalidParamsError(
          action.error.message,
          action.error.path !== undefined ? { path: action.error.path } : {},
        ),
      };
    }

    const prepared = await this.dependencies.applicationService.prepare({
      action: action.value,
      trustedContext: context.trustedContext,
    });
    if (Result.isFailure(prepared)) {
      await this.release(record);
      if (isInputValidationError(prepared.error.code)) {
        return {
          type: "error",
          error: invalidParamsError(prepared.error.message, {
            code: prepared.error.code,
            ...(prepared.error.issues ? { issues: prepared.error.issues } : {}),
          }),
        };
      }
      return {
        type: "error",
        error: internalError({ code: prepared.error.code, retriable: prepared.error.retriable }),
      };
    }

    if (prepared.value.type === "authorization_denied") {
      return this.commitDenied(context, record, prepared.value);
    }

    const preparation = prepared.value;
    const approvalRequired = preparation.prepared.approvalRequired;
    if (approvalRequired && !context.tasksCapable) {
      // #98: Tasks非対応clientにはapproval-required Actionをcommitしない。
      await this.release(record);
      return { type: "error", error: requiredTasksCapabilityError() };
    }

    const fingerprint = await mcpToolBindingFingerprint(context.binding);
    if (Result.isFailure(fingerprint)) {
      await this.release(record);
      return { type: "error", error: internalError({ code: fingerprint.error.code }) };
    }
    const now = this.clock.now();
    const routed = await this.dependencies.routeSnapshotRepository.save({
      organizationId: context.organizationId,
      actionRequestId: preparation.prepared.actionRequestId,
      actionFingerprint: preparation.prepared.plan.actionFingerprint,
      actionType: context.binding.actionType,
      bindingId: context.binding.id,
      bindingVersion: context.binding.version,
      bindingFingerprint: fingerprint.value,
      exposedToolName: context.binding.exposedTool.name,
      target: structuredClone(context.binding.target),
      argumentMapping: structuredClone(context.binding.argumentMapping),
      createdAt: now,
    });
    if (Result.isFailure(routed)) {
      await this.release(record);
      return { type: "error", error: internalError({ code: routed.error.code }) };
    }

    // durable admission: preparation（+ approval requiredならTask ID）を保存してからcommitする。
    const admitted = await this.update(record, {
      status: "prepared",
      preparation,
      actionRequestId: preparation.prepared.actionRequestId,
      ...(approvalRequired
        ? {
            taskId: `task_${this.ids.next()}`,
            taskCreatedAt: now,
            ttlMs: this.dependencies.taskTtlMs ?? null,
          }
        : {}),
      updatedAt: now,
    });
    if (Result.isFailure(admitted)) return { type: "error", error: admitted.error };
    return this.commitPrepared(context, admitted.value, false);
  }

  private async commitDenied(
    context: CallContext,
    record: McpInvocationRecord,
    preparation: Extract<ActionRequestPreparation, { type: "authorization_denied" }>,
  ): Promise<CallOutcome> {
    const committed = await this.dependencies.applicationService.commit({ preparation });
    if (Result.isFailure(committed)) {
      await this.release(record);
      return {
        type: "error",
        error: internalError({ code: committed.error.code, retriable: committed.error.retriable }),
      };
    }
    const result = textResult(
      {
        actionRequestId: String(preparation.actionRequestId),
        code: preparation.code,
        reason: preparation.reason,
      },
      { isError: true },
    );
    this.emit("request.denied", "warn", {
      organizationId: context.organizationId,
      trustedContext: context.trustedContext,
      binding: context.binding,
      record,
      actionRequestId: preparation.actionRequestId,
      attributes: { errorCode: preparation.code, status: "authorization_denied" },
    });
    return this.complete(record, { type: "result", result }, preparation.actionRequestId);
  }

  private async commitPrepared(
    context: CallContext,
    record: McpInvocationRecord,
    resume: boolean,
  ): Promise<CallOutcome> {
    const preparation = record.preparation;
    if (!preparation || preparation.type !== "prepared") {
      return {
        type: "error",
        error: internalError({ code: "invocation_preparation_missing" }),
      };
    }
    const actionRequestId = preparation.prepared.actionRequestId;
    const now = this.clock.now();
    const committed = await this.dependencies.applicationService.commit({
      preparation,
      now,
      resume,
    });

    if (Result.isFailure(committed)) {
      const error = committed.error;
      if (error.code === "execution_failed") {
        // immediate executionが失敗したActionRequestはterminal。JSON-RPC errorとして確定する。
        const protocolError = executionProtocolError({
          actionRequestId: String(actionRequestId),
          code: error.executionErrorCode,
          message: error.message,
          provenance: error.executionErrorCode === undefined ? "reauthorization" : "execution",
        });
        return this.complete(record, { type: "error", error: protocolError }, actionRequestId);
      }
      if (isRecoverableCommitFailure(error)) {
        // prepared状態を保持したままleaseを解放し、同じlogical callの再送 / tasks/getで復旧させる。
        // Plan保存後のaudit / Workflow開始失敗はnon-retriableでも、ActionRequestを孤立させないよう回収対象にする。
        await this.update(record, { leaseExpiresAt: now, updatedAt: now });
        return {
          type: "error",
          error: internalError({
            code: error.code,
            retriable: true,
            actionRequestId: String(actionRequestId),
            ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
          }),
        };
      }
      return this.complete(
        record,
        {
          type: "error",
          error: internalError({
            code: error.code,
            retriable: false,
            actionRequestId: String(actionRequestId),
          }),
        },
        actionRequestId,
      );
    }

    const submitted = committed.value;
    if (submitted.type === "authorization_denied") {
      return this.complete(
        record,
        {
          type: "result",
          result: textResult(
            {
              actionRequestId: String(submitted.actionRequestId),
              code: submitted.code,
              reason: submitted.reason,
            },
            { isError: true },
          ),
        },
        submitted.actionRequestId,
      );
    }

    this.emit("request.accepted", "info", {
      organizationId: context.organizationId,
      trustedContext: context.trustedContext,
      binding: context.binding,
      record,
      actionRequestId,
      attributes: { status: submitted.view.status },
    });

    if (record.taskId !== undefined) {
      const updated = await this.update(record, {
        status: "committed",
        leaseExpiresAt: now,
        updatedAt: now,
      });
      if (Result.isFailure(updated)) {
        // ActionRequestはcommit済み。recordはpreparedのままなので、lease期限後の再送 / pollingで回収される。
        return {
          type: "error",
          error: internalError({
            code: "invocation_commit_record_failed",
            retriable: true,
            actionRequestId: String(actionRequestId),
            taskId: record.taskId,
          }),
        };
      }
      return {
        type: "result",
        result: {
          resultType: "task",
          ...taskFields({
            record: updated.value,
            projection: {
              status: "working",
              statusMessage: "ActionRequest is waiting for approval",
            },
            lastUpdatedAt: now,
            pollIntervalMs: this.pollIntervalMs,
          }),
        },
      };
    }

    const projection = projectActionRequest(submitted.view);
    const response: McpStoredResponse =
      projection.status === "completed"
        ? { type: "result", result: projection.result }
        : projection.status === "failed"
          ? { type: "error", error: projection.error }
          : {
              type: "error",
              error: internalError({
                code: "unexpected_action_request_status",
                status: submitted.view.status,
              }),
            };
    return this.complete(record, response, actionRequestId);
  }

  private async createTaskResult(
    context: CallContext,
    record: McpInvocationRecord,
  ): Promise<CallOutcome> {
    if (record.taskId === undefined) {
      return { type: "error", error: internalError({ code: "invocation_task_missing" }) };
    }
    if (!context.tasksCapable) return { type: "error", error: requiredTasksCapabilityError() };
    const view = await this.loadView(record);
    if (Result.isFailure(view)) return { type: "error", error: view.error };
    const projected = projectMcpTask({
      record,
      view: view.value,
      pollIntervalMs: this.pollIntervalMs,
    });
    return {
      type: "result",
      result: {
        resultType: "task",
        taskId: projected.taskId,
        status: projected.status,
        ...(projected.statusMessage !== undefined
          ? { statusMessage: projected.statusMessage }
          : {}),
        createdAt: projected.createdAt,
        lastUpdatedAt: projected.lastUpdatedAt,
        ttlMs: projected.ttlMs,
        ...(projected.pollIntervalMs !== undefined
          ? { pollIntervalMs: projected.pollIntervalMs }
          : {}),
      },
    };
  }

  // ---------------------------------------------------------------- tasks/*

  async getTask(input: {
    organizationId: OrganizationId;
    params: unknown;
  }): Promise<McpOutcome<McpGetTaskResult>> {
    const access = await this.authorizeTaskOperation(input, "tasks/get", parseTaskParams);
    if (Result.isFailure(access)) return { type: "error", error: access.error };
    let record = access.value.record;

    if (
      access.value.owner &&
      record.status === "prepared" &&
      record.leaseExpiresAt <= this.clock.now()
    ) {
      const recovered = await this.recoverFromTaskPoll(input.organizationId, access.value, record);
      if (recovered) record = recovered;
    }

    const view = await this.loadView(record);
    if (Result.isFailure(view)) return { type: "error", error: view.error };
    return {
      type: "result",
      result: projectMcpTask({ record, view: view.value, pollIntervalMs: this.pollIntervalMs }),
    };
  }

  async updateTask(input: {
    organizationId: OrganizationId;
    params: unknown;
  }): Promise<McpOutcome<McpEmptyResult>> {
    const access = await this.authorizeTaskOperation(input, "tasks/update", parseUpdateTaskParams);
    if (Result.isFailure(access)) return { type: "error", error: access.error };
    if (!access.value.owner) {
      return {
        type: "error",
        error: taskOperationForbiddenError("tasks/update", "not_task_owner"),
      };
    }
    // v1はinput_requiredを発行しない。outstandingでないinputResponsesは仕様どおり無視してackする。
    return { type: "result", result: { resultType: "complete" } };
  }

  async cancelTask(input: {
    organizationId: OrganizationId;
    params: unknown;
  }): Promise<McpOutcome<McpEmptyResult>> {
    const access = await this.authorizeTaskOperation(input, "tasks/cancel", parseTaskParams);
    if (Result.isFailure(access)) return { type: "error", error: access.error };
    if (!access.value.owner) {
      return {
        type: "error",
        error: taskOperationForbiddenError("tasks/cancel", "not_task_owner"),
      };
    }
    const record = access.value.record;
    const ack: McpOutcome<McpEmptyResult> = { type: "result", result: { resultType: "complete" } };
    const now = this.clock.now();

    if (record.status === "completed") return ack;

    if (record.status === "reserved" || record.status === "prepared") {
      // まだActionRequestをcommitしていないinvocation。ownerはadmissionを取り下げられる。
      if (record.leaseExpiresAt > now) {
        return {
          type: "error",
          error: invocationInProgressError(Date.parse(record.leaseExpiresAt) - Date.parse(now)),
        };
      }
      const taken = await this.dependencies.invocationRepository.takeOver({
        organizationId: input.organizationId,
        invocationId: record.invocationId,
        expectedLeaseToken: record.leaseToken,
        leaseToken: this.ids.next(),
        leaseExpiresAt: addMs(now, this.leaseMs),
        now,
      });
      if (Result.isFailure(taken)) {
        return { type: "error", error: internalError({ code: taken.error.code }) };
      }
      if (!taken.value) return { type: "error", error: invocationInProgressError(this.leaseMs) };
      const cancelled = await this.update(taken.value, {
        status: "completed",
        response: { type: "cancelled" },
        cancelRequestedAt: now,
        leaseExpiresAt: now,
        updatedAt: now,
      });
      return Result.isFailure(cancelled) ? { type: "error", error: cancelled.error } : ack;
    }

    const canceller = this.dependencies.canceller;
    if (!canceller || record.actionRequestId === undefined) {
      return {
        type: "error",
        error: taskOperationForbiddenError("tasks/cancel", "cancellation_not_supported"),
      };
    }
    const cancelled = await canceller.cancel({
      organizationId: input.organizationId,
      actionRequestId: record.actionRequestId,
      requestedBy: access.value.trustedContext,
      requestedAt: now,
    });
    if (Result.isFailure(cancelled)) {
      return { type: "error", error: internalError({ code: cancelled.error.code }) };
    }
    if (cancelled.value.type === "denied") {
      return {
        type: "error",
        error: taskOperationForbiddenError("tasks/cancel", cancelled.value.code),
      };
    }
    const updated = await this.update(record, { cancelRequestedAt: now, updatedAt: now });
    return Result.isFailure(updated) ? { type: "error", error: updated.error } : ack;
  }

  private async authorizeTaskOperation<Params extends { taskId: string; _meta?: unknown }>(
    input: { organizationId: OrganizationId; params: unknown },
    operation: Extract<McpGatewayOperation, `tasks/${string}`>,
    parse: (params: unknown) => Result.Result<Params, McpProtocolError>,
  ): Result.ResultAsync<
    {
      record: McpInvocationRecord;
      owner: boolean;
      trustedContext: TrustedActionRequestContext;
      params: Params;
    },
    McpProtocolError
  > {
    const params = parse(input.params);
    if (Result.isFailure(params)) return params;
    if (!clientSupportsTasks(params.value._meta as Record<string, unknown> | undefined)) {
      return Result.fail(requiredTasksCapabilityError());
    }
    const trusted = await this.resolveTrustedContext(input.organizationId, operation);
    if (Result.isFailure(trusted)) return trusted;

    const record = await this.dependencies.invocationRepository.loadByTaskId({
      organizationId: input.organizationId,
      taskId: params.value.taskId,
    });
    if (Result.isFailure(record)) return Result.fail(internalError({ code: record.error.code }));
    if (!record.value || record.value.taskId === undefined) {
      return Result.fail(taskNotFoundError());
    }

    const requester = invocationOwner({
      organizationId: input.organizationId,
      actor: trusted.value.actor,
      authority: trusted.value.authority,
      origin: trusted.value.origin,
    });
    const owner = sameInvocationOwner(record.value.owner, requester);
    if (!owner) {
      const readable = this.dependencies.taskAccessAuthorizer
        ? await this.dependencies.taskAccessAuthorizer.canRead({
            organizationId: input.organizationId,
            taskId: params.value.taskId,
            ...(record.value.actionRequestId !== undefined
              ? { actionRequestId: record.value.actionRequestId }
              : {}),
            owner: record.value.owner,
            requester,
          })
        : Result.succeed(false);
      if (Result.isFailure(readable)) {
        return Result.fail(internalError({ code: readable.error.code }));
      }
      // 読めないprincipal / clientにはTaskの存在自体を明かさない。
      if (!readable.value) return Result.fail(taskNotFoundError());
    }

    return Result.succeed({
      record: record.value,
      owner,
      trustedContext: trusted.value,
      params: params.value,
    });
  }

  /**
   * tasks/getのpollingでも、commit未完了のまま放置されたTaskを同じPlanで回収する。
   * tools/call replayと同じく、回収前にbindingとTool Exposureを再確認する（hiddenなら回収しない）。
   */
  private async recoverFromTaskPoll(
    organizationId: OrganizationId,
    access: { trustedContext: TrustedActionRequestContext },
    record: McpInvocationRecord,
  ): Promise<McpInvocationRecord | null> {
    const binding = await this.dependencies.bindingRegistry.resolveByToolName({
      organizationId,
      toolName: record.toolName,
    });
    if (Result.isFailure(binding) || !binding.value) return null;
    const exposed = await this.checkExposure(access.trustedContext, binding.value);
    if (Result.isFailure(exposed) || !exposed.value) return null;

    const now = this.clock.now();
    const taken = await this.dependencies.invocationRepository.takeOver({
      organizationId,
      invocationId: record.invocationId,
      expectedLeaseToken: record.leaseToken,
      leaseToken: this.ids.next(),
      leaseExpiresAt: addMs(now, this.leaseMs),
      now,
    });
    if (Result.isFailure(taken) || !taken.value) return null;
    await this.commitPrepared(
      {
        organizationId,
        trustedContext: access.trustedContext,
        binding: binding.value,
        params: { name: record.toolName },
        tasksCapable: true,
      },
      taken.value,
      true,
    );
    const reloaded = await this.dependencies.invocationRepository.load({
      organizationId,
      invocationId: record.invocationId,
    });
    return Result.isSuccess(reloaded) ? reloaded.value : null;
  }

  // ---------------------------------------------------------------- helpers

  private async resolveTrustedContext(
    organizationId: OrganizationId,
    operation: McpGatewayOperation,
    toolName?: string,
  ): Result.ResultAsync<TrustedActionRequestContext, McpProtocolError> {
    const resolved = await Result.fn({
      try: async () =>
        this.dependencies.trustedContextProvider.resolve({
          organizationId,
          operation,
          ...(toolName !== undefined ? { toolName } : {}),
        }),
      catch: (error) =>
        new McpGatewayError(
          "trusted_context_provider_threw",
          true,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    if (Result.isFailure(resolved)) {
      return Result.fail(internalError({ code: resolved.error.code }));
    }
    if (Result.isFailure(resolved.value)) {
      return Result.fail(internalError({ code: resolved.value.error.code }));
    }
    const context = resolved.value.value;
    if (
      String(context.organization.id) !== String(organizationId) ||
      context.origin.type !== "mcp"
    ) {
      return Result.fail(internalError({ code: "untrusted_context" }));
    }
    return Result.succeed(context);
  }

  private async checkExposure(
    context: TrustedActionRequestContext,
    binding: McpToolBinding,
  ): Result.ResultAsync<boolean, McpProtocolError> {
    const decided = await checkMcpToolExposure(this.dependencies.exposureAuthorizer, {
      organizationId: context.organization.id,
      actor: context.actor,
      authority: context.authority,
      origin: context.origin,
      actionType: binding.actionType,
      toolName: binding.exposedTool.name,
    });
    if (Result.isFailure(decided)) {
      return Result.fail(
        internalError({ code: "exposure_provider_failed", retriable: decided.error.retriable }),
      );
    }
    return Result.succeed(decided.value.type === "allow");
  }

  private async consumeRateLimit(context: CallContext): Promise<McpProtocolError | null> {
    const limiter = this.dependencies.rateLimiter;
    if (!limiter) return null;
    const limited = await limiter.consume({
      organizationId: context.organizationId,
      principal: context.trustedContext.actor,
      operation: "mcp.tools.call",
      policy: this.dependencies.rateLimitPolicy ?? DEFAULT_MCP_TOOL_CALL_RATE_LIMIT,
      now: context.trustedContext.now,
    });
    if (Result.isFailure(limited)) return internalError({ code: "rate_limiter_failed" });
    return limited.value.allowed ? null : rateLimitedError(limited.value);
  }

  private async loadView(
    record: McpInvocationRecord,
  ): Result.ResultAsync<ActionRequestView | null, McpProtocolError> {
    if (record.status !== "committed" || record.actionRequestId === undefined) {
      return Result.succeed(null);
    }
    const loaded = await this.dependencies.actionRequestReader.getActionRequest({
      organizationId: record.organizationId,
      actionRequestId: record.actionRequestId,
    });
    if (Result.isFailure(loaded)) return Result.fail(internalError({ code: loaded.error.code }));
    return Result.succeed(loaded.value);
  }

  private async update(
    record: McpInvocationRecord,
    patch: McpInvocationPatch,
  ): Result.ResultAsync<McpInvocationRecord, McpProtocolError> {
    const updated = await this.dependencies.invocationRepository.update({
      organizationId: record.organizationId,
      invocationId: record.invocationId,
      leaseToken: record.leaseToken,
      patch,
    });
    if (Result.isFailure(updated)) {
      return Result.fail(
        internalError({ code: updated.error.code, retriable: updated.error.retriable }),
      );
    }
    return Result.succeed(updated.value);
  }

  private async release(record: McpInvocationRecord): Promise<void> {
    await this.dependencies.invocationRepository.release({
      organizationId: record.organizationId,
      invocationId: record.invocationId,
      leaseToken: record.leaseToken,
    });
  }

  private async complete(
    record: McpInvocationRecord,
    response: McpStoredResponse,
    actionRequestId: ActionRequestId,
  ): Promise<CallOutcome> {
    const now = this.clock.now();
    const updated = await this.update(record, {
      status: "completed",
      response,
      actionRequestId,
      leaseExpiresAt: now,
      updatedAt: now,
    });
    if (Result.isFailure(updated)) return { type: "error", error: updated.error };
    if (response.type === "result") return { type: "result", result: response.result };
    if (response.type === "error") return { type: "error", error: response.error };
    return { type: "error", error: internalError({ code: "invocation_cancelled" }) };
  }

  private emit(
    event: SafeLogEvent,
    level: "info" | "warn",
    input: {
      organizationId: OrganizationId;
      trustedContext: TrustedActionRequestContext;
      binding: McpToolBinding;
      record?: McpInvocationRecord;
      actionRequestId?: ActionRequestId;
      attributes: SafeLogAttributes;
    },
  ): void {
    const actionRequestId = input.actionRequestId ?? input.record?.actionRequestId;
    this.dependencies.telemetry?.emit(
      safeLogRecord({
        level,
        event,
        correlation: mcpInvocationCorrelation({
          organizationId: input.organizationId,
          ...(input.record ? { mcpInvocationId: input.record.invocationId } : {}),
          ...(actionRequestId !== undefined ? { actionRequestId } : {}),
          operation: "tools.call",
          principal: input.trustedContext.actor,
        }),
        attributes: {
          ...input.attributes,
          toolName: input.binding.exposedTool.name,
          mcpServerId: input.binding.target.mcpServerId,
          bindingVersion: input.binding.version,
        },
      }),
    );
  }
}
