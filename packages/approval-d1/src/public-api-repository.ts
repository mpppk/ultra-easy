import { Result } from "@praha/byethrow";

import type {
  ActionRequestView,
  ApprovalCommandRecord,
  ApprovalCommandRepository,
  ApprovalCommandStatus,
  ApprovalCommandTransitionResult,
  ApprovalReadRepository,
  ApprovalTaskDecisionContext,
  ApprovalTaskPage,
  ApprovalTaskView,
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReserveResult,
} from "@app/approval-application";
import { PublicApiRepositoryError } from "@app/approval-application";
import type {
  ActionRequestId,
  ApprovalRuntimeState,
  ApprovalTaskId,
  JsonValue,
  MaterializedApprovalStep,
  MaterializedFlow,
  OrganizationId,
  UserId,
} from "@app/approval-core";
import {
  foldActionRequestStatus,
  isTerminalActionRequestStatus,
  selfApprovalSubject,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import { D1ActionResultProjectionRepository } from "./action-result-projection-repository.ts";
import { D1ApprovalRuntimeProjectionRepository } from "./approval-runtime-projection-repository.ts";
import {
  D1MaterializedPlanRepository,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "./materialized-plan-repository.ts";

type TaskRow = {
  task_id: string;
  action_request_id: string;
  materialized_step_id: string;
  status: ApprovalTaskView["status"];
  candidate_user_ids: string;
  decisions?: string;
  activated_at: string;
  expires_at: string | null;
  closed_at: string | null;
};

type CommandRow = {
  command_id: string;
  organization_id: string;
  action_request_id: string;
  task_id: string | null;
  command_type: "approve" | "reject" | "cancel";
  status: ApprovalCommandStatus;
  actor_user_id: string | null;
  comment: string | null;
  error_json: string | null;
  created_at: string;
  applied_at: string | null;
  attempt_count: number | null;
  next_attempt_at: string | null;
};

const COMMAND_COLUMNS = `command_id, organization_id, action_request_id, task_id, command_type,
                  status, actor_user_id, comment, error_json, created_at, applied_at,
                  attempt_count, next_attempt_at`;

type IdempotencyRow = {
  organization_id: string;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  status: "pending" | "completed";
  locked_until: string | null;
  response_status: number | null;
  response_body: string | null;
  response_location: string | null;
  created_at: string;
  updated_at: string;
};

function repositoryError(error: unknown, fallback: string): PublicApiRepositoryError {
  return new PublicApiRepositoryError(
    "public_api_repository_error",
    true,
    error instanceof Error ? error.message : fallback,
  );
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike) => statement.run(),
  catch: (error): PublicApiRepositoryError =>
    repositoryError(error, "D1 statementの実行に失敗しました"),
});

async function firstRow<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, PublicApiRepositoryError> {
  const read = Result.fn({
    try: async (): Promise<T | null> => statement.first<T>(),
    catch: (error): PublicApiRepositoryError =>
      repositoryError(error, "D1 rowの取得に失敗しました"),
  });
  return read();
}

async function allRows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], PublicApiRepositoryError> {
  if (!statement.all) {
    return Result.fail(
      new PublicApiRepositoryError(
        "d1_all_not_supported",
        false,
        "D1 prepared statementのall()が利用できません",
      ),
    );
  }
  const read = Result.fn({
    try: async (): Promise<{ results: T[] }> => statement.all!<T>(),
    catch: (error): PublicApiRepositoryError =>
      repositoryError(error, "D1 rowsの取得に失敗しました"),
  });
  const result = await read();
  if (Result.isFailure(result)) return result;
  return Result.succeed(result.value.results);
}

const parseJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (error): PublicApiRepositoryError =>
    repositoryError(error, "保存済みJSONをparseできません"),
});

const stringifyJson = Result.fn({
  try: (value: unknown): string => JSON.stringify(value),
  catch: (error): PublicApiRepositoryError => repositoryError(error, "JSONをserializeできません"),
});

function findStep(
  flow: MaterializedFlow,
  materializedStepId: string,
): MaterializedApprovalStep | null {
  if (flow.type === "approval") {
    return String(flow.materializedStepId) === materializedStepId ? flow : null;
  }
  if (flow.type === "none") return null;
  for (const child of flow.children) {
    const found = findStep(child, materializedStepId);
    if (found) return found;
  }
  return null;
}

function runtimeUpdatedAt(state: ApprovalRuntimeState | null, fallback: string): string {
  if (!state) return fallback;
  const values = [
    state.startedAt,
    ...(state.completedAt ? [state.completedAt] : []),
    ...state.tasks.flatMap((task) => [
      task.activatedAt,
      ...(task.closedAt ? [task.closedAt] : []),
      ...task.decisions.map((decision) => decision.decidedAt),
    ]),
  ];
  const latest = Math.max(...values.map(Date.parse).filter(Number.isFinite));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : fallback;
}

function commandRecord(
  row: CommandRow,
): Result.Result<ApprovalCommandRecord, PublicApiRepositoryError> {
  let error: ApprovalCommandRecord["command"]["error"] | undefined;
  if (row.error_json !== null) {
    const parsed = parseJson(row.error_json);
    if (Result.isFailure(parsed)) return parsed;
    error = parsed.value as ApprovalCommandRecord["command"]["error"];
  }
  return Result.succeed({
    command: {
      id: row.command_id,
      organizationId: row.organization_id,
      actionRequestId: row.action_request_id,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      type: row.command_type,
      status: row.status,
      ...(error !== undefined ? { error } : {}),
      createdAt: row.created_at,
      ...(row.applied_at !== null ? { appliedAt: row.applied_at } : {}),
    },
    ...(row.actor_user_id !== null ? { actorUserId: row.actor_user_id as UserId } : {}),
    ...(row.comment !== null ? { comment: row.comment } : {}),
    ...(row.attempt_count ? { attemptCount: row.attempt_count } : {}),
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
  });
}

function idempotencyRecord(
  row: IdempotencyRow,
): Result.Result<IdempotencyRecord, PublicApiRepositoryError> {
  let responseBody: IdempotencyRecord["responseBody"] | undefined;
  if (row.response_body !== null) {
    const parsed = parseJson(row.response_body);
    if (Result.isFailure(parsed)) return parsed;
    responseBody = parsed.value as IdempotencyRecord["responseBody"];
  }
  return Result.succeed({
    organizationId: row.organization_id as OrganizationId,
    operation: row.operation,
    key: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.locked_until !== null ? { lockedUntil: row.locked_until } : {}),
    ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
    ...(responseBody !== undefined ? { responseBody } : {}),
    ...(row.response_location !== null ? { responseLocation: row.response_location } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class D1PublicApiRepository
  implements ApprovalReadRepository, ApprovalCommandRepository, IdempotencyRepository
{
  private readonly plans: D1MaterializedPlanRepository;
  private readonly runtimes: D1ApprovalRuntimeProjectionRepository;
  private readonly results: D1ActionResultProjectionRepository;
  private readonly events: D1ActionEventRepository;

  constructor(private readonly db: D1DatabaseLike) {
    this.events = new D1ActionEventRepository(db);
    this.plans = new D1MaterializedPlanRepository(db);
    this.runtimes = new D1ApprovalRuntimeProjectionRepository(db);
    this.results = new D1ActionResultProjectionRepository(db);
  }

  async getActionRequest(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionRequestView | null, PublicApiRepositoryError> {
    const plan = await this.plans.load(input);
    if (plan.type === "not_found") return Result.succeed(null);
    if (plan.type !== "found") {
      return Result.fail(
        new PublicApiRepositoryError(
          "action_request_read_failed",
          plan.type === "repository_error",
          "message" in plan ? plan.message : `Plan load failed: ${plan.type}`,
        ),
      );
    }

    const runtime = await this.runtimes.load(input);
    if (Result.isFailure(runtime)) {
      return Result.fail(repositoryError(runtime.error, runtime.error.message));
    }
    const actionResult = await this.results.load(input);
    if (Result.isFailure(actionResult)) {
      return Result.fail(repositoryError(actionResult.error, actionResult.error.message));
    }

    // statusはaction_events（append-only）をcoreの状態機械でfoldして導出する（#101）。
    // runtime projection / action_resultsは同じbatchで書かれる表示用の詳細だけに使う。
    const events = await this.events.listForAction(input);
    if (Result.isFailure(events)) {
      return Result.fail(repositoryError(events.error, events.error.message));
    }
    const status = foldActionRequestStatus(
      events.value.map((record) => record.event),
      { approvalRequired: plan.plan.flow.type !== "none" },
    );
    const createdAt = plan.plan.evaluationSnapshot.evaluatedAt;
    const lastEventAt = events.value.at(-1)?.occurredAt;
    const updatedAt =
      actionResult.value?.completedAt ?? runtimeUpdatedAt(runtime.value, lastEventAt ?? createdAt);
    const terminal = isTerminalActionRequestStatus(status);

    const resultView = actionResult.value
      ? {
          status: actionResult.value.status,
          ...(actionResult.value.result?.output !== undefined
            ? { output: actionResult.value.result.output }
            : {}),
          ...(actionResult.value.code !== undefined ? { code: actionResult.value.code } : {}),
          ...(actionResult.value.message !== undefined
            ? { message: actionResult.value.message }
            : {}),
        }
      : undefined;

    return Result.succeed({
      id: String(plan.plan.actionRequestId),
      organizationId: String(plan.plan.organizationId),
      actor: plan.plan.evaluationSnapshot.actor,
      authorityPrincipal: plan.plan.evaluationSnapshot.authority.principal,
      ...(plan.plan.evaluationSnapshot.origin.caller
        ? { caller: plan.plan.evaluationSnapshot.origin.caller }
        : {}),
      action: {
        type: plan.plan.action.type,
        resource: plan.plan.action.resource,
        input: plan.plan.action.input,
      },
      origin: plan.plan.evaluationSnapshot.origin.type,
      status,
      approval: {
        required: plan.plan.flow.type !== "none",
        activeTaskCount:
          runtime.value?.tasks.filter((task) => task.status === "pending").length ?? 0,
        completedTaskCount:
          runtime.value?.tasks.filter((task) => task.status !== "pending").length ?? 0,
      },
      ...(resultView ? { result: resultView } : {}),
      checksums: {
        actionFingerprint: String(plan.plan.actionFingerprint),
        evaluationSnapshotChecksum: String(plan.plan.evaluationSnapshotChecksum),
        approvalPlanChecksum: String(plan.plan.approvalPlanChecksum),
      },
      createdAt,
      updatedAt,
      ...(terminal
        ? {
            completedAt: actionResult.value?.completedAt ?? runtime.value?.completedAt ?? updatedAt,
          }
        : {}),
    });
  }

  async taskFromRow(input: {
    organizationId: OrganizationId;
    row: TaskRow;
    viewerUserId?: UserId;
    /** 1回の一覧取得の中でPlanのload + checksum再検証を使い回す（#95 N+1）。 */
    planCache?: Map<string, Awaited<ReturnType<D1MaterializedPlanRepository["load"]>>>;
  }): Result.ResultAsync<ApprovalTaskView, PublicApiRepositoryError> {
    const cached = input.planCache?.get(input.row.action_request_id);
    const loaded =
      cached ??
      (await this.plans.load({
        organizationId: input.organizationId,
        actionRequestId: input.row.action_request_id as ActionRequestId,
      }));
    input.planCache?.set(input.row.action_request_id, loaded);
    if (loaded.type !== "found") {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_task_plan_not_found",
          loaded.type === "repository_error",
          "message" in loaded ? loaded.message : `Plan load failed: ${loaded.type}`,
        ),
      );
    }
    const step = findStep(loaded.plan.flow, input.row.materialized_step_id);
    if (!step) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_task_step_not_found",
          false,
          "Approval taskに対応するMaterialized Stepが見つかりません",
        ),
      );
    }

    const candidates = parseJson(input.row.candidate_user_ids);
    if (Result.isFailure(candidates)) return candidates;
    const candidateIds = Array.isArray(candidates.value)
      ? candidates.value.filter((value): value is string => typeof value === "string")
      : [];
    const target =
      step.target.type === "user"
        ? {
            kind: "user" as const,
            userId: String(step.target.userId),
          }
        : {
            kind: "relation" as const,
            object: String(step.target.object),
            relation: String(step.target.relation),
          };

    return Result.succeed({
      id: input.row.task_id,
      actionRequestId: input.row.action_request_id,
      materializedStepId: input.row.materialized_step_id,
      stepKey: String(step.stepKey),
      ...(step.name !== undefined ? { name: step.name } : {}),
      ...(step.purpose !== undefined ? { purpose: step.purpose } : {}),
      status: input.row.status,
      resolution: step.resolution ?? "dynamic",
      candidateCompletion: step.candidateCompletion ?? "any",
      canApprove:
        input.row.status === "pending" &&
        input.viewerUserId !== undefined &&
        candidateIds.includes(String(input.viewerUserId)),
      approverTarget: target,
      ...(input.row.expires_at !== null ? { expiresAt: input.row.expires_at } : {}),
      activatedAt: input.row.activated_at,
      ...(input.row.closed_at !== null ? { closedAt: input.row.closed_at } : {}),
    });
  }

  async getApprovalTask(input: {
    organizationId: OrganizationId;
    taskId: ApprovalTaskId;
    viewerUserId?: UserId;
  }): Result.ResultAsync<ApprovalTaskView | null, PublicApiRepositoryError> {
    const row = await firstRow<TaskRow>(
      this.db
        .prepare(
          `SELECT task_id, action_request_id, materialized_step_id, status,
                  candidate_user_ids, activated_at, expires_at, closed_at
             FROM approval_tasks
            WHERE organization_id = ? AND task_id = ?`,
        )
        .bind(input.organizationId, input.taskId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return this.taskFromRow({
      organizationId: input.organizationId,
      row: row.value,
      ...(input.viewerUserId !== undefined ? { viewerUserId: input.viewerUserId } : {}),
    });
  }

  async isActionRequestParticipant(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    userId: UserId;
  }): Result.ResultAsync<boolean, PublicApiRepositoryError> {
    const row = await firstRow<{ found: number }>(
      this.db
        .prepare(
          `SELECT 1 AS found
             FROM approval_tasks t
            WHERE t.organization_id = ? AND t.action_request_id = ?
              AND (
                EXISTS (SELECT 1 FROM json_each(t.candidate_user_ids) WHERE value = ?)
                OR EXISTS (
                  SELECT 1 FROM json_each(t.decisions)
                   WHERE json_extract(value, '$.userId') = ?
                )
              )
            LIMIT 1`,
        )
        .bind(input.organizationId, input.actionRequestId, input.userId, input.userId),
    );
    if (Result.isFailure(row)) return row;
    return Result.succeed(row.value !== null);
  }

  async getApprovalTaskDecisionContext(input: {
    organizationId: OrganizationId;
    taskId: ApprovalTaskId;
    viewerUserId: UserId;
  }): Result.ResultAsync<ApprovalTaskDecisionContext | null, PublicApiRepositoryError> {
    const row = await firstRow<TaskRow>(
      this.db
        .prepare(
          `SELECT task_id, action_request_id, materialized_step_id, status,
                  candidate_user_ids, decisions, activated_at, expires_at, closed_at
             FROM approval_tasks
            WHERE organization_id = ? AND task_id = ?`,
        )
        .bind(input.organizationId, input.taskId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const task = await this.taskFromRow({
      organizationId: input.organizationId,
      row: row.value,
      viewerUserId: input.viewerUserId,
    });
    if (Result.isFailure(task)) return task;

    const loaded = await this.plans.load({
      organizationId: input.organizationId,
      actionRequestId: row.value.action_request_id as ActionRequestId,
    });
    if (loaded.type !== "found") {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_task_plan_not_found",
          loaded.type === "repository_error",
          "message" in loaded ? loaded.message : `Plan load failed: ${loaded.type}`,
        ),
      );
    }
    const step = findStep(loaded.plan.flow, row.value.materialized_step_id);
    if (!step) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_task_step_not_found",
          false,
          "Approval taskに対応するMaterialized Stepが見つかりません",
        ),
      );
    }
    const candidates = parseJson(row.value.candidate_user_ids);
    if (Result.isFailure(candidates)) return candidates;
    const decisions = parseJson(row.value.decisions ?? "[]");
    if (Result.isFailure(decisions)) return decisions;
    const selfSubject = selfApprovalSubject(loaded.plan, step);
    return Result.succeed({
      task: task.value,
      requireCommentOn: step.requireCommentOn ?? [],
      ...(selfSubject?.type === "user" ? { selfApprovalDeniedUserId: String(selfSubject.id) } : {}),
      candidateUserIds: Array.isArray(candidates.value)
        ? candidates.value.filter((value): value is string => typeof value === "string")
        : [],
      decidedUserIds: Array.isArray(decisions.value)
        ? decisions.value.flatMap((decision: unknown) =>
            typeof decision === "object" &&
            decision !== null &&
            typeof (decision as { userId?: unknown }).userId === "string"
              ? [(decision as { userId: string }).userId]
              : [],
          )
        : [],
    });
  }

  async listActionRequestTasks(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    cursor?: string;
    limit: number;
    viewerUserId?: UserId;
  }): Result.ResultAsync<ApprovalTaskPage, PublicApiRepositoryError> {
    const rows = await allRows<TaskRow>(
      this.db
        .prepare(
          `SELECT task_id, action_request_id, materialized_step_id, status,
                  candidate_user_ids, activated_at, expires_at, closed_at
             FROM approval_tasks
            WHERE organization_id = ?
              AND action_request_id = ?
              AND (? IS NULL OR task_id > ?)
            ORDER BY task_id
            LIMIT ?`,
        )
        .bind(
          input.organizationId,
          input.actionRequestId,
          input.cursor ?? null,
          input.cursor ?? null,
          input.limit + 1,
        ),
    );
    if (Result.isFailure(rows)) return rows;
    const hasMore = rows.value.length > input.limit;
    const selected = rows.value.slice(0, input.limit);
    const items: ApprovalTaskView[] = [];
    const planCache = new Map();
    for (const row of selected) {
      const task = await this.taskFromRow({
        organizationId: input.organizationId,
        row,
        planCache,
        ...(input.viewerUserId !== undefined ? { viewerUserId: input.viewerUserId } : {}),
      });
      if (Result.isFailure(task)) return task;
      items.push(task.value);
    }
    return Result.succeed({
      items,
      pageInfo: {
        hasMore,
        ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.id } : {}),
      },
    });
  }

  async listMyApprovalTasks(input: {
    organizationId: OrganizationId;
    userId: UserId;
    cursor?: string;
    limit: number;
    status?: ApprovalTaskView["status"];
    actionType?: string;
    resourceType?: string;
  }): Result.ResultAsync<ApprovalTaskPage, PublicApiRepositoryError> {
    const rows = await allRows<TaskRow>(
      this.db
        .prepare(
          `SELECT t.task_id, t.action_request_id, t.materialized_step_id, t.status,
                  t.candidate_user_ids, t.activated_at, t.expires_at, t.closed_at
             FROM approval_task_candidates c
             JOIN approval_tasks t
               ON t.organization_id = c.organization_id
              AND t.task_id = c.task_id
             JOIN action_requests a
               ON a.organization_id = t.organization_id
              AND a.id = t.action_request_id
            WHERE c.organization_id = ?
              AND c.user_id = ?
              AND (? IS NULL OR t.status = ?)
              AND (? IS NULL OR json_extract(a.materialized_plan, '$.action.type') = ?)
              AND (? IS NULL OR json_extract(a.materialized_plan, '$.action.resource.type') = ?)
              AND (? IS NULL OR c.task_id > ?)
            ORDER BY c.task_id
            LIMIT ?`,
        )
        .bind(
          input.organizationId,
          input.userId,
          input.status ?? null,
          input.status ?? null,
          input.actionType ?? null,
          input.actionType ?? null,
          input.resourceType ?? null,
          input.resourceType ?? null,
          input.cursor ?? null,
          input.cursor ?? null,
          input.limit + 1,
        ),
    );
    if (Result.isFailure(rows)) return rows;
    const hasMore = rows.value.length > input.limit;
    const selected = rows.value.slice(0, input.limit);
    const items: ApprovalTaskView[] = [];
    const planCache = new Map();
    for (const row of selected) {
      const task = await this.taskFromRow({
        organizationId: input.organizationId,
        row,
        viewerUserId: input.userId,
        planCache,
      });
      if (Result.isFailure(task)) return task;
      items.push(task.value);
    }
    return Result.succeed({
      items,
      pageInfo: {
        hasMore,
        ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.id } : {}),
      },
    });
  }

  async createPending(
    record: ApprovalCommandRecord,
  ): Result.ResultAsync<
    { type: "created" } | { type: "existing"; record: ApprovalCommandRecord },
    PublicApiRepositoryError
  > {
    const inserted = await runStatement(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO approval_commands (
             command_id, organization_id, action_request_id, task_id, command_type,
             status, actor_user_id, comment, error_json, created_at, applied_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL)`,
        )
        .bind(
          record.command.id,
          record.command.organizationId,
          record.command.actionRequestId,
          record.command.taskId ?? null,
          record.command.type,
          record.actorUserId ?? null,
          record.comment ?? null,
          record.command.createdAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if (!inserted.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_insert_failed",
          true,
          inserted.value.error ?? "Approval commandの保存に失敗しました",
        ),
      );
    }
    if ((inserted.value.meta?.changes ?? 0) > 0) return Result.succeed({ type: "created" });

    const existing = await this.load({
      organizationId: record.command.organizationId as OrganizationId,
      commandId: record.command.id,
    });
    if (Result.isFailure(existing)) return existing;
    if (!existing.value) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_existing_missing",
          true,
          "INSERT OR IGNORE後に既存commandを取得できません",
        ),
      );
    }
    return Result.succeed({ type: "existing", record: existing.value });
  }

  async load(input: {
    organizationId: OrganizationId;
    commandId: string;
  }): Result.ResultAsync<ApprovalCommandRecord | null, PublicApiRepositoryError> {
    const row = await firstRow<CommandRow>(
      this.db
        .prepare(
          `SELECT ${COMMAND_COLUMNS}
             FROM approval_commands
            WHERE organization_id = ? AND command_id = ?`,
        )
        .bind(input.organizationId, input.commandId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const mapped = commandRecord(row.value);
    return Result.isFailure(mapped) ? mapped : Result.succeed(mapped.value);
  }

  async claim(input: {
    organizationId: OrganizationId;
    commandId: string;
    now: string;
    leaseUntil: string;
  }): Result.ResultAsync<ApprovalCommandRecord | null, PublicApiRepositoryError> {
    const claimed = await runStatement(
      this.db
        .prepare(
          `UPDATE approval_commands
              SET lease_until = ?
            WHERE organization_id = ? AND command_id = ?
              AND status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              AND (lease_until IS NULL OR lease_until <= ?)`,
        )
        .bind(input.leaseUntil, input.organizationId, input.commandId, input.now, input.now),
    );
    if (Result.isFailure(claimed)) return claimed;
    if (!claimed.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_claim_failed",
          true,
          claimed.value.error ?? "Approval commandを確保できませんでした",
        ),
      );
    }
    if ((claimed.value.meta?.changes ?? 0) === 0) return Result.succeed(null);
    return this.load(input);
  }

  async transition(input: {
    organizationId: OrganizationId;
    commandId: string;
    from: readonly ApprovalCommandStatus[];
    to: Exclude<ApprovalCommandStatus, "pending">;
    appliedAt?: string;
    error?: ApprovalCommandRecord["command"]["error"];
  }): Result.ResultAsync<ApprovalCommandTransitionResult, PublicApiRepositoryError> {
    const errorJson = input.error !== undefined ? stringifyJson(input.error) : Result.succeed(null);
    if (Result.isFailure(errorJson)) return errorJson;
    if (input.from.length === 0) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_transition_invalid",
          false,
          "遷移元の状態を1つ以上指定してください",
        ),
      );
    }
    const placeholders = input.from.map(() => "?").join(", ");
    return this.compareAndSet(
      input,
      this.db
        .prepare(
          `UPDATE approval_commands
              SET status = ?, applied_at = COALESCE(?, applied_at),
                  error_json = COALESCE(?, error_json), lease_until = NULL
            WHERE organization_id = ? AND command_id = ? AND status IN (${placeholders})`,
        )
        .bind(
          input.to,
          input.appliedAt ?? null,
          errorJson.value,
          input.organizationId,
          input.commandId,
          ...input.from,
        ),
    );
  }

  /**
   * WorkflowがDecisionを受理/却下した結果をcommandへ書き戻す（pending/deliveredからのCAS）。
   * commandを経由しないDecision（preview harness等）は該当行が無いためupdated=falseになる。
   */
  async resolveOutcome(input: {
    organizationId: OrganizationId;
    commandId: string;
    status: "applied" | "rejected";
    resolvedAt: string;
    error?: ApprovalCommandRecord["command"]["error"];
  }): Result.ResultAsync<{ updated: boolean }, PublicApiRepositoryError> {
    const errorJson = input.error !== undefined ? stringifyJson(input.error) : Result.succeed(null);
    if (Result.isFailure(errorJson)) return errorJson;
    const updated = await runStatement(
      this.db
        .prepare(
          `UPDATE approval_commands
              SET status = ?, applied_at = ?, error_json = ?, lease_until = NULL
            WHERE organization_id = ? AND command_id = ? AND status IN ('pending', 'delivered')`,
        )
        .bind(
          input.status,
          input.resolvedAt,
          errorJson.value,
          input.organizationId,
          input.commandId,
        ),
    );
    if (Result.isFailure(updated)) return updated;
    if (!updated.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_update_failed",
          true,
          updated.value.error ?? "Approval commandを更新できませんでした",
        ),
      );
    }
    return Result.succeed({ updated: (updated.value.meta?.changes ?? 0) > 0 });
  }

  async scheduleRetry(input: {
    organizationId: OrganizationId;
    commandId: string;
    nextAttemptAt: string;
    error: ApprovalCommandRecord["command"]["error"];
  }): Result.ResultAsync<ApprovalCommandTransitionResult, PublicApiRepositoryError> {
    const errorJson = stringifyJson(input.error);
    if (Result.isFailure(errorJson)) return errorJson;
    return this.compareAndSet(
      input,
      this.db
        .prepare(
          `UPDATE approval_commands
              SET attempt_count = attempt_count + 1, next_attempt_at = ?,
                  error_json = ?, lease_until = NULL
            WHERE organization_id = ? AND command_id = ? AND status = 'pending'`,
        )
        .bind(input.nextAttemptAt, errorJson.value, input.organizationId, input.commandId),
    );
  }

  async listDuePending(input: {
    now: string;
    limit: number;
  }): Result.ResultAsync<ApprovalCommandRecord[], PublicApiRepositoryError> {
    const rows = await allRows<CommandRow>(
      this.db
        .prepare(
          `SELECT ${COMMAND_COLUMNS}
             FROM approval_commands
            WHERE status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              AND (lease_until IS NULL OR lease_until <= ?)
            ORDER BY created_at ASC
            LIMIT ?`,
        )
        .bind(input.now, input.now, input.limit),
    );
    if (Result.isFailure(rows)) return rows;
    const records: ApprovalCommandRecord[] = [];
    for (const row of rows.value) {
      const mapped = commandRecord(row);
      if (Result.isFailure(mapped)) return mapped;
      records.push(mapped.value);
    }
    return Result.succeed(records);
  }

  private async compareAndSet(
    input: { organizationId: OrganizationId; commandId: string },
    statement: D1PreparedStatementLike,
  ): Result.ResultAsync<ApprovalCommandTransitionResult, PublicApiRepositoryError> {
    const updated = await runStatement(statement);
    if (Result.isFailure(updated)) return updated;
    if (!updated.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_update_failed",
          true,
          updated.value.error ?? "Approval commandを更新できませんでした",
        ),
      );
    }
    const loaded = await this.load(input);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value) {
      return Result.fail(
        new PublicApiRepositoryError(
          "approval_command_not_found",
          false,
          "Approval commandが見つかりません",
        ),
      );
    }
    return Result.succeed({
      type: (updated.value.meta?.changes ?? 0) > 0 ? "updated" : "stale",
      record: loaded.value,
    });
  }

  private async loadIdempotency(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
  }): Result.ResultAsync<IdempotencyRecord | null, PublicApiRepositoryError> {
    const row = await firstRow<IdempotencyRow>(
      this.db
        .prepare(
          `SELECT organization_id, operation, idempotency_key, request_hash, status, locked_until,
                  response_status, response_body, response_location, created_at, updated_at
             FROM api_idempotency_keys
            WHERE organization_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .bind(input.organizationId, input.operation, input.key),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const mapped = idempotencyRecord(row.value);
    return Result.isFailure(mapped) ? mapped : Result.succeed(mapped.value);
  }

  async reserve(
    record: IdempotencyRecord,
  ): Result.ResultAsync<IdempotencyReserveResult, PublicApiRepositoryError> {
    const inserted = await runStatement(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO api_idempotency_keys (
             organization_id, operation, idempotency_key, request_hash, status, locked_until,
             response_status, response_body, response_location, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .bind(
          record.organizationId,
          record.operation,
          record.key,
          record.requestHash,
          record.lockedUntil ?? null,
          record.createdAt,
          record.updatedAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if (!inserted.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "idempotency_reserve_failed",
          true,
          inserted.value.error ?? "Idempotency reservationに失敗しました",
        ),
      );
    }
    if ((inserted.value.meta?.changes ?? 0) > 0) {
      return Result.succeed({ type: "acquired", record });
    }

    const existing = await this.loadIdempotency(record);
    if (Result.isFailure(existing)) return existing;
    if (!existing.value) {
      return Result.fail(
        new PublicApiRepositoryError(
          "idempotency_existing_missing",
          true,
          "既存Idempotency recordを取得できません",
        ),
      );
    }
    if (existing.value.requestHash !== record.requestHash) {
      return Result.succeed({ type: "conflict", record: existing.value });
    }
    if (existing.value.status === "completed") {
      return Result.succeed({ type: "replay", record: existing.value });
    }
    const lockedUntil = existing.value.lockedUntil;
    if (lockedUntil !== undefined && lockedUntil > record.updatedAt) {
      return Result.succeed({ type: "in_progress", record: existing.value });
    }
    // 期限切れ（またはlease導入前）のpendingを、同じrequestの再送がcompare-and-setで引き継ぐ。
    const taken = await runStatement(
      this.db
        .prepare(
          `UPDATE api_idempotency_keys
              SET locked_until = ?, updated_at = ?
            WHERE organization_id = ? AND operation = ? AND idempotency_key = ?
              AND request_hash = ? AND status = 'pending'
              AND COALESCE(locked_until, '') = ?`,
        )
        .bind(
          record.lockedUntil ?? null,
          record.updatedAt,
          record.organizationId,
          record.operation,
          record.key,
          record.requestHash,
          lockedUntil ?? "",
        ),
    );
    if (Result.isFailure(taken)) return taken;
    if (!taken.value.success || (taken.value.meta?.changes ?? 0) === 0) {
      return Result.succeed({ type: "in_progress", record: existing.value });
    }
    return Result.succeed({
      type: "acquired",
      record: {
        ...existing.value,
        ...(record.lockedUntil !== undefined ? { lockedUntil: record.lockedUntil } : {}),
        updatedAt: record.updatedAt,
      },
    });
  }

  async complete(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: JsonValue;
    responseLocation?: string;
    completedAt: string;
  }): Result.ResultAsync<IdempotencyRecord, PublicApiRepositoryError> {
    const responseBody = stringifyJson(input.responseBody);
    if (Result.isFailure(responseBody)) return responseBody;

    const updated = await runStatement(
      this.db
        .prepare(
          `UPDATE api_idempotency_keys
              SET status = 'completed',
                  response_status = ?,
                  response_body = ?,
                  response_location = ?,
                  updated_at = ?
            WHERE organization_id = ?
              AND operation = ?
              AND idempotency_key = ?
              AND request_hash = ?
              AND status = 'pending'`,
        )
        .bind(
          input.responseStatus,
          responseBody.value,
          input.responseLocation ?? null,
          input.completedAt,
          input.organizationId,
          input.operation,
          input.key,
          input.requestHash,
        ),
    );
    if (Result.isFailure(updated)) return updated;
    if (!updated.value.success || (updated.value.meta?.changes ?? 0) === 0) {
      return Result.fail(
        new PublicApiRepositoryError(
          "idempotency_complete_failed",
          !updated.value.success,
          updated.value.error ?? "Idempotency responseを保存できませんでした",
        ),
      );
    }
    const loaded = await this.loadIdempotency(input);
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value) {
      return Result.fail(
        new PublicApiRepositoryError(
          "idempotency_completed_missing",
          true,
          "完了後のIdempotency recordを取得できません",
        ),
      );
    }
    return Result.succeed(loaded.value);
  }

  async release(input: {
    organizationId: OrganizationId;
    operation: string;
    key: string;
    requestHash: string;
  }): Result.ResultAsync<void, PublicApiRepositoryError> {
    const deleted = await runStatement(
      this.db
        .prepare(
          `DELETE FROM api_idempotency_keys
            WHERE organization_id = ?
              AND operation = ?
              AND idempotency_key = ?
              AND request_hash = ?
              AND status = 'pending'`,
        )
        .bind(input.organizationId, input.operation, input.key, input.requestHash),
    );
    if (Result.isFailure(deleted)) return deleted;
    if (!deleted.value.success) {
      return Result.fail(
        new PublicApiRepositoryError(
          "idempotency_release_failed",
          true,
          deleted.value.error ?? "Idempotency reservationを解放できませんでした",
        ),
      );
    }
    return Result.succeed(undefined);
  }
}
