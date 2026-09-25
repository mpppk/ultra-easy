import { Result } from "@praha/byethrow";
import { storedBrand, storedBrands } from "./stored-brand.ts";

import { notificationDeliveryKey, notificationKeyForEvent } from "@app/approval-core";
import type {
  ActionEvent,
  ActionEventRecord,
  ActionRequestId,
  NotificationRequest,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

export type NotificationRecipientMode = "direct_user" | "task_candidates" | "action_requester";
/**
 * - failed: queue送信に失敗し、next_attempt_at以降に再送する
 * - dead: 再送上限超過、またはqueue consumerが諦めてDLQに入った。人手で確認する
 * - skipped: sink未設定で配信しなかった。sink設定後に`requeueSkipped`でpendingへ戻す
 */
export type NotificationOutboxStatus = "pending" | "dispatched" | "failed" | "dead" | "skipped";
export type NotificationDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

/** outbox dispatch（queue送信）のretry方針。 */
export type OutboxDispatchRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_OUTBOX_DISPATCH_RETRY_POLICY: OutboxDispatchRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 60_000,
  maxDelayMs: 60 * 60_000,
};

export type NotificationOutboxEntry = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  outboxKey: string;
  notificationKey: string;
  eventKey: string;
  eventType: ActionEvent["type"];
  recipientMode: NotificationRecipientMode;
  recipientUserId?: UserId;
  materializedStepId?: string;
  status: NotificationOutboxStatus;
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  dispatchedAt?: string;
};

export type NotificationDelivery = {
  organizationId: OrganizationId;
  notificationKey: string;
  eventKey: string;
  recipientUserId: UserId;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
};

export type NotificationOutboxHealth = {
  pendingOutbox: number;
  failedOutbox: number;
  deadOutbox: number;
  failedDeliveries: number;
  skippedDeliveries: number;
};

type StoredOutboxRow = {
  organization_id: string;
  action_request_id: string;
  outbox_key: string;
  notification_key: string;
  event_key: string;
  event_type: ActionEvent["type"];
  recipient_mode: NotificationRecipientMode;
  recipient_user_id: string | null;
  materialized_step_id: string | null;
  status: NotificationOutboxStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  dispatched_at: string | null;
};

type StoredDeliveryRow = {
  organization_id: string;
  notification_key: string;
  event_key: string;
  recipient_user_id: string;
  status: NotificationDeliveryStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

type StoredEventRow = {
  event_json: string;
};

type StoredCandidatesRow = {
  candidate_user_ids: string;
};

export class D1NotificationOutboxRepositoryError extends Error {
  readonly name = "D1NotificationOutboxRepositoryError";
  readonly code = "notification_outbox_repository_error";
  readonly retriable = true;
}

function repositoryError(error: unknown, fallback: string): D1NotificationOutboxRepositoryError {
  return new D1NotificationOutboxRepositoryError(error instanceof Error ? error.message : fallback);
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox statementの実行に失敗しました"),
});

const firstUnknownRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown> => statement.first<unknown>(),
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox rowの取得に失敗しました"),
});

async function firstRow<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, D1NotificationOutboxRepositoryError> {
  const row = await firstUnknownRow(statement);
  return row as Result.Result<T | null, D1NotificationOutboxRepositoryError>;
}

const allUnknownRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown[]> => {
    if (!statement.all) return Promise.reject(new Error("D1 all()が利用できません"));
    return (await statement.all<unknown>()).results;
  },
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox rowsの取得に失敗しました"),
});

async function allRows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], D1NotificationOutboxRepositoryError> {
  const rows = await allUnknownRows(statement);
  return Result.isFailure(rows) ? rows : Result.succeed(rows.value as T[]);
}

const parseUnknownJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value) as unknown,
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox JSONをparseできません"),
});

function parseJson<T>(value: string): Result.Result<T, D1NotificationOutboxRepositoryError> {
  const parsed = parseUnknownJson(value);
  return parsed as Result.Result<T, D1NotificationOutboxRepositoryError>;
}

function outboxKey(eventKey: string): string {
  return `outbox:${eventKey}`;
}

function outboxDraft(record: ActionEventRecord): {
  recipientMode: NotificationRecipientMode;
  recipientUserId?: UserId;
  materializedStepId?: string;
} | null {
  switch (record.event.type) {
    case "step.activated":
      if (record.event.target?.type === "user") {
        return {
          recipientMode: "direct_user",
          recipientUserId: record.event.target.userId,
          materializedStepId: String(record.event.materializedStepId),
        };
      }
      return {
        recipientMode: "task_candidates",
        materializedStepId: String(record.event.materializedStepId),
      };
    case "step.approved":
    case "step.rejected":
    case "step.expired":
    case "action.completed":
      return { recipientMode: "action_requester" };
    default:
      return null;
  }
}

export function prepareNotificationOutboxInsert(
  db: D1DatabaseLike,
  record: ActionEventRecord,
): D1PreparedStatementLike | null {
  const draft = outboxDraft(record);
  if (!draft) return null;
  const notificationKey = notificationKeyForEvent(record.eventKey);
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox_events (
         organization_id, action_request_id, outbox_key, notification_key,
         event_key, event_type, recipient_mode, recipient_user_id,
         materialized_step_id, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      record.organizationId,
      record.event.actionRequestId,
      outboxKey(record.eventKey),
      notificationKey,
      record.eventKey,
      record.event.type,
      draft.recipientMode,
      draft.recipientUserId ?? null,
      draft.materializedStepId ?? null,
      record.occurredAt,
    );
}

function rowError(message: string): D1NotificationOutboxRepositoryError {
  return repositoryError(undefined, message);
}

function mapOutbox(
  row: StoredOutboxRow,
): Result.Result<NotificationOutboxEntry, D1NotificationOutboxRepositoryError> {
  const organizationId = storedBrand("OrganizationId", row.organization_id, rowError);
  if (Result.isFailure(organizationId)) return organizationId;
  const actionRequestId = storedBrand("ActionRequestId", row.action_request_id, rowError);
  if (Result.isFailure(actionRequestId)) return actionRequestId;
  let recipientUserId: UserId | undefined;
  if (row.recipient_user_id !== null) {
    const parsed = storedBrand("UserId", row.recipient_user_id, rowError);
    if (Result.isFailure(parsed)) return parsed;
    recipientUserId = parsed.value;
  }
  return Result.succeed({
    organizationId: organizationId.value,
    actionRequestId: actionRequestId.value,
    outboxKey: row.outbox_key,
    notificationKey: row.notification_key,
    eventKey: row.event_key,
    eventType: row.event_type,
    recipientMode: row.recipient_mode,
    ...(recipientUserId !== undefined ? { recipientUserId } : {}),
    ...(row.materialized_step_id !== null ? { materializedStepId: row.materialized_step_id } : {}),
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
  });
}

function mapDelivery(
  row: StoredDeliveryRow,
): Result.Result<NotificationDelivery, D1NotificationOutboxRepositoryError> {
  const organizationId = storedBrand("OrganizationId", row.organization_id, rowError);
  if (Result.isFailure(organizationId)) return organizationId;
  const recipientUserId = storedBrand("UserId", row.recipient_user_id, rowError);
  if (Result.isFailure(recipientUserId)) return recipientUserId;
  return Result.succeed({
    organizationId: organizationId.value,
    notificationKey: row.notification_key,
    eventKey: row.event_key,
    recipientUserId: recipientUserId.value,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
  });
}

function requesterFromEvent(event: ActionEvent): UserId | null {
  if (event.type !== "action.received") return null;
  if (event.caller?.type === "user") return event.caller.id;
  if (event.authority.type === "user") return event.authority.id;
  if (event.actor.type === "user") return event.actor.id;
  return null;
}

export class D1NotificationOutboxRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async listDispatchable(
    now: string,
    limit = 100,
  ): Result.ResultAsync<NotificationOutboxEntry[], D1NotificationOutboxRepositoryError> {
    const rows = await allRows<StoredOutboxRow>(
      this.db
        .prepare(
          `SELECT organization_id, action_request_id, outbox_key, notification_key,
                  event_key, event_type, recipient_mode, recipient_user_id,
                  materialized_step_id, status, attempt_count, last_error,
                  created_at, dispatched_at
             FROM outbox_events
            WHERE status IN ('pending', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY sequence ASC
            LIMIT ?`,
        )
        .bind(now, limit),
    );
    if (Result.isFailure(rows)) return rows;
    const entries: NotificationOutboxEntry[] = [];
    for (const row of rows.value) {
      const entry = mapOutbox(row);
      if (Result.isFailure(entry)) return entry;
      entries.push(entry.value);
    }
    return Result.succeed(entries);
  }

  async load(input: {
    organizationId: OrganizationId;
    outboxKey: string;
  }): Result.ResultAsync<NotificationOutboxEntry | null, D1NotificationOutboxRepositoryError> {
    const row = await firstRow<StoredOutboxRow>(
      this.db
        .prepare(
          `SELECT organization_id, action_request_id, outbox_key, notification_key,
                  event_key, event_type, recipient_mode, recipient_user_id,
                  materialized_step_id, status, attempt_count, last_error,
                  created_at, dispatched_at
             FROM outbox_events
            WHERE organization_id = ? AND outbox_key = ?`,
        )
        .bind(input.organizationId, input.outboxKey),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? mapOutbox(row.value) : Result.succeed(null);
  }

  async markDispatched(input: {
    organizationId: OrganizationId;
    outboxKey: string;
    dispatchedAt: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE outbox_events
              SET status = 'dispatched',
                  attempt_count = attempt_count + 1,
                  last_error = NULL,
                  dispatched_at = ?
            WHERE organization_id = ? AND outbox_key = ?`,
        )
        .bind(input.dispatchedAt, input.organizationId, input.outboxKey),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "outbox dispatched更新に失敗しました"));
  }

  /**
   * queue送信の失敗を記録する。上限未満はbackoff付きでfailed（再送待ち）、上限到達でdeadにする。
   */
  async markDispatchFailed(input: {
    organizationId: OrganizationId;
    outboxKey: string;
    error: string;
    now: string;
    policy?: OutboxDispatchRetryPolicy;
  }): Result.ResultAsync<{ status: "failed" | "dead" }, D1NotificationOutboxRepositoryError> {
    const policy = input.policy ?? DEFAULT_OUTBOX_DISPATCH_RETRY_POLICY;
    const current = await this.load(input);
    if (Result.isFailure(current)) return current;
    const attempts = (current.value?.attemptCount ?? 0) + 1;
    const status = attempts >= policy.maxAttempts ? "dead" : "failed";
    const delay = Math.min(policy.baseDelayMs * 2 ** (attempts - 1), policy.maxDelayMs);
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE outbox_events
              SET status = ?,
                  attempt_count = attempt_count + 1,
                  last_error = ?,
                  next_attempt_at = ?
            WHERE organization_id = ? AND outbox_key = ?`,
        )
        .bind(
          status,
          input.error,
          status === "dead" ? null : new Date(Date.parse(input.now) + delay).toISOString(),
          input.organizationId,
          input.outboxKey,
        ),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed({ status })
      : Result.fail(repositoryError(result.value.error, "outbox failure更新に失敗しました"));
  }

  /** queue consumerが諦めてDLQに入ったoutboxをdeadにする（dispatch済みからのreconcile）。 */
  async markDead(input: {
    organizationId: OrganizationId;
    outboxKey: string;
    error: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    return this.setStatus(input, "dead", input.error);
  }

  /** sink未設定で配信しなかったoutbox。sink設定後に`requeueSkipped`で再送できる。 */
  async markSkipped(input: {
    organizationId: OrganizationId;
    outboxKey: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    return this.setStatus(input, "skipped", null);
  }

  /** skippedのoutboxをpendingへ戻す（sinkが設定済みのときにcronから呼ぶ）。 */
  async requeueSkipped(
    limit = 100,
  ): Result.ResultAsync<number, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE outbox_events
              SET status = 'pending', next_attempt_at = NULL
            WHERE sequence IN (
              SELECT sequence FROM outbox_events WHERE status = 'skipped'
               ORDER BY sequence ASC LIMIT ?
            )`,
        )
        .bind(limit),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(result.value.meta?.changes ?? 0)
      : Result.fail(repositoryError(result.value.error, "skipped outboxの再送準備に失敗しました"));
  }

  private async setStatus(
    input: { organizationId: OrganizationId; outboxKey: string },
    status: NotificationOutboxStatus,
    error: string | null,
  ): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE outbox_events
              SET status = ?, last_error = COALESCE(?, last_error), next_attempt_at = NULL
            WHERE organization_id = ? AND outbox_key = ?`,
        )
        .bind(status, error, input.organizationId, input.outboxKey),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "outbox status更新に失敗しました"));
  }

  async loadSourceEvent(
    entry: NotificationOutboxEntry,
  ): Result.ResultAsync<ActionEventRecord | null, D1NotificationOutboxRepositoryError> {
    const row = await firstRow<StoredEventRow>(
      this.db
        .prepare(
          `SELECT event_json
             FROM action_events
            WHERE organization_id = ? AND event_key = ?`,
        )
        .bind(entry.organizationId, entry.eventKey),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const event = parseJson<ActionEvent>(row.value.event_json);
    if (Result.isFailure(event)) return event;
    return Result.succeed({
      organizationId: entry.organizationId,
      eventKey: entry.eventKey,
      occurredAt: entry.createdAt,
      event: event.value,
    });
  }

  async resolveRecipients(
    entry: NotificationOutboxEntry,
  ): Result.ResultAsync<UserId[], D1NotificationOutboxRepositoryError> {
    if (entry.recipientMode === "direct_user") {
      return Result.succeed(entry.recipientUserId ? [entry.recipientUserId] : []);
    }

    if (entry.recipientMode === "task_candidates") {
      if (!entry.materializedStepId) return Result.succeed([]);
      const row = await firstRow<StoredCandidatesRow>(
        this.db
          .prepare(
            `SELECT candidate_user_ids
               FROM approval_tasks
              WHERE organization_id = ?
                AND action_request_id = ?
                AND materialized_step_id = ?
              ORDER BY activated_at ASC
              LIMIT 1`,
          )
          .bind(entry.organizationId, entry.actionRequestId, entry.materializedStepId),
      );
      if (Result.isFailure(row)) return row;
      if (!row.value) return Result.succeed([]);
      const candidates = parseJson<unknown[]>(row.value.candidate_user_ids);
      if (Result.isFailure(candidates)) return candidates;
      return storedBrands("UserId", candidates.value, rowError);
    }

    const row = await firstRow<StoredEventRow>(
      this.db
        .prepare(
          `SELECT event_json
             FROM action_events
            WHERE organization_id = ?
              AND action_request_id = ?
              AND event_type = 'action.received'
            ORDER BY sequence ASC
            LIMIT 1`,
        )
        .bind(entry.organizationId, entry.actionRequestId),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed([]);
    const event = parseJson<ActionEvent>(row.value.event_json);
    if (Result.isFailure(event)) return event;
    const requester = requesterFromEvent(event.value);
    return Result.succeed(requester ? [requester] : []);
  }

  async ensureDelivery(input: {
    entry: NotificationOutboxEntry;
    recipientUserId: UserId;
    now: string;
  }): Result.ResultAsync<NotificationDelivery, D1NotificationOutboxRepositoryError> {
    const inserted = await runStatement(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_deliveries (
             organization_id, notification_key, event_key, recipient_user_id,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          input.entry.organizationId,
          input.entry.notificationKey,
          input.entry.eventKey,
          input.recipientUserId,
          input.now,
          input.now,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if (!inserted.value.success) {
      return Result.fail(
        repositoryError(inserted.value.error, "notification deliveryの作成に失敗しました"),
      );
    }
    const loaded = await this.loadDelivery({
      organizationId: input.entry.organizationId,
      notificationKey: input.entry.notificationKey,
      recipientUserId: input.recipientUserId,
    });
    if (Result.isFailure(loaded)) return loaded;
    return loaded.value
      ? Result.succeed(loaded.value)
      : Result.fail(repositoryError(undefined, "notification deliveryを再読込できません"));
  }

  async loadDelivery(input: {
    organizationId: OrganizationId;
    notificationKey: string;
    recipientUserId: UserId;
  }): Result.ResultAsync<NotificationDelivery | null, D1NotificationOutboxRepositoryError> {
    const row = await firstRow<StoredDeliveryRow>(
      this.db
        .prepare(
          `SELECT organization_id, notification_key, event_key, recipient_user_id,
                  status, attempt_count, last_error, created_at, updated_at, sent_at
             FROM notification_deliveries
            WHERE organization_id = ?
              AND notification_key = ?
              AND recipient_user_id = ?`,
        )
        .bind(input.organizationId, input.notificationKey, input.recipientUserId),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? mapDelivery(row.value) : Result.succeed(null);
  }

  async markDeliverySent(input: {
    organizationId: OrganizationId;
    notificationKey: string;
    recipientUserId: UserId;
    sentAt: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE notification_deliveries
              SET status = 'sent',
                  attempt_count = attempt_count + 1,
                  last_error = NULL,
                  updated_at = ?,
                  sent_at = ?
            WHERE organization_id = ?
              AND notification_key = ?
              AND recipient_user_id = ?`,
        )
        .bind(
          input.sentAt,
          input.sentAt,
          input.organizationId,
          input.notificationKey,
          input.recipientUserId,
        ),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "notification sent更新に失敗しました"));
  }

  async markDeliverySkipped(input: {
    organizationId: OrganizationId;
    notificationKey: string;
    recipientUserId: UserId;
    skippedAt: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE notification_deliveries
              SET status = 'skipped', updated_at = ?
            WHERE organization_id = ?
              AND notification_key = ?
              AND recipient_user_id = ?`,
        )
        .bind(input.skippedAt, input.organizationId, input.notificationKey, input.recipientUserId),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "notification skipped更新に失敗しました"));
  }

  async markDeliveryFailed(input: {
    organizationId: OrganizationId;
    notificationKey: string;
    recipientUserId: UserId;
    failedAt: string;
    error: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE notification_deliveries
              SET status = 'failed',
                  attempt_count = attempt_count + 1,
                  last_error = ?,
                  updated_at = ?
            WHERE organization_id = ?
              AND notification_key = ?
              AND recipient_user_id = ?`,
        )
        .bind(
          input.error,
          input.failedAt,
          input.organizationId,
          input.notificationKey,
          input.recipientUserId,
        ),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "notification failure更新に失敗しました"));
  }

  async health(): Result.ResultAsync<
    NotificationOutboxHealth,
    D1NotificationOutboxRepositoryError
  > {
    return this.countByStatus(null);
  }

  async healthForOrganization(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<NotificationOutboxHealth, D1NotificationOutboxRepositoryError> {
    return this.countByStatus(input.organizationId);
  }

  private async countByStatus(
    organizationId: OrganizationId | null,
  ): Result.ResultAsync<NotificationOutboxHealth, D1NotificationOutboxRepositoryError> {
    const outbox = await allRows<{ status: NotificationOutboxStatus; count: number }>(
      this.db
        .prepare(
          `SELECT status, COUNT(*) AS count FROM outbox_events
            WHERE (? IS NULL OR organization_id = ?)
              AND status IN ('pending', 'failed', 'dead')
            GROUP BY status`,
        )
        .bind(organizationId, organizationId),
    );
    if (Result.isFailure(outbox)) return outbox;
    const deliveries = await allRows<{ status: NotificationDeliveryStatus; count: number }>(
      this.db
        .prepare(
          `SELECT status, COUNT(*) AS count FROM notification_deliveries
            WHERE (? IS NULL OR organization_id = ?)
              AND status IN ('failed', 'skipped')
            GROUP BY status`,
        )
        .bind(organizationId, organizationId),
    );
    if (Result.isFailure(deliveries)) return deliveries;
    const outboxCount = (status: NotificationOutboxStatus) =>
      outbox.value.find((row) => row.status === status)?.count ?? 0;
    const deliveryCount = (status: NotificationDeliveryStatus) =>
      deliveries.value.find((row) => row.status === status)?.count ?? 0;
    return Result.succeed({
      pendingOutbox: outboxCount("pending"),
      failedOutbox: outboxCount("failed"),
      deadOutbox: outboxCount("dead"),
      failedDeliveries: deliveryCount("failed"),
      skippedDeliveries: deliveryCount("skipped"),
    });
  }

  notificationRequest(input: {
    entry: NotificationOutboxEntry;
    event: ActionEvent;
    recipientUserId: UserId;
  }): NotificationRequest {
    return {
      organizationId: input.entry.organizationId,
      actionRequestId: input.entry.actionRequestId,
      notificationKey: notificationDeliveryKey({
        notificationKey: input.entry.notificationKey,
        recipientUserId: input.recipientUserId,
      }),
      eventKey: input.entry.eventKey,
      eventType: input.entry.eventType,
      event: input.event,
      recipientUserId: input.recipientUserId,
      occurredAt: input.entry.createdAt,
    };
  }
}
