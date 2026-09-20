import { Result } from "@praha/byethrow";

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
export type NotificationOutboxStatus = "pending" | "dispatched" | "failed";
export type NotificationDeliveryStatus = "pending" | "sent" | "failed";

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
  failedDeliveries: number;
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

type StoredCountRow = {
  count: number;
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

const firstRow = Result.fn({
  try: async <T>(statement: D1PreparedStatementLike): Promise<T | null> => statement.first<T>(),
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox rowの取得に失敗しました"),
});

const allRows = Result.fn({
  try: async <T>(statement: D1PreparedStatementLike): Promise<T[]> => {
    if (!statement.all) return Promise.reject(new Error("D1 all()が利用できません"));
    return (await statement.all<T>()).results;
  },
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox rowsの取得に失敗しました"),
});

const parseJson = Result.fn({
  try: <T>(value: string): T => JSON.parse(value) as T,
  catch: (error): D1NotificationOutboxRepositoryError =>
    repositoryError(error, "notification outbox JSONをparseできません"),
});

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

function mapOutbox(row: StoredOutboxRow): NotificationOutboxEntry {
  return {
    organizationId: row.organization_id as OrganizationId,
    actionRequestId: row.action_request_id as ActionRequestId,
    outboxKey: row.outbox_key,
    notificationKey: row.notification_key,
    eventKey: row.event_key,
    eventType: row.event_type,
    recipientMode: row.recipient_mode,
    ...(row.recipient_user_id !== null
      ? { recipientUserId: row.recipient_user_id as UserId }
      : {}),
    ...(row.materialized_step_id !== null ? { materializedStepId: row.materialized_step_id } : {}),
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
  };
}

function mapDelivery(row: StoredDeliveryRow): NotificationDelivery {
  return {
    organizationId: row.organization_id as OrganizationId,
    notificationKey: row.notification_key,
    eventKey: row.event_key,
    recipientUserId: row.recipient_user_id as UserId,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
  };
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
            ORDER BY sequence ASC
            LIMIT ?`,
        )
        .bind(limit),
    );
    return Result.isFailure(rows) ? rows : Result.succeed(rows.value.map(mapOutbox));
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
    return Result.isFailure(row)
      ? row
      : Result.succeed(row.value ? mapOutbox(row.value) : null);
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

  async markDispatchFailed(input: {
    organizationId: OrganizationId;
    outboxKey: string;
    error: string;
  }): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
    const result = await runStatement(
      this.db
        .prepare(
          `UPDATE outbox_events
              SET status = 'failed',
                  attempt_count = attempt_count + 1,
                  last_error = ?
            WHERE organization_id = ? AND outbox_key = ?`,
        )
        .bind(input.error, input.organizationId, input.outboxKey),
    );
    if (Result.isFailure(result)) return result;
    return result.value.success
      ? Result.succeed(undefined)
      : Result.fail(repositoryError(result.value.error, "outbox failure更新に失敗しました"));
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
      const candidates = parseJson<string[]>(row.value.candidate_user_ids);
      return Result.isFailure(candidates)
        ? candidates
        : Result.succeed(candidates.value.map((value) => value as UserId));
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
    return Result.isFailure(row)
      ? row
      : Result.succeed(row.value ? mapDelivery(row.value) : null);
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
    const pending = await firstRow<StoredCountRow>(
      this.db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'"),
    );
    if (Result.isFailure(pending)) return pending;
    const failedOutbox = await firstRow<StoredCountRow>(
      this.db.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'failed'"),
    );
    if (Result.isFailure(failedOutbox)) return failedOutbox;
    const failedDeliveries = await firstRow<StoredCountRow>(
      this.db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE status = 'failed'"),
    );
    if (Result.isFailure(failedDeliveries)) return failedDeliveries;
    return Result.succeed({
      pendingOutbox: pending.value?.count ?? 0,
      failedOutbox: failedOutbox.value?.count ?? 0,
      failedDeliveries: failedDeliveries.value?.count ?? 0,
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
