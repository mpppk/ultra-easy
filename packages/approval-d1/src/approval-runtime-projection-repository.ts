import { Result } from "@praha/byethrow";

import { ApprovalRuntimeProjectionRepositoryError } from "@app/approval-core";
import type {
  ActionEventRecord,
  ActionRequestId,
  ApprovalRuntimeProjectionRepository,
  ApprovalRuntimeState,
  OrganizationId,
} from "@app/approval-core";

import { prepareActionEventPersistenceStatements } from "./action-event-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type StoredRuntimeProjectionRow = {
  state_json: string;
};

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

function repositoryError(detail: string): ApprovalRuntimeProjectionRepositoryError {
  return new ApprovalRuntimeProjectionRepositoryError({
    code: "approval_runtime_projection_repository_error",
    detail,
  });
}

const firstRuntimeRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredRuntimeProjectionRow | null> =>
    statement.first<StoredRuntimeProjectionRow>(),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(
      error instanceof Error ? error.message : "D1 runtime projectionの取得に失敗しました",
    ),
});

const runBatch = Result.fn({
  try: async (input: {
    db: D1BatchDatabaseLike;
    statements: D1PreparedStatementLike[];
  }): Promise<D1RunResultLike[]> => input.db.batch(input.statements),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "D1 batchの実行に失敗しました"),
});

const serializeJson = Result.fn({
  try: (value: unknown): string => JSON.stringify(value),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(
      error instanceof Error ? error.message : "runtime projectionをserializeできません",
    ),
});

const parseState = Result.fn({
  try: (value: string): ApprovalRuntimeState => JSON.parse(value) as ApprovalRuntimeState,
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "runtime projectionをparseできません"),
});

function latestRuntimeTimestamp(state: ApprovalRuntimeState): string {
  const timestamps = [
    state.startedAt,
    ...(state.completedAt ? [state.completedAt] : []),
    ...state.tasks.flatMap((task) => [
      task.activatedAt,
      ...(task.closedAt ? [task.closedAt] : []),
      ...task.decisions.map((decision) => decision.decidedAt),
    ]),
  ];
  const latest = Math.max(...timestamps.map((value) => Date.parse(value)).filter(Number.isFinite));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : state.startedAt;
}

function asBatchDatabase(db: D1DatabaseLike): D1BatchDatabaseLike | null {
  const candidate = db as Partial<D1BatchDatabaseLike>;
  return typeof candidate.batch === "function" ? (db as D1BatchDatabaseLike) : null;
}

export class D1ApprovalRuntimeProjectionRepository implements ApprovalRuntimeProjectionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async replace(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
    events?: readonly ActionEventRecord[];
  }): Result.ResultAsync<void, ApprovalRuntimeProjectionRepositoryError> {
    const batchDb = asBatchDatabase(this.db);
    if (!batchDb) {
      return Result.fail(
        repositoryError("D1 batch()が利用できないためatomicにprojectionを保存できません"),
      );
    }

    const stateJson = serializeJson(input.state);
    if (Result.isFailure(stateJson)) return stateJson;

    const statements: D1PreparedStatementLike[] = [
      this.db
        .prepare(
          `INSERT INTO approval_runtime_projections (
             organization_id, action_request_id, approval_plan_checksum,
             status, state_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, action_request_id) DO UPDATE SET
             approval_plan_checksum = excluded.approval_plan_checksum,
             status = excluded.status,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.organizationId,
          input.state.actionRequestId,
          input.state.approvalPlanChecksum,
          input.state.status,
          stateJson.value,
          latestRuntimeTimestamp(input.state),
        ),
    ];

    for (const task of input.state.tasks) {
      const candidates = serializeJson(task.candidateUserIds);
      if (Result.isFailure(candidates)) return candidates;
      const decisions = serializeJson(task.decisions);
      if (Result.isFailure(decisions)) return decisions;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO approval_tasks (
               organization_id, task_id, action_request_id, materialized_step_id,
               status, candidate_user_ids, decisions, activated_at, expires_at,
               closed_at, distinct_scope_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(organization_id, task_id) DO UPDATE SET
               status = excluded.status,
               candidate_user_ids = excluded.candidate_user_ids,
               decisions = excluded.decisions,
               expires_at = excluded.expires_at,
               closed_at = excluded.closed_at,
               distinct_scope_id = excluded.distinct_scope_id`,
          )
          .bind(
            input.organizationId,
            task.id,
            input.state.actionRequestId,
            task.materializedStepId,
            task.status,
            candidates.value,
            decisions.value,
            task.activatedAt,
            task.expiresAt ?? null,
            task.closedAt ?? null,
            task.distinctScopeId ?? null,
          ),
      );
    }

    for (const event of input.events ?? []) {
      const prepared = prepareActionEventPersistenceStatements(this.db, event);
      if (Result.isFailure(prepared)) {
        return Result.fail(repositoryError(prepared.error.message));
      }
      statements.push(...prepared.value);
    }

    const saved = await runBatch({ db: batchDb, statements });
    if (Result.isFailure(saved)) return saved;
    const failed = saved.value.find((result) => !result.success);
    if (failed) {
      return Result.fail(
        repositoryError(failed.error ?? "runtime/task projectionのatomic保存に失敗しました"),
      );
    }

    return Result.succeed(undefined);
  }

  async load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ApprovalRuntimeState | null, ApprovalRuntimeProjectionRepositoryError> {
    const row = await firstRuntimeRow(
      this.db
        .prepare(
          `SELECT state_json
             FROM approval_runtime_projections
            WHERE organization_id = ? AND action_request_id = ?`,
        )
        .bind(input.organizationId, input.actionRequestId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return parseState(row.value.state_json);
  }
}
