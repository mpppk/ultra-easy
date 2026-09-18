import { Result } from "@praha/byethrow";

import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionResult,
  ActionExecutionTerminalStatus,
  ActionRequestId,
  OrganizationId,
} from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

export type ActionResultProjection = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  workflowInstanceId: string;
  status: ActionExecutionTerminalStatus;
  guaranteeLevel?: ActionExecutionGuaranteeLevel;
  idempotencyKey?: string;
  result?: ActionExecutionResult;
  code?: string;
  message?: string;
  completedAt: string;
};

type StoredActionResultRow = {
  organization_id: string;
  action_request_id: string;
  workflow_instance_id: string;
  status: ActionExecutionTerminalStatus;
  guarantee_level: ActionExecutionGuaranteeLevel | null;
  idempotency_key: string | null;
  result: string | null;
  code: string | null;
  message: string | null;
  completed_at: string;
};

export class D1ActionResultProjectionRepositoryError extends Error {
  readonly name = "D1ActionResultProjectionRepositoryError";
  readonly code = "action_result_projection_repository_error";
}

function repositoryError(error: unknown, fallback: string): D1ActionResultProjectionRepositoryError {
  return new D1ActionResultProjectionRepositoryError(
    error instanceof Error ? error.message : fallback,
  );
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike) => statement.run(),
  catch: (error): D1ActionResultProjectionRepositoryError =>
    repositoryError(error, "Action result projectionの保存に失敗しました"),
});

const firstStoredRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredActionResultRow | null> =>
    statement.first<StoredActionResultRow>(),
  catch: (error): D1ActionResultProjectionRepositoryError =>
    repositoryError(error, "Action result projectionの取得に失敗しました"),
});

const serializeResult = Result.fn({
  try: (value: ActionExecutionResult | undefined): string | null =>
    value === undefined ? null : JSON.stringify(value),
  catch: (error): D1ActionResultProjectionRepositoryError =>
    repositoryError(error, "Action resultをserializeできません"),
});

const parseResult = Result.fn({
  try: (value: string): ActionExecutionResult => JSON.parse(value) as ActionExecutionResult,
  catch: (error): D1ActionResultProjectionRepositoryError =>
    repositoryError(error, "Action resultをparseできません"),
});

/**
 * Action executionの最終read projection。
 *
 * このrecordは監査・観測用途であり、Executor呼び出しをskipするためのlockや
 * external side effectのexactly-once根拠として使用しない。
 */
export class D1ActionResultProjectionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(
    projection: ActionResultProjection,
  ): Result.ResultAsync<void, D1ActionResultProjectionRepositoryError> {
    const resultJson = serializeResult(projection.result);
    if (Result.isFailure(resultJson)) return resultJson;

    const saved = await runStatement(
      this.db
        .prepare(
          `INSERT INTO action_results (
             organization_id, action_request_id, workflow_instance_id, status,
             guarantee_level, idempotency_key, result, code, message, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, action_request_id) DO UPDATE SET
             workflow_instance_id = excluded.workflow_instance_id,
             status = excluded.status,
             guarantee_level = excluded.guarantee_level,
             idempotency_key = excluded.idempotency_key,
             result = excluded.result,
             code = excluded.code,
             message = excluded.message,
             completed_at = excluded.completed_at`,
        )
        .bind(
          projection.organizationId,
          projection.actionRequestId,
          projection.workflowInstanceId,
          projection.status,
          projection.guaranteeLevel ?? null,
          projection.idempotencyKey ?? null,
          resultJson.value,
          projection.code ?? null,
          projection.message ?? null,
          projection.completedAt,
        ),
    );
    if (Result.isFailure(saved)) return saved;
    if (!saved.value.success) {
      return Result.fail(
        repositoryError(saved.value.error, "Action result projectionの保存に失敗しました"),
      );
    }
    return Result.succeed(undefined);
  }

  async load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionResultProjection | null, D1ActionResultProjectionRepositoryError> {
    const row = await firstStoredRow(
      this.db
        .prepare(
          `SELECT organization_id, action_request_id, workflow_instance_id, status,
                  guarantee_level, idempotency_key, result, code, message, completed_at
             FROM action_results
            WHERE organization_id = ? AND action_request_id = ?`,
        )
        .bind(input.organizationId, input.actionRequestId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);

    let result: ActionExecutionResult | undefined;
    if (row.value.result !== null) {
      const parsed = parseResult(row.value.result);
      if (Result.isFailure(parsed)) return parsed;
      result = parsed.value;
    }

    return Result.succeed({
      organizationId: row.value.organization_id as OrganizationId,
      actionRequestId: row.value.action_request_id as ActionRequestId,
      workflowInstanceId: row.value.workflow_instance_id,
      status: row.value.status,
      ...(row.value.guarantee_level !== null
        ? { guaranteeLevel: row.value.guarantee_level }
        : {}),
      ...(row.value.idempotency_key !== null ? { idempotencyKey: row.value.idempotency_key } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(row.value.code !== null ? { code: row.value.code } : {}),
      ...(row.value.message !== null ? { message: row.value.message } : {}),
      completedAt: row.value.completed_at,
    });
  }
}
