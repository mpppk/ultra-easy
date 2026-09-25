import { Result } from "@praha/byethrow";

import { ApprovalRuntimeProjectionRepositoryError } from "@app/approval-core";
import type {
  ApprovalRuntimeProjectionWriteResult,
  VersionedApprovalRuntimeProjection,
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

type VersionedRuntimeProjectionRow = {
  state_json: string;
  version: number;
  writer: string | null;
};

export type {
  ApprovalRuntimeProjectionWriteResult,
  VersionedApprovalRuntimeProjection,
} from "@app/approval-core";

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

function repositoryError(detail: string): ApprovalRuntimeProjectionRepositoryError {
  return new ApprovalRuntimeProjectionRepositoryError({
    code: "approval_runtime_projection_repository_error",
    detail,
  });
}

const firstVersionedRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<VersionedRuntimeProjectionRow | null> =>
    statement.first<VersionedRuntimeProjectionRow>(),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(
      error instanceof Error ? error.message : "D1 runtime projectionの取得に失敗しました",
    ),
});

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

    const children = this.childStatements(input);
    if (Result.isFailure(children)) return children;
    // CASを使わない上書き（テスト / 旧経路）。CAS writerが変更を検知できるようversionは進める。
    const statements: D1PreparedStatementLike[] = [
      this.db
        .prepare(
          `INSERT INTO approval_runtime_projections (
             organization_id, action_request_id, approval_plan_checksum,
             status, state_json, updated_at, version
           ) VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(organization_id, action_request_id) DO UPDATE SET
             approval_plan_checksum = excluded.approval_plan_checksum,
             status = excluded.status,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at,
             version = approval_runtime_projections.version + 1,
             writer = NULL`,
        )
        .bind(
          input.organizationId,
          input.state.actionRequestId,
          input.state.approvalPlanChecksum,
          input.state.status,
          stateJson.value,
          latestRuntimeTimestamp(input.state),
        ),
      ...children.value,
    ];

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

  async loadVersioned(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<
    VersionedApprovalRuntimeProjection | null,
    ApprovalRuntimeProjectionRepositoryError
  > {
    const row = await firstVersionedRow(
      this.db
        .prepare(
          `SELECT state_json, version, writer
             FROM approval_runtime_projections
            WHERE organization_id = ? AND action_request_id = ?`,
        )
        .bind(input.organizationId, input.actionRequestId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const state = parseState(row.value.state_json);
    if (Result.isFailure(state)) return state;
    return Result.succeed({
      state: state.value,
      version: row.value.version,
      ...(row.value.writer !== null ? { writer: row.value.writer } : {}),
    });
  }

  /**
   * runtime projectionをcompare-and-setで保存する（#89）。expectedVersion=nullは新規作成。
   * versionが一致しない場合はprojection / task / eventのbatch全体を書かずにconflictを返す。
   * ただし現在のversionが同じwriterの書き込みなら、step retryで再実行された自分の書き込みとして
   * そのstateを返す（冪等）。
   */
  async compareAndReplace(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
    events?: readonly ActionEventRecord[];
    expectedVersion: number | null;
    writer: string;
  }): Result.ResultAsync<
    ApprovalRuntimeProjectionWriteResult,
    ApprovalRuntimeProjectionRepositoryError
  > {
    const batchDb = asBatchDatabase(this.db);
    if (!batchDb) {
      return Result.fail(
        repositoryError("D1 batch()が利用できないためatomicにprojectionを保存できません"),
      );
    }
    const stateJson = serializeJson(input.state);
    if (Result.isFailure(stateJson)) return stateJson;

    const updatedAt = latestRuntimeTimestamp(input.state);
    // version不一致ではNOT NULL制約違反でbatch（D1 transaction）全体をrollbackさせる。
    const projection =
      input.expectedVersion === null
        ? this.db
            .prepare(
              `INSERT INTO approval_runtime_projections (
                 organization_id, action_request_id, approval_plan_checksum,
                 status, state_json, updated_at, version, writer
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
            )
            .bind(
              input.organizationId,
              input.state.actionRequestId,
              input.state.approvalPlanChecksum,
              input.state.status,
              stateJson.value,
              updatedAt,
              input.writer,
            )
        : this.db
            .prepare(
              `UPDATE approval_runtime_projections
                  SET approval_plan_checksum = ?, status = ?, state_json = ?, updated_at = ?,
                      writer = ?,
                      version = CASE WHEN version = ? THEN version + 1 ELSE NULL END
                WHERE organization_id = ? AND action_request_id = ?`,
            )
            .bind(
              input.state.approvalPlanChecksum,
              input.state.status,
              stateJson.value,
              updatedAt,
              input.writer,
              input.expectedVersion,
              input.organizationId,
              input.state.actionRequestId,
            );
    const statements = this.childStatements(input);
    if (Result.isFailure(statements)) return statements;

    const saved = await runBatch({ db: batchDb, statements: [projection, ...statements.value] });
    const failed = Result.isSuccess(saved) && saved.value.find((result) => !result.success);
    const touched = Result.isSuccess(saved) && (saved.value[0]?.meta?.changes ?? 1) > 0;
    if (Result.isSuccess(saved) && !failed && touched) {
      return Result.succeed({
        type: "written",
        version: input.expectedVersion === null ? 1 : input.expectedVersion + 1,
        state: input.state,
      });
    }

    const current = await this.loadVersioned({
      organizationId: input.organizationId,
      actionRequestId: input.state.actionRequestId,
    });
    if (Result.isFailure(current)) return current;
    const moved =
      current.value === null
        ? input.expectedVersion !== null
        : current.value.version !== (input.expectedVersion ?? 0);
    if (!moved) {
      if (Result.isFailure(saved)) return saved;
      return Result.fail(
        repositoryError(
          (failed && failed.error) || "runtime/task projectionのatomic保存に失敗しました",
        ),
      );
    }
    if (current.value?.writer === input.writer) {
      return Result.succeed({
        type: "written",
        version: current.value.version,
        state: current.value.state,
      });
    }
    return Result.succeed({ type: "conflict", current: current.value });
  }

  private childStatements(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
    events?: readonly ActionEventRecord[];
  }): Result.Result<D1PreparedStatementLike[], ApprovalRuntimeProjectionRepositoryError> {
    const statements: D1PreparedStatementLike[] = [];
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
        // inbox用のcandidate索引（#95）。同じbatchで置き換え、approval_tasksと常に一致させる。
        this.db
          .prepare(`DELETE FROM approval_task_candidates WHERE organization_id = ? AND task_id = ?`)
          .bind(input.organizationId, task.id),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO approval_task_candidates (organization_id, user_id, task_id)
             SELECT ?, value, ? FROM json_each(?) WHERE type = 'text'`,
          )
          .bind(input.organizationId, task.id, candidates.value),
      );
    }
    for (const event of input.events ?? []) {
      const prepared = prepareActionEventPersistenceStatements(this.db, event);
      if (Result.isFailure(prepared)) {
        return Result.fail(repositoryError(prepared.error.message));
      }
      statements.push(...prepared.value);
    }
    return Result.succeed(statements);
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
