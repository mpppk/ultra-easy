import { Result } from "@praha/byethrow";

import { actionEventKey, ActionEventRepositoryError, canonicalizeJson } from "@app/approval-core";
import type {
  ActionEvent,
  ActionEventRecord,
  ActionEventRepository,
  ActionRequestId,
  JsonValue,
  OrganizationId,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { prepareNotificationOutboxInsert } from "./notification-outbox-repository.ts";

type StoredActionEventRow = {
  sequence: number;
  organization_id: string;
  action_request_id: string;
  event_key: string;
  event_type: ActionEvent["type"];
  occurred_at: string;
  event_json: string;
};

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

export class D1ActionEventRepositoryError extends ActionEventRepositoryError {
  readonly name = "D1ActionEventRepositoryError";

  constructor(
    message: string,
    readonly conflict = false,
    retriable = !conflict,
  ) {
    super(conflict ? "action_event_conflict" : "action_event_repository_error", retriable, message);
  }
}

function repositoryError(error: unknown, fallback: string): D1ActionEventRepositoryError {
  return error instanceof D1ActionEventRepositoryError
    ? error
    : new D1ActionEventRepositoryError(error instanceof Error ? error.message : fallback);
}

function serializeEvent(event: ActionEvent): Result.Result<string, D1ActionEventRepositoryError> {
  const serialized = canonicalizeJson(event as unknown as JsonValue);
  return Result.isFailure(serialized)
    ? Result.fail(new D1ActionEventRepositoryError(serialized.error.message))
    : Result.succeed(serialized.value);
}

function validateRecord(
  record: ActionEventRecord,
): Result.Result<string, D1ActionEventRepositoryError> {
  const expected = actionEventKey({ organizationId: record.organizationId, event: record.event });
  if (record.eventKey !== expected) {
    return Result.fail(
      new D1ActionEventRepositoryError(
        `Action event keyがdomain eventと一致しません: expected=${expected}, actual=${record.eventKey}`,
      ),
    );
  }
  return serializeEvent(record.event);
}

export function prepareActionEventInsert(
  db: D1DatabaseLike,
  record: ActionEventRecord,
): Result.Result<D1PreparedStatementLike, D1ActionEventRepositoryError> {
  const eventJson = validateRecord(record);
  if (Result.isFailure(eventJson)) return eventJson;

  return Result.succeed(
    db
      .prepare(
        `INSERT OR IGNORE INTO action_events (
           organization_id, action_request_id, event_key, event_type, occurred_at, event_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.organizationId,
        record.event.actionRequestId,
        record.eventKey,
        record.event.type,
        record.occurredAt,
        eventJson.value,
      ),
  );
}

export function prepareActionEventPersistenceStatements(
  db: D1DatabaseLike,
  record: ActionEventRecord,
): Result.Result<D1PreparedStatementLike[], D1ActionEventRepositoryError> {
  const event = prepareActionEventInsert(db, record);
  if (Result.isFailure(event)) return event;
  const outbox = prepareNotificationOutboxInsert(db, record);
  return Result.succeed(outbox ? [event.value, outbox] : [event.value]);
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): D1ActionEventRepositoryError =>
    repositoryError(error, "Action eventのappendに失敗しました"),
});

const runBatch = Result.fn({
  try: async (input: {
    db: D1BatchDatabaseLike;
    statements: D1PreparedStatementLike[];
  }): Promise<D1RunResultLike[]> => input.db.batch(input.statements),
  catch: (error): D1ActionEventRepositoryError =>
    repositoryError(error, "Action event batchのappendに失敗しました"),
});

const firstStoredRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredActionEventRow | null> =>
    statement.first<StoredActionEventRow>(),
  catch: (error): D1ActionEventRepositoryError =>
    repositoryError(error, "Action eventの取得に失敗しました"),
});

const allStoredRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredActionEventRow[]> => {
    if (!statement.all) {
      return Promise.reject(new D1ActionEventRepositoryError("D1 all()が利用できません"));
    }
    return (await statement.all<StoredActionEventRow>()).results;
  },
  catch: (error): D1ActionEventRepositoryError =>
    repositoryError(error, "Action event一覧の取得に失敗しました"),
});

const parseEvent = Result.fn({
  try: (value: string): ActionEvent => JSON.parse(value) as ActionEvent,
  catch: (error): D1ActionEventRepositoryError =>
    repositoryError(error, "保存済みAction eventをparseできません"),
});

function asBatchDatabase(db: D1DatabaseLike): D1BatchDatabaseLike | null {
  const candidate = db as Partial<D1BatchDatabaseLike>;
  return typeof candidate.batch === "function" ? (db as D1BatchDatabaseLike) : null;
}

export class D1ActionEventRepository implements ActionEventRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async append(
    record: ActionEventRecord,
  ): Result.ResultAsync<"created" | "existing", D1ActionEventRepositoryError> {
    const eventJson = validateRecord(record);
    if (Result.isFailure(eventJson)) return eventJson;

    const existing = await firstStoredRow(
      this.db
        .prepare(
          `SELECT sequence, organization_id, action_request_id, event_key, event_type,
                  occurred_at, event_json
             FROM action_events
            WHERE organization_id = ? AND event_key = ?`,
        )
        .bind(record.organizationId, record.eventKey),
    );
    if (Result.isFailure(existing)) return existing;
    if (existing.value) {
      const same =
        existing.value.action_request_id === String(record.event.actionRequestId) &&
        existing.value.event_type === record.event.type &&
        existing.value.occurred_at === record.occurredAt &&
        existing.value.event_json === eventJson.value;
      return same
        ? Result.succeed("existing")
        : Result.fail(
            new D1ActionEventRepositoryError(
              `既存Action eventと同じeventKeyの内容が一致しません: ${record.eventKey}`,
              true,
            ),
          );
    }

    const statements = prepareActionEventPersistenceStatements(this.db, record);
    if (Result.isFailure(statements)) return statements;

    if (statements.value.length === 1) {
      const saved = await runStatement(statements.value[0]!);
      if (Result.isFailure(saved)) return saved;
      if (!saved.value.success) {
        return Result.fail(
          repositoryError(saved.value.error, "Action eventのappendに失敗しました"),
        );
      }
      return Result.succeed((saved.value.meta?.changes ?? 0) > 0 ? "created" : "existing");
    }

    const batchDb = asBatchDatabase(this.db);
    if (!batchDb) {
      return Result.fail(
        repositoryError(
          undefined,
          "D1 batch()が利用できないためeventとoutboxをatomicに保存できません",
        ),
      );
    }
    const saved = await runBatch({ db: batchDb, statements: statements.value });
    if (Result.isFailure(saved)) return saved;
    const failed = saved.value.find((result) => !result.success);
    if (failed) {
      return Result.fail(
        repositoryError(failed.error, "Action event/outbox batchのappendに失敗しました"),
      );
    }
    return Result.succeed((saved.value[0]?.meta?.changes ?? 0) > 0 ? "created" : "existing");
  }

  /**
   * 複数eventを追記する。`append`と同じく、同じeventKeyの既存rowがある場合は内容の一致を
   * 検証し、異なる内容を黙って無視しない（#99）。
   */
  async appendMany(
    records: readonly ActionEventRecord[],
  ): Result.ResultAsync<void, D1ActionEventRepositoryError> {
    const statements: D1PreparedStatementLike[] = [];
    const eventStatementIndexes: { index: number; record: ActionEventRecord }[] = [];
    let requiresAtomicOutbox = false;
    for (const record of records) {
      const prepared = prepareActionEventPersistenceStatements(this.db, record);
      if (Result.isFailure(prepared)) return prepared;
      if (prepared.value.length > 1) requiresAtomicOutbox = true;
      eventStatementIndexes.push({ index: statements.length, record });
      statements.push(...prepared.value);
    }
    if (statements.length === 0) return Result.succeed(undefined);

    let results: D1RunResultLike[];
    const batchDb = asBatchDatabase(this.db);
    if (batchDb) {
      const saved = await runBatch({ db: batchDb, statements });
      if (Result.isFailure(saved)) return saved;
      const failed = saved.value.find((result) => !result.success);
      if (failed) {
        return Result.fail(
          repositoryError(failed.error, "Action event/outbox batchのappendに失敗しました"),
        );
      }
      results = saved.value;
    } else {
      if (requiresAtomicOutbox) {
        return Result.fail(
          repositoryError(
            undefined,
            "D1 batch()が利用できないためeventとoutboxをatomicに保存できません",
          ),
        );
      }
      results = [];
      for (const statement of statements) {
        const saved = await runStatement(statement);
        if (Result.isFailure(saved)) return saved;
        if (!saved.value.success) {
          return Result.fail(
            repositoryError(saved.value.error, "Action eventのappendに失敗しました"),
          );
        }
        results.push(saved.value);
      }
    }

    for (const { index, record } of eventStatementIndexes) {
      if ((results[index]?.meta?.changes ?? 1) > 0) continue;
      const verified = await this.verifyExisting(record);
      if (Result.isFailure(verified)) return verified;
    }
    return Result.succeed(undefined);
  }

  /** INSERT OR IGNOREで無視された既存rowが、同じ内容であることを確認する。 */
  private async verifyExisting(
    record: ActionEventRecord,
  ): Result.ResultAsync<void, D1ActionEventRepositoryError> {
    const eventJson = validateRecord(record);
    if (Result.isFailure(eventJson)) return eventJson;
    const existing = await firstStoredRow(
      this.db
        .prepare(
          `SELECT sequence, organization_id, action_request_id, event_key, event_type,
                  occurred_at, event_json
             FROM action_events
            WHERE organization_id = ? AND event_key = ?`,
        )
        .bind(record.organizationId, record.eventKey),
    );
    if (Result.isFailure(existing)) return existing;
    const same =
      existing.value !== null &&
      existing.value.action_request_id === String(record.event.actionRequestId) &&
      existing.value.event_type === record.event.type &&
      existing.value.event_json === eventJson.value;
    return same
      ? Result.succeed(undefined)
      : Result.fail(
          new D1ActionEventRepositoryError(
            `既存Action eventと同じeventKeyの内容が一致しません: ${record.eventKey}`,
            true,
          ),
        );
  }

  /**
   * 直近に更新されたActionRequest（最大limit件）のeventを1 queryで返す（#95: dashboardのN+1解消）。
   * 並びはActionRequestごとのsequence順。
   */
  async listForRecentActions(input: {
    organizationId: OrganizationId;
    limit: number;
  }): Result.ResultAsync<
    { actionRequestIds: ActionRequestId[]; records: ActionEventRecord[] },
    D1ActionEventRepositoryError
  > {
    const rows = await allStoredRows(
      this.db
        .prepare(
          `WITH recent AS (
             SELECT action_request_id, MAX(sequence) AS max_sequence
               FROM action_events
              WHERE organization_id = ?
              GROUP BY action_request_id
              ORDER BY max_sequence DESC
              LIMIT ?
           )
           SELECT e.sequence, e.organization_id, e.action_request_id, e.event_key, e.event_type,
                  e.occurred_at, e.event_json
             FROM action_events e
             JOIN recent r ON r.action_request_id = e.action_request_id
            WHERE e.organization_id = ?
            ORDER BY r.max_sequence DESC, e.sequence ASC`,
        )
        .bind(input.organizationId, input.limit, input.organizationId),
    );
    if (Result.isFailure(rows)) return rows;
    const records: ActionEventRecord[] = [];
    const actionRequestIds: ActionRequestId[] = [];
    for (const row of rows.value) {
      const event = parseEvent(row.event_json);
      if (Result.isFailure(event)) return event;
      if (actionRequestIds.at(-1) !== row.action_request_id) {
        actionRequestIds.push(row.action_request_id as ActionRequestId);
      }
      records.push({
        organizationId: row.organization_id as OrganizationId,
        eventKey: row.event_key,
        occurredAt: row.occurred_at,
        event: event.value,
      });
    }
    return Result.succeed({ actionRequestIds, records });
  }

  async listForAction(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionEventRecord[], D1ActionEventRepositoryError> {
    const rows = await allStoredRows(
      this.db
        .prepare(
          `SELECT sequence, organization_id, action_request_id, event_key, event_type,
                  occurred_at, event_json
             FROM action_events
            WHERE organization_id = ? AND action_request_id = ?
            ORDER BY sequence ASC`,
        )
        .bind(input.organizationId, input.actionRequestId),
    );
    if (Result.isFailure(rows)) return rows;

    const records: ActionEventRecord[] = [];
    for (const row of rows.value) {
      const event = parseEvent(row.event_json);
      if (Result.isFailure(event)) return event;
      records.push({
        organizationId: row.organization_id as OrganizationId,
        eventKey: row.event_key,
        occurredAt: row.occurred_at,
        event: event.value,
      });
    }
    return Result.succeed(records);
  }
}
