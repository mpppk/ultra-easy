import { Result } from "@praha/byethrow";

import type {
  ActionRequestId,
  ApprovalDecisionValue,
  ApprovalTaskId,
  JsonValue,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import type { ActionRequestView } from "./action-request-service.ts";

export type ApprovalCommandStatus = "pending" | "applied" | "rejected" | "failed";
export type ApprovalCommandType = "approve" | "reject" | "cancel";

export type PublicApiProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
};

export type ApprovalCommand = {
  id: string;
  organizationId: string;
  actionRequestId: string;
  taskId?: string;
  type: ApprovalCommandType;
  status: ApprovalCommandStatus;
  error?: PublicApiProblem;
  createdAt: string;
  appliedAt?: string;
};

export type ApprovalCommandRecord = {
  command: ApprovalCommand;
  actorUserId?: UserId;
  comment?: string;
};

export type ApprovalTaskView = {
  id: string;
  actionRequestId: string;
  materializedStepId: string;
  stepKey: string;
  name?: string;
  purpose?: "execution_consent" | "business_approval" | "security_approval" | "compliance_approval";
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  resolution: "dynamic" | "snapshot";
  candidateCompletion: "any" | "all" | { type: "quorum"; count: number };
  canApprove: boolean;
  approverTarget?: {
    kind: "relation" | "user";
    object?: string;
    relation?: string;
    userId?: string;
  };
  expiresAt?: string;
  activatedAt: string;
  closedAt?: string;
};

export type PageInfo = {
  nextCursor?: string;
  hasMore: boolean;
};

export type ApprovalTaskPage = {
  items: ApprovalTaskView[];
  pageInfo: PageInfo;
};

export class PublicApiRepositoryError extends Error {
  readonly name = "PublicApiRepositoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface ApprovalReadRepository {
  getActionRequest(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionRequestView | null, PublicApiRepositoryError>;

  getApprovalTask(input: {
    organizationId: OrganizationId;
    taskId: ApprovalTaskId;
    viewerUserId?: UserId;
  }): Result.ResultAsync<ApprovalTaskView | null, PublicApiRepositoryError>;

  listActionRequestTasks(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    cursor?: string;
    limit: number;
    viewerUserId?: UserId;
  }): Result.ResultAsync<ApprovalTaskPage, PublicApiRepositoryError>;

  listMyApprovalTasks(input: {
    organizationId: OrganizationId;
    userId: UserId;
    cursor?: string;
    limit: number;
    status?: ApprovalTaskView["status"];
    actionType?: string;
    resourceType?: string;
  }): Result.ResultAsync<ApprovalTaskPage, PublicApiRepositoryError>;
}

export interface ApprovalCommandRepository {
  createPending(
    record: ApprovalCommandRecord,
  ): Result.ResultAsync<
    { type: "created" } | { type: "existing"; record: ApprovalCommandRecord },
    PublicApiRepositoryError
  >;

  load(input: {
    organizationId: OrganizationId;
    commandId: string;
  }): Result.ResultAsync<ApprovalCommandRecord | null, PublicApiRepositoryError>;

  update(input: {
    organizationId: OrganizationId;
    commandId: string;
    status: Exclude<ApprovalCommandStatus, "pending">;
    appliedAt?: string;
    error?: PublicApiProblem;
  }): Result.ResultAsync<ApprovalCommandRecord, PublicApiRepositoryError>;
}

export interface ApprovalCommandIdGenerator {
  next(): string;
}

export class ApprovalCommandApplicationError extends Error {
  readonly name = "ApprovalCommandApplicationError";

  constructor(
    readonly code:
      | "approval_task_not_found"
      | "approval_command_conflict"
      | "approval_command_not_found"
      | "approval_command_repository_failed"
      | "approval_decision_apply_failed",
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export class ApprovalDecisionCommandService {
  constructor(
    private readonly readRepository: ApprovalReadRepository,
    private readonly commandRepository: ApprovalCommandRepository,
    private readonly idGenerator: ApprovalCommandIdGenerator,
  ) {}

  async accept(input: {
    organizationId: OrganizationId;
    taskId: ApprovalTaskId;
    userId: UserId;
    decision: ApprovalDecisionValue;
    comment?: string;
    now: string;
  }): Result.ResultAsync<ApprovalCommand, ApprovalCommandApplicationError> {
    const task = await this.readRepository.getApprovalTask({
      organizationId: input.organizationId,
      taskId: input.taskId,
      viewerUserId: input.userId,
    });
    if (Result.isFailure(task)) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_repository_failed",
          task.error.retriable,
          task.error.message,
        ),
      );
    }
    if (!task.value) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_task_not_found",
          false,
          "Approval taskが見つかりません",
        ),
      );
    }

    const command: ApprovalCommand = {
      id: this.idGenerator.next(),
      organizationId: String(input.organizationId),
      actionRequestId: task.value.actionRequestId,
      taskId: String(input.taskId),
      type: input.decision,
      status: "pending",
      createdAt: input.now,
    };
    const created = await this.commandRepository.createPending({
      command,
      actorUserId: input.userId,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    });
    if (Result.isFailure(created)) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_repository_failed",
          created.error.retriable,
          created.error.message,
        ),
      );
    }
    if (created.value.type === "existing") {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_conflict",
          false,
          "Approval command IDが既に存在します",
        ),
      );
    }
    return Result.succeed(command);
  }

  async get(input: {
    organizationId: OrganizationId;
    commandId: string;
  }): Result.ResultAsync<ApprovalCommand | null, ApprovalCommandApplicationError> {
    const loaded = await this.commandRepository.load(input);
    if (Result.isFailure(loaded)) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_repository_failed",
          loaded.error.retriable,
          loaded.error.message,
        ),
      );
    }
    return Result.succeed(loaded.value?.command ?? null);
  }
}

export type ApprovalDecisionApplyResult =
  | { type: "applied" }
  | { type: "rejected"; code: string; message: string };

export interface ApprovalDecisionSink {
  apply(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    taskId: ApprovalTaskId;
    userId: UserId;
    decision: ApprovalDecisionValue;
    decidedAt: string;
    commandId: string;
    comment?: string;
  }): Result.ResultAsync<ApprovalDecisionApplyResult, PublicApiRepositoryError>;
}

function commandProblem(input: {
  status: number;
  code: string;
  title: string;
  detail: string;
}): PublicApiProblem {
  return {
    type: `urn:ultra-easy:problem:${input.code}`,
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
  };
}

export class ApprovalDecisionCommandProcessor {
  constructor(
    private readonly commandRepository: ApprovalCommandRepository,
    private readonly sink: ApprovalDecisionSink,
  ) {}

  async process(input: {
    organizationId: OrganizationId;
    commandId: string;
    appliedAt: string;
  }): Result.ResultAsync<ApprovalCommand, ApprovalCommandApplicationError> {
    const loaded = await this.commandRepository.load(input);
    if (Result.isFailure(loaded)) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_repository_failed",
          loaded.error.retriable,
          loaded.error.message,
        ),
      );
    }
    if (!loaded.value) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_not_found",
          false,
          "Approval commandが見つかりません",
        ),
      );
    }

    const record = loaded.value;
    if (record.command.status !== "pending") return Result.succeed(record.command);
    if (
      record.command.type === "cancel" ||
      record.command.taskId === undefined ||
      record.actorUserId === undefined
    ) {
      const updated = await this.commandRepository.update({
        organizationId: input.organizationId,
        commandId: input.commandId,
        status: "failed",
        error: commandProblem({
          status: 422,
          code: "unsupported_command",
          title: "Commandを適用できません",
          detail: "このprocessorはapprove/reject Decisionのみを処理します",
        }),
      });
      if (Result.isFailure(updated)) {
        return Result.fail(
          new ApprovalCommandApplicationError(
            "approval_command_repository_failed",
            updated.error.retriable,
            updated.error.message,
          ),
        );
      }
      return Result.succeed(updated.value.command);
    }

    const applied = await this.sink.apply({
      organizationId: input.organizationId,
      actionRequestId: record.command.actionRequestId as ActionRequestId,
      taskId: record.command.taskId as ApprovalTaskId,
      userId: record.actorUserId,
      decision: record.command.type,
      decidedAt: record.command.createdAt,
      commandId: record.command.id,
      ...(record.comment !== undefined ? { comment: record.comment } : {}),
    });

    if (Result.isFailure(applied)) {
      const failed = await this.commandRepository.update({
        organizationId: input.organizationId,
        commandId: input.commandId,
        status: "failed",
        error: commandProblem({
          status: applied.error.retriable ? 503 : 422,
          code: applied.error.code,
          title: "Decision commandの適用に失敗しました",
          detail: applied.error.message,
        }),
      });
      if (Result.isFailure(failed)) {
        return Result.fail(
          new ApprovalCommandApplicationError(
            "approval_command_repository_failed",
            failed.error.retriable,
            failed.error.message,
          ),
        );
      }
      return Result.succeed(failed.value.command);
    }

    const status = applied.value.type === "applied" ? "applied" : "rejected";
    const updated = await this.commandRepository.update({
      organizationId: input.organizationId,
      commandId: input.commandId,
      status,
      appliedAt: input.appliedAt,
      ...(applied.value.type === "rejected"
        ? {
            error: commandProblem({
              status: 422,
              code: applied.value.code,
              title: "Decision commandは拒否されました",
              detail: applied.value.message,
            }),
          }
        : {}),
    });
    if (Result.isFailure(updated)) {
      return Result.fail(
        new ApprovalCommandApplicationError(
          "approval_command_repository_failed",
          updated.error.retriable,
          updated.error.message,
        ),
      );
    }
    return Result.succeed(updated.value.command);
  }
}

export type IdempotencyRecord = {
  organizationId: OrganizationId;
  operation: string;
  key: string;
  requestHash: string;
  status: "pending" | "completed";
  responseStatus?: number;
  responseBody?: JsonValue;
  responseLocation?: string;
  createdAt: string;
  updatedAt: string;
};

export type IdempotencyReserveResult =
  | { type: "acquired"; record: IdempotencyRecord }
  | { type: "replay"; record: IdempotencyRecord }
  | { type: "in_progress"; record: IdempotencyRecord }
  | { type: "conflict"; record: IdempotencyRecord };

export interface IdempotencyRepository {
  reserve(
    record: IdempotencyRecord,
  ): Result.ResultAsync<IdempotencyReserveResult, PublicApiRepositoryError>;

  complete(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: JsonValue;
    responseLocation?: string;
    completedAt: string;
  }): Result.ResultAsync<IdempotencyRecord, PublicApiRepositoryError>;

  release(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
  }): Result.ResultAsync<void, PublicApiRepositoryError>;
}
