import { Result } from "@praha/byethrow";

import { ApprovalRuntimeProjectionRepositoryError } from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalRuntimeProjectionRepository,
  ApprovalRuntimeState,
  OrganizationId,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type StoredRuntimeProjectionRow = {
  state_json: string;
};

function repositoryError(detail: string): ApprovalRuntimeProjectionRepositoryError {
  return new ApprovalRuntimeProjectionRepositoryError({
    code: "approval_runtime_projection_repository_error",
    detail,
  });
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "D1 statementの実行に失敗しました"),
});

const firstRuntimeRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredRuntimeProjectionRow | null> =>
    statement.first<StoredRuntimeProjectionRow>(),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "D1 runtime projectionの取得に失敗しました"),
});

const serializeJson = Result.fn({
  try: (value: unknown): string => JSON.stringify(value),
  catch: (error): ApprovalRuntimeProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "runtime projectionをserializeできません"),
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
  return timestamps.sort().at(-1) ?? state.startedAt;
}

export class D1ApprovalRuntimeProjectionRepository implements ApprovalRuntimeProjectionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async replace(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
  }): Result.ResultAsync<void, ApprovalRuntimeProjectionRepositoryError> {
    const stateJson = serializeJson(input.state);
    if (Result.isFailure(stateJson)) return stateJson;

    const runtimeSaved = await runStatement(
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
    );
    if (Result.isFailure(runtimeSaved)) return runtimeSaved;
    if (!runtimeSaved.value.success) {
      return Result.fail(
        repositoryError(runtimeSaved.value.error ?? "runtime projectionの保存に失敗しました"),
      );
    }

    for (const task of input.state.tasks) {
      const candidates = serializeJson(task.candidateUserIds);
      if (Result.isFailure(candidates)) return candidates;
      const decisions = serializeJson(task.decisions);
      if (Result.isFailure(decisions)) return decisions;
      const taskSaved = await runStatement(
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
      if (Result.isFailure(taskSaved)) return taskSaved;
      if (!taskSaved.value.success) {
        return Result.fail(
          repositoryError(taskSaved.value.error ?? "approval task projectionの保存に失敗しました"),
        );
      }
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
