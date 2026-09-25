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

/**
 * Decision commandの状態。
 * - pending: 受付済み・Workflowへ未配送（retriable失敗後の再試行待ちを含む）
 * - delivered: Workflowへ配送済みで、業務上の受理/却下が未確定
 * - applied: WorkflowがDecisionを受理した
 * - rejected: WorkflowがDecisionを業務制約で却下した
 * - failed: 配送を諦めた（非retriable失敗、またはretry上限超過）
 */
export type ApprovalCommandStatus = "pending" | "delivered" | "applied" | "rejected" | "failed";
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
  /** Workflowへの配送を試みた回数（retriable失敗ごとに加算）。 */
  attemptCount?: number;
  /** retriable失敗後、次に配送を試みてよい時刻。 */
  nextAttemptAt?: string;
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

/**
 * Decision受付時の事前検証に使うTaskの制約。最終判定はWorkflow Interpreterで再検証する。
 */
export type ApprovalTaskDecisionContext = {
  task: ApprovalTaskView;
  requireCommentOn: readonly ApprovalDecisionValue[];
  /** selfApproval=denyで承認できないuser（authority principal等）。 */
  selfApprovalDeniedUserId?: string;
  candidateUserIds: readonly string[];
  decidedUserIds: readonly string[];
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

  getApprovalTaskDecisionContext(input: {
    organizationId: OrganizationId;
    taskId: ApprovalTaskId;
    viewerUserId: UserId;
  }): Result.ResultAsync<ApprovalTaskDecisionContext | null, PublicApiRepositoryError>;

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

export type ApprovalCommandTransitionResult =
  | { type: "updated"; record: ApprovalCommandRecord }
  /** 現在の状態がfromに含まれず更新しなかった（他のworker / Workflowが先に遷移させた）。 */
  | { type: "stale"; record: ApprovalCommandRecord };

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

  /**
   * pendingかつ配送期限（nextAttemptAt）到来済みで、他workerのleaseが切れているcommandを
   * leaseUntilまで確保する。確保できなければnullを返す（inline処理とsweepの並行実行を避ける）。
   */
  claim(input: {
    organizationId: OrganizationId;
    commandId: string;
    now: string;
    leaseUntil: string;
  }): Result.ResultAsync<ApprovalCommandRecord | null, PublicApiRepositoryError>;

  /** 現在の状態がfromのいずれかのときだけtoへ遷移する（compare-and-set）。 */
  transition(input: {
    organizationId: OrganizationId;
    commandId: string;
    from: readonly ApprovalCommandStatus[];
    to: Exclude<ApprovalCommandStatus, "pending">;
    appliedAt?: string;
    error?: PublicApiProblem;
  }): Result.ResultAsync<ApprovalCommandTransitionResult, PublicApiRepositoryError>;

  /** retriable失敗: pendingのままattemptCountを加算し、nextAttemptAtまで再配送を遅らせる。 */
  scheduleRetry(input: {
    organizationId: OrganizationId;
    commandId: string;
    nextAttemptAt: string;
    error: PublicApiProblem;
  }): Result.ResultAsync<ApprovalCommandTransitionResult, PublicApiRepositoryError>;

  /** organizationを横断して、配送期限が到来したpending commandを古い順に返す。 */
  listDuePending(input: {
    now: string;
    limit: number;
  }): Result.ResultAsync<ApprovalCommandRecord[], PublicApiRepositoryError>;
}

export interface ApprovalCommandIdGenerator {
  next(): string;
}

export class ApprovalCommandApplicationError extends Error {
  readonly name = "ApprovalCommandApplicationError";

  constructor(
    readonly code:
      | "approval_task_not_found"
      | "approval_task_closed"
      | "approval_user_already_decided"
      | "approval_self_approval_denied"
      | "approval_candidate_rejected"
      | "approval_comment_required"
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

/**
 * Workflowへ送る前にbusiness constraintを事前評価する（spec part-14 10項）。
 * dynamic resolutionの候補判定は現在のrelationに依存するため、ここではsnapshot候補だけを見る。
 * 最終受理判定はWorkflow Interpreter側で再検証する。
 */
function precheckDecision(
  context: ApprovalTaskDecisionContext,
  input: { userId: UserId; decision: ApprovalDecisionValue; comment?: string },
): ApprovalCommandApplicationError | null {
  const userId = String(input.userId);
  if (context.task.status !== "pending") {
    return new ApprovalCommandApplicationError(
      "approval_task_closed",
      false,
      "Approval taskは既に終了しています",
    );
  }
  if (context.decidedUserIds.includes(userId)) {
    return new ApprovalCommandApplicationError(
      "approval_user_already_decided",
      false,
      "このApproval taskへは既にDecision済みです",
    );
  }
  if (context.selfApprovalDeniedUserId === userId) {
    return new ApprovalCommandApplicationError(
      "approval_self_approval_denied",
      false,
      "自己承認はpolicyで禁止されています",
    );
  }
  if (context.task.resolution === "snapshot" && !context.candidateUserIds.includes(userId)) {
    return new ApprovalCommandApplicationError(
      "approval_candidate_rejected",
      false,
      "このApproval taskの承認候補者ではありません",
    );
  }
  if (context.requireCommentOn.includes(input.decision) && !input.comment?.trim()) {
    return new ApprovalCommandApplicationError(
      "approval_comment_required",
      false,
      `${input.decision} Decisionにはcommentが必要です`,
    );
  }
  return null;
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
    const task = await this.readRepository.getApprovalTaskDecisionContext({
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
    const rejection = precheckDecision(task.value, input);
    if (rejection) return Result.fail(rejection);

    const command: ApprovalCommand = {
      id: this.idGenerator.next(),
      organizationId: String(input.organizationId),
      actionRequestId: task.value.task.actionRequestId,
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
  /** Decisionが同期的に受理された（in-process runtime）。 */
  | { type: "applied" }
  /** Workflowへ配送した。受理/却下はWorkflowがcommandへ書き戻す。 */
  | { type: "delivered" }
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

export type ApprovalDecisionRetryPolicy = {
  /** この回数だけ配送に失敗したらfailedで確定する。 */
  maxAttempts: number;
  /** 1回目の失敗後の待機。以降は2倍ずつmaxDelayMsまで伸ばす。 */
  baseDelayMs: number;
  maxDelayMs: number;
  /** claimしたcommandを他workerから隠す期間。sinkのtimeoutより長くする。 */
  leaseMs: number;
};

export const DEFAULT_APPROVAL_DECISION_RETRY_POLICY: ApprovalDecisionRetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  leaseMs: 60_000,
};

function addMilliseconds(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function repositoryFailure(error: PublicApiRepositoryError): ApprovalCommandApplicationError {
  return new ApprovalCommandApplicationError(
    "approval_command_repository_failed",
    error.retriable,
    error.message,
  );
}

export class ApprovalDecisionCommandProcessor {
  private readonly retryPolicy: ApprovalDecisionRetryPolicy;

  constructor(
    private readonly commandRepository: ApprovalCommandRepository,
    private readonly sink: ApprovalDecisionSink,
    retryPolicy: Partial<ApprovalDecisionRetryPolicy> = {},
  ) {
    this.retryPolicy = { ...DEFAULT_APPROVAL_DECISION_RETRY_POLICY, ...retryPolicy };
  }

  async process(input: {
    organizationId: OrganizationId;
    commandId: string;
    now: string;
  }): Result.ResultAsync<ApprovalCommand, ApprovalCommandApplicationError> {
    const claimed = await this.commandRepository.claim({
      organizationId: input.organizationId,
      commandId: input.commandId,
      now: input.now,
      leaseUntil: addMilliseconds(input.now, this.retryPolicy.leaseMs),
    });
    if (Result.isFailure(claimed)) return Result.fail(repositoryFailure(claimed.error));
    if (!claimed.value) {
      // 処理済み・他workerがlease中・retry待ちのいずれか。現在の状態をそのまま返す。
      const loaded = await this.commandRepository.load(input);
      if (Result.isFailure(loaded)) return Result.fail(repositoryFailure(loaded.error));
      if (!loaded.value) {
        return Result.fail(
          new ApprovalCommandApplicationError(
            "approval_command_not_found",
            false,
            "Approval commandが見つかりません",
          ),
        );
      }
      return Result.succeed(loaded.value.command);
    }

    const record = claimed.value;
    if (
      record.command.type === "cancel" ||
      record.command.taskId === undefined ||
      record.actorUserId === undefined
    ) {
      return this.finish(input, "failed", {
        error: commandProblem({
          status: 422,
          code: "unsupported_command",
          title: "Commandを適用できません",
          detail: "このprocessorはapprove/reject Decisionのみを処理します",
        }),
      });
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
      const attempts = (record.attemptCount ?? 0) + 1;
      if (applied.error.retriable && attempts < this.retryPolicy.maxAttempts) {
        const delay = Math.min(
          this.retryPolicy.baseDelayMs * 2 ** (attempts - 1),
          this.retryPolicy.maxDelayMs,
        );
        const scheduled = await this.commandRepository.scheduleRetry({
          organizationId: input.organizationId,
          commandId: input.commandId,
          nextAttemptAt: addMilliseconds(input.now, delay),
          error: commandProblem({
            status: 503,
            code: applied.error.code,
            title: "Decision commandの配送を再試行します",
            detail: "Workflowへの配送が一時的に失敗しました",
          }),
        });
        if (Result.isFailure(scheduled)) return Result.fail(repositoryFailure(scheduled.error));
        return Result.succeed(scheduled.value.record.command);
      }
      return this.finish(input, "failed", {
        error: commandProblem({
          status: applied.error.retriable ? 503 : 422,
          code: applied.error.code,
          title: "Decision commandの適用に失敗しました",
          detail: applied.error.retriable
            ? "Workflowへの配送が再試行上限に達しました"
            : "Decision commandを適用できません",
        }),
      });
    }

    if (applied.value.type === "rejected") {
      return this.finish(input, "rejected", {
        appliedAt: input.now,
        error: commandProblem({
          status: 422,
          code: applied.value.code,
          title: "Decision commandは拒否されました",
          detail: applied.value.message,
        }),
      });
    }
    return this.finish(
      input,
      applied.value.type,
      applied.value.type === "applied" ? { appliedAt: input.now } : {},
    );
  }

  private async finish(
    input: { organizationId: OrganizationId; commandId: string },
    to: Exclude<ApprovalCommandStatus, "pending">,
    fields: { appliedAt?: string; error?: PublicApiProblem },
  ): Result.ResultAsync<ApprovalCommand, ApprovalCommandApplicationError> {
    // pendingからだけ遷移させる。Workflowが先にapplied/rejectedを書いていればそれを優先する。
    const updated = await this.commandRepository.transition({
      organizationId: input.organizationId,
      commandId: input.commandId,
      from: ["pending"],
      to,
      ...fields,
    });
    if (Result.isFailure(updated)) return Result.fail(repositoryFailure(updated.error));
    return Result.succeed(updated.value.record.command);
  }
}

export type IdempotencyRecord = {
  organizationId: OrganizationId;
  operation: string;
  key: string;
  requestHash: string;
  status: "pending" | "completed";
  /**
   * pending予約のlease期限。期限切れ（または未設定の旧record）のpendingは、
   * 同じkey + 同じrequest hashの再送が引き継げる（crash / timeoutで永久in_progressにしない）。
   */
  lockedUntil?: string;
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
  /**
   * keyを予約する。既存pendingのlockedUntilが `record.updatedAt` 以前なら、
   * 同じrequest hashの予約をcompare-and-setで引き継ぎ `acquired` を返す。
   */
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
