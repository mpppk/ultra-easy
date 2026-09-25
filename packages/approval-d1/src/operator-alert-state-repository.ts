import { Result } from "@praha/byethrow";

import { OPERATOR_ALERT_KEYS } from "@app/approval-core";
import type {
  OperatorAlertKey,
  OperatorAlertStatus,
  OrganizationId,
  PersistedOperatorAlertState,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

export class D1OperatorAlertStateRepositoryError extends Error {
  readonly name = "D1OperatorAlertStateRepositoryError";
  readonly code = "operator_alert_state_repository_error";
  readonly retriable = true;
}

function repositoryError(error: unknown, fallback: string): D1OperatorAlertStateRepositoryError {
  return new D1OperatorAlertStateRepositoryError(error instanceof Error ? error.message : fallback);
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): D1OperatorAlertStateRepositoryError =>
    repositoryError(error, "operator alert state statementの実行に失敗しました"),
});

const allUnknownRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown[]> => {
    if (!statement.all) return Promise.reject(new Error("D1 all()が利用できません"));
    return (await statement.all<unknown>()).results;
  },
  catch: (error): D1OperatorAlertStateRepositoryError =>
    repositoryError(error, "operator alert state rowsの取得に失敗しました"),
});

type StoredAlertStateRow = {
  alert_key: string;
  status: string;
  breached_since: string | null;
  last_outbox_failed_total: number | null;
  last_executor_failure_total: number | null;
  updated_at: string;
};

function isAlertKey(value: string): value is OperatorAlertKey {
  return (OPERATOR_ALERT_KEYS as readonly string[]).includes(value);
}

function isAlertStatus(value: string): value is OperatorAlertStatus {
  return value === "ok" || value === "breaching" || value === "firing";
}

export class D1OperatorAlertStateRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async loadAll(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<PersistedOperatorAlertState[], D1OperatorAlertStateRepositoryError> {
    const rows = await allUnknownRows(
      this.db
        .prepare(
          `SELECT alert_key, status, breached_since,
                  last_outbox_failed_total, last_executor_failure_total, updated_at
             FROM operator_alert_states
            WHERE organization_id = ?`,
        )
        .bind(input.organizationId),
    );
    if (Result.isFailure(rows)) return rows;
    const states: PersistedOperatorAlertState[] = [];
    for (const unknown of rows.value) {
      const row = unknown as StoredAlertStateRow;
      if (!isAlertKey(row.alert_key) || !isAlertStatus(row.status)) {
        return Result.fail(
          repositoryError(
            new Error(`未知のalert state行です: ${String(row.alert_key)}/${String(row.status)}`),
            "operator alert state行をparseできません",
          ),
        );
      }
      states.push({
        key: row.alert_key,
        status: row.status,
        breachedSince: row.breached_since,
        lastOutboxFailedTotal: row.last_outbox_failed_total,
        lastExecutorFailureTotal: row.last_executor_failure_total,
        updatedAt: row.updated_at,
      });
    }
    return Result.succeed(states);
  }

  async save(
    input: { organizationId: OrganizationId } & PersistedOperatorAlertState,
  ): Result.ResultAsync<void, D1OperatorAlertStateRepositoryError> {
    const saved = await runStatement(
      this.db
        .prepare(
          `INSERT INTO operator_alert_states (
             organization_id, alert_key, status, breached_since,
             last_outbox_failed_total, last_executor_failure_total, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, alert_key) DO UPDATE SET
             status = excluded.status,
             breached_since = excluded.breached_since,
             last_outbox_failed_total = excluded.last_outbox_failed_total,
             last_executor_failure_total = excluded.last_executor_failure_total,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.organizationId,
          input.key,
          input.status,
          input.breachedSince,
          input.lastOutboxFailedTotal,
          input.lastExecutorFailureTotal,
          input.updatedAt,
        ),
    );
    if (Result.isFailure(saved)) return saved;
    return Result.succeed(undefined);
  }
}
