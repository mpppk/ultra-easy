import { Result } from "@praha/byethrow";

import { ActionResultRepositoryError } from "@app/approval-core";
import type {
  ActionEventRecord,
  ActionExecutionGuaranteeLevel,
  ActionFingerprint,
  ActionRequestId,
  AsyncActionExecutionRecord,
  AsyncActionExecutionRepository,
  AsyncExecutionAcceptResult,
  AsyncExecutionCancelResult,
  AsyncExecutionCompletion,
  AsyncExecutionSettleResult,
  OrganizationId,
} from "@app/approval-core";

import { prepareActionEventPersistenceStatements } from "./action-event-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { storedBrand } from "./stored-brand.ts";

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

type StoredRow = {
  organization_id: string;
  action_request_id: string;
  action_fingerprint: string;
  execution_ref: string;
  idempotency_key: string;
  executor_key: string;
  guarantee_level: ActionExecutionGuaranteeLevel;
  workflow_instance_id: string | null;
  status: AsyncActionExecutionRecord["status"];
  accepted_at: string;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  completion_json: string | null;
  completed_at: string | null;
};

export class D1AsyncActionExecutionRepositoryError extends ActionResultRepositoryError {
  override readonly name = "D1AsyncActionExecutionRepositoryError";

  constructor(message: string, retriable = true) {
    super("async_action_execution_repository_error", retriable, message);
  }
}

function repositoryError(error: unknown, fallback: string): D1AsyncActionExecutionRepositoryError {
  return error instanceof D1AsyncActionExecutionRepositoryError
    ? error
    : new D1AsyncActionExecutionRepositoryError(error instanceof Error ? error.message : fallback);
}

const runBatch = Result.fn({
  try: async (input: {
    db: D1BatchDatabaseLike;
    statements: D1PreparedStatementLike[];
  }): Promise<D1RunResultLike[]> => input.db.batch(input.statements),
  catch: (error): D1AsyncActionExecutionRepositoryError =>
    repositoryError(error, "async executionの保存に失敗しました"),
});

const firstRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredRow | null> =>
    statement.first<StoredRow>(),
  catch: (error): D1AsyncActionExecutionRepositoryError =>
    repositoryError(error, "async executionの取得に失敗しました"),
});

const parseCompletion = Result.fn({
  try: (value: string): AsyncExecutionCompletion => JSON.parse(value) as AsyncExecutionCompletion,
  catch: (error): D1AsyncActionExecutionRepositoryError =>
    repositoryError(error, "completionをparseできません"),
});

const COLUMNS = `organization_id, action_request_id, action_fingerprint, execution_ref, idempotency_key,
  executor_key, guarantee_level, workflow_instance_id, status, accepted_at, cancel_requested_at,
  cancel_reason, completion_json, completed_at`;

/**
 * action_async_executions（#165）。受付はActionRequestごとに1件（INSERT OR IGNORE）で、
 * 完了は`status IN ('accepted', 'cancel_requested')`かつbinding一致の条件付きUPDATEで一度だけ確定する。
 */
export class D1AsyncActionExecutionRepository implements AsyncActionExecutionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  private batchDb(): Result.Result<D1BatchDatabaseLike, D1AsyncActionExecutionRepositoryError> {
    const candidate = this.db as Partial<D1BatchDatabaseLike>;
    return typeof candidate.batch === "function"
      ? Result.succeed(this.db as D1BatchDatabaseLike)
      : Result.fail(new D1AsyncActionExecutionRepositoryError("D1 batch()が利用できません", false));
  }

  private toRecord(
    row: StoredRow,
  ): Result.Result<AsyncActionExecutionRecord, D1AsyncActionExecutionRepositoryError> {
    const toError = (message: string) => new D1AsyncActionExecutionRepositoryError(message, false);
    const organizationId = storedBrand("OrganizationId", row.organization_id, toError);
    if (Result.isFailure(organizationId)) return organizationId;
    const actionRequestId = storedBrand("ActionRequestId", row.action_request_id, toError);
    if (Result.isFailure(actionRequestId)) return actionRequestId;
    const actionFingerprint = storedBrand("ActionFingerprint", row.action_fingerprint, toError);
    if (Result.isFailure(actionFingerprint)) return actionFingerprint;
    const executorKey = storedBrand("ExecutorKey", row.executor_key, toError);
    if (Result.isFailure(executorKey)) return executorKey;
    let completion: AsyncExecutionCompletion | undefined;
    if (row.completion_json !== null) {
      const parsed = parseCompletion(row.completion_json);
      if (Result.isFailure(parsed)) return parsed;
      completion = parsed.value;
    }
    return Result.succeed({
      organizationId: organizationId.value,
      actionRequestId: actionRequestId.value,
      actionFingerprint: actionFingerprint.value,
      executionRef: row.execution_ref,
      idempotencyKey: row.idempotency_key,
      executorKey: executorKey.value,
      guaranteeLevel: row.guarantee_level,
      ...(row.workflow_instance_id !== null
        ? { workflowInstanceId: row.workflow_instance_id }
        : {}),
      status: row.status,
      acceptedAt: row.accepted_at,
      ...(row.cancel_requested_at !== null ? { cancelRequestedAt: row.cancel_requested_at } : {}),
      ...(row.cancel_reason !== null ? { cancelReason: row.cancel_reason } : {}),
      ...(completion !== undefined ? { completion } : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    });
  }

  async load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<AsyncActionExecutionRecord | null, D1AsyncActionExecutionRepositoryError> {
    const row = await firstRow(
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM action_async_executions WHERE organization_id = ? AND action_request_id = ?`,
        )
        .bind(String(input.organizationId), String(input.actionRequestId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return this.toRecord(row.value);
  }

  async accept(input: {
    record: AsyncActionExecutionRecord;
    events: readonly ActionEventRecord[];
  }): Result.ResultAsync<AsyncExecutionAcceptResult, D1AsyncActionExecutionRepositoryError> {
    const batchDb = this.batchDb();
    if (Result.isFailure(batchDb)) return batchDb;
    const { record } = input;
    const statements: D1PreparedStatementLike[] = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO action_async_executions (
             organization_id, action_request_id, action_fingerprint, execution_ref, idempotency_key,
             executor_key, guarantee_level, workflow_instance_id, status, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .bind(
          String(record.organizationId),
          String(record.actionRequestId),
          String(record.actionFingerprint),
          record.executionRef,
          record.idempotencyKey,
          String(record.executorKey),
          record.guaranteeLevel,
          record.workflowInstanceId ?? null,
          record.acceptedAt,
        ),
    ];
    for (const event of input.events) {
      const prepared = prepareActionEventPersistenceStatements(this.db, event);
      if (Result.isFailure(prepared))
        return Result.fail(repositoryError(prepared.error, prepared.error.message));
      statements.push(...prepared.value);
    }
    const saved = await runBatch({ db: batchDb.value, statements });
    if (Result.isFailure(saved)) return saved;
    if ((saved.value[0]?.meta?.changes ?? 0) > 0) return Result.succeed({ type: "accepted" });
    const existing = await this.load(record);
    if (Result.isFailure(existing)) return existing;
    if (!existing.value) {
      return Result.fail(
        new D1AsyncActionExecutionRepositoryError("async executionを記録できませんでした"),
      );
    }
    return Result.succeed({ type: "existing", record: existing.value });
  }

  async settle(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    actionFingerprint: ActionFingerprint;
    executionRef: string;
    idempotencyKey: string;
    completion: AsyncExecutionCompletion;
    completedAt: string;
  }): Result.ResultAsync<AsyncExecutionSettleResult, D1AsyncActionExecutionRepositoryError> {
    const batchDb = this.batchDb();
    if (Result.isFailure(batchDb)) return batchDb;
    const updated = await runBatch({
      db: batchDb.value,
      statements: [
        this.db
          .prepare(
            `UPDATE action_async_executions
                SET status = 'completed', completion_json = ?, completed_at = ?
              WHERE organization_id = ? AND action_request_id = ?
                AND action_fingerprint = ? AND execution_ref = ? AND idempotency_key = ?
                AND status IN ('accepted', 'cancel_requested')`,
          )
          .bind(
            JSON.stringify(input.completion),
            input.completedAt,
            String(input.organizationId),
            String(input.actionRequestId),
            String(input.actionFingerprint),
            input.executionRef,
            input.idempotencyKey,
          ),
      ],
    });
    if (Result.isFailure(updated)) return updated;
    const current = await this.load(input);
    if (Result.isFailure(current)) return current;
    const record = current.value;
    if (
      !record ||
      String(record.actionFingerprint) !== String(input.actionFingerprint) ||
      record.executionRef !== input.executionRef ||
      record.idempotencyKey !== input.idempotencyKey
    ) {
      return Result.succeed({ type: "not_found" });
    }
    return Result.succeed(
      (updated.value[0]?.meta?.changes ?? 0) > 0
        ? { type: "settled", record }
        : { type: "already_settled", record },
    );
  }

  async requestCancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    requestedAt: string;
  }): Result.ResultAsync<AsyncExecutionCancelResult, D1AsyncActionExecutionRepositoryError> {
    const batchDb = this.batchDb();
    if (Result.isFailure(batchDb)) return batchDb;
    const updated = await runBatch({
      db: batchDb.value,
      statements: [
        this.db
          .prepare(
            `UPDATE action_async_executions
                SET status = 'cancel_requested',
                    cancel_requested_at = COALESCE(cancel_requested_at, ?),
                    cancel_reason = COALESCE(cancel_reason, ?)
              WHERE organization_id = ? AND action_request_id = ? AND status IN ('accepted', 'cancel_requested')`,
          )
          .bind(
            input.requestedAt,
            input.reason,
            String(input.organizationId),
            String(input.actionRequestId),
          ),
      ],
    });
    if (Result.isFailure(updated)) return updated;
    const current = await this.load(input);
    if (Result.isFailure(current)) return current;
    if (!current.value) return Result.succeed({ type: "not_found" });
    return Result.succeed(
      current.value.status === "completed"
        ? { type: "already_settled", record: current.value }
        : { type: "cancel_requested", record: current.value },
    );
  }
}
