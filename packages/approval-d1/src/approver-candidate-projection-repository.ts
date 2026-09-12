import { Result } from "@praha/byethrow";

import { ApproverCandidateProjectionRepositoryError } from "@app/approval-core";
import type {
  ApprovalTaskCandidateProjection,
  ApprovalTaskId,
  ApproverCandidateProjectionRepository,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type StoredCandidateProjectionRow = {
  organization_id: string;
  approval_task_id: string;
  materialized_step_id: string;
  candidate_user_ids: string;
  complete: number;
  resolved_at: string;
  source_revision: string | null;
};

function repositoryError(detail: string): ApproverCandidateProjectionRepositoryError {
  return new ApproverCandidateProjectionRepositoryError({
    code: "candidate_projection_repository_error",
    detail,
  });
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): ApproverCandidateProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "D1 statementの実行に失敗しました"),
});

const firstProjectionRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredCandidateProjectionRow | null> =>
    statement.first<StoredCandidateProjectionRow>(),
  catch: (error): ApproverCandidateProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "D1 projectionの取得に失敗しました"),
});

const serializeCandidateIds = Result.fn({
  try: (userIds: UserId[]): string => JSON.stringify(userIds),
  catch: (error): ApproverCandidateProjectionRepositoryError =>
    repositoryError(
      error instanceof Error ? error.message : "candidate user IDsをserializeできません",
    ),
});

const parseCandidateIds = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (error): ApproverCandidateProjectionRepositoryError =>
    repositoryError(error instanceof Error ? error.message : "candidate user IDsをparseできません"),
});

export class D1ApproverCandidateProjectionRepository implements ApproverCandidateProjectionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async replace(
    projection: ApprovalTaskCandidateProjection,
  ): Result.ResultAsync<void, ApproverCandidateProjectionRepositoryError> {
    const candidateIds = serializeCandidateIds(projection.candidateUserIds);
    if (Result.isFailure(candidateIds)) return candidateIds;

    const saved = await runStatement(
      this.db
        .prepare(
          `INSERT INTO approval_task_candidate_projections (
            organization_id,
            approval_task_id,
            materialized_step_id,
            candidate_user_ids,
            complete,
            resolved_at,
            source_revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(organization_id, approval_task_id) DO UPDATE SET
            materialized_step_id = excluded.materialized_step_id,
            candidate_user_ids = excluded.candidate_user_ids,
            complete = excluded.complete,
            resolved_at = excluded.resolved_at,
            source_revision = excluded.source_revision`,
        )
        .bind(
          projection.organizationId,
          projection.approvalTaskId,
          projection.materializedStepId,
          candidateIds.value,
          projection.complete ? 1 : 0,
          projection.resolvedAt,
          projection.sourceRevision ?? null,
        ),
    );
    if (Result.isFailure(saved)) return saved;
    if (!saved.value.success) {
      return Result.fail(
        repositoryError(saved.value.error ?? "承認候補projectionの保存に失敗しました"),
      );
    }
    return Result.succeed(undefined);
  }

  async load(input: {
    organizationId: OrganizationId;
    approvalTaskId: ApprovalTaskId;
  }): Result.ResultAsync<
    ApprovalTaskCandidateProjection | null,
    ApproverCandidateProjectionRepositoryError
  > {
    const row = await firstProjectionRow(
      this.db
        .prepare(
          `SELECT organization_id, approval_task_id, materialized_step_id,
                  candidate_user_ids, complete, resolved_at, source_revision
             FROM approval_task_candidate_projections
            WHERE organization_id = ? AND approval_task_id = ?`,
        )
        .bind(input.organizationId, input.approvalTaskId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);

    const candidateIds = parseCandidateIds(row.value.candidate_user_ids);
    if (Result.isFailure(candidateIds)) return candidateIds;
    if (
      !Array.isArray(candidateIds.value) ||
      candidateIds.value.some((userId) => typeof userId !== "string")
    ) {
      return Result.fail(repositoryError("保存済みcandidate user IDsの形式が不正です"));
    }

    return Result.succeed({
      organizationId: row.value.organization_id as OrganizationId,
      approvalTaskId: row.value.approval_task_id as ApprovalTaskId,
      materializedStepId: row.value.materialized_step_id as MaterializedStepId,
      candidateUserIds: candidateIds.value as UserId[],
      complete: row.value.complete === 1,
      resolvedAt: row.value.resolved_at,
      ...(row.value.source_revision ? { sourceRevision: row.value.source_revision } : {}),
    });
  }
}
