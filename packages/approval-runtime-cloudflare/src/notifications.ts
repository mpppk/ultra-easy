import { Result } from "@praha/byethrow";

import {
  actionCorrelation,
  CHANNEL_NOTIFICATION_RECIPIENT,
  metricRecord,
  safeLogRecord,
} from "@app/approval-core";
import type {
  ActionRequestId,
  NotificationSink,
  OrganizationId,
  TelemetrySink,
  UserId,
} from "@app/approval-core";
import type {
  D1NotificationOutboxRepository,
  D1NotificationOutboxRepositoryError,
  OutboxDispatchRetryPolicy,
} from "@app/approval-d1";

export type NotificationQueueMessage = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  outboxKey: string;
};

export interface NotificationQueueProducer {
  send(message: NotificationQueueMessage): Promise<void>;
}

export type NotificationDispatchResult = {
  attempted: number;
  dispatched: number;
  failed: number;
  dead: number;
};

export type NotificationConsumeResult = {
  /** 今回配信したdelivery数。 */
  delivered: number;
  /** 既にsent済みで再配信しなかったdelivery数（queueの再配送）。 */
  duplicate: number;
  /** sink未設定等で配信しなかったdelivery数（sentとして記録しない）。 */
  skipped: number;
};

class NotificationQueueSendError extends Error {
  readonly name = "NotificationQueueSendError";
}

export class NotificationConsumerError extends Error {
  readonly name = "NotificationConsumerError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

const sendQueueMessage = Result.fn({
  try: async (input: {
    queue: NotificationQueueProducer;
    message: NotificationQueueMessage;
  }): Promise<void> => input.queue.send(input.message),
  catch: (error): NotificationQueueSendError =>
    new NotificationQueueSendError(
      error instanceof Error ? error.message : "Queue sendに失敗しました",
    ),
});

function repositoryConsumerError(
  error: D1NotificationOutboxRepositoryError,
): NotificationConsumerError {
  return new NotificationConsumerError(error.code, error.retriable, error.message);
}

export async function dispatchNotificationOutbox(input: {
  repository: D1NotificationOutboxRepository;
  queue: NotificationQueueProducer;
  now: string;
  limit?: number;
  telemetry?: TelemetrySink;
  retryPolicy?: OutboxDispatchRetryPolicy;
}): Result.ResultAsync<NotificationDispatchResult, D1NotificationOutboxRepositoryError> {
  const entries = await input.repository.listDispatchable(input.now, input.limit ?? 100);
  if (Result.isFailure(entries)) return entries;

  let dispatched = 0;
  let failed = 0;
  let dead = 0;
  for (const entry of entries.value) {
    const sent = await sendQueueMessage({
      queue: input.queue,
      message: {
        organizationId: entry.organizationId,
        actionRequestId: entry.actionRequestId,
        outboxKey: entry.outboxKey,
      },
    });

    if (Result.isFailure(sent)) {
      const correlation = actionCorrelation({
        organizationId: entry.organizationId,
        actionRequestId: entry.actionRequestId,
        component: "outbox",
        operation: "dispatch",
      });
      input.telemetry?.emit(
        safeLogRecord({
          level: "error",
          event: "notification.failed",
          correlation,
          attributes: { errorCode: "notification_queue_send_failed" },
        }),
      );
      input.telemetry?.emit(
        metricRecord({
          name: "outbox.failure_total",
          value: 1,
          unit: "count",
          correlation,
          attributes: { errorCode: "notification_queue_send_failed" },
        }),
      );
      const marked = await input.repository.markDispatchFailed({
        organizationId: entry.organizationId,
        outboxKey: entry.outboxKey,
        error: sent.error.message,
        now: input.now,
        ...(input.retryPolicy ? { policy: input.retryPolicy } : {}),
      });
      if (Result.isFailure(marked)) return marked;
      if (marked.value.status === "dead") {
        emitOutboxDead(input.telemetry, entry, "notification_dispatch_retry_exhausted");
        dead += 1;
      } else {
        failed += 1;
      }
      continue;
    }

    const marked = await input.repository.markDispatched({
      organizationId: entry.organizationId,
      outboxKey: entry.outboxKey,
      dispatchedAt: input.now,
    });
    if (Result.isFailure(marked)) return marked;
    dispatched += 1;
  }

  if (input.telemetry) {
    const health = await input.repository.health();
    if (Result.isSuccess(health)) {
      input.telemetry.emit(
        metricRecord({
          name: "outbox.backlog",
          value: health.value.pendingOutbox + health.value.failedOutbox,
          unit: "items",
        }),
      );
    }
  }

  return Result.succeed({
    attempted: entries.value.length,
    dispatched,
    failed,
    dead,
  });
}

function emitOutboxDead(
  telemetry: TelemetrySink | undefined,
  entry: { organizationId: OrganizationId; actionRequestId: ActionRequestId },
  errorCode: string,
): void {
  const correlation = actionCorrelation({
    organizationId: entry.organizationId,
    actionRequestId: entry.actionRequestId,
    component: "outbox",
    operation: "dead",
  });
  telemetry?.emit(
    safeLogRecord({
      level: "error",
      event: "notification.dead",
      correlation,
      attributes: { errorCode },
    }),
  );
  telemetry?.emit(
    metricRecord({
      name: "outbox.dead_total",
      value: 1,
      unit: "count",
      correlation,
      attributes: { errorCode },
    }),
  );
}

/**
 * queue consumerが諦めてDLQに入ったmessageのoutboxをdeadにし、alertの対象にする（#94）。
 * dispatched済みのまま放置せず、operatorが再送判断できる状態へreconcileする。
 */
export async function reconcileDeadLetterNotification(input: {
  repository: D1NotificationOutboxRepository;
  message: NotificationQueueMessage;
  telemetry?: TelemetrySink;
}): Result.ResultAsync<void, D1NotificationOutboxRepositoryError> {
  const marked = await input.repository.markDead({
    organizationId: input.message.organizationId,
    outboxKey: input.message.outboxKey,
    error: "notification_queue_dead_letter",
  });
  if (Result.isFailure(marked)) return marked;
  emitOutboxDead(input.telemetry, input.message, "notification_queue_dead_letter");
  return Result.succeed(undefined);
}

export async function consumeNotificationMessage(input: {
  repository: D1NotificationOutboxRepository;
  sink: NotificationSink;
  message: NotificationQueueMessage;
  now: string;
  telemetry?: TelemetrySink;
}): Result.ResultAsync<NotificationConsumeResult, NotificationConsumerError> {
  const entry = await input.repository.load(input.message);
  if (Result.isFailure(entry)) return Result.fail(repositoryConsumerError(entry.error));
  if (!entry.value) return Result.succeed({ delivered: 0, duplicate: 1, skipped: 0 });
  if (String(entry.value.actionRequestId) !== String(input.message.actionRequestId)) {
    return Result.fail(
      new NotificationConsumerError(
        "notification_correlation_mismatch",
        false,
        "Queue messageのActionRequest correlationがOutbox entryと一致しません",
      ),
    );
  }

  const source = await input.repository.loadSourceEvent(entry.value);
  if (Result.isFailure(source)) return Result.fail(repositoryConsumerError(source.error));
  if (!source.value) {
    return Result.fail(
      new NotificationConsumerError(
        "notification_source_event_missing",
        false,
        `Outboxのsource domain eventが見つかりません: ${entry.value.eventKey}`,
      ),
    );
  }

  // 単一チャンネルへ投稿するsinkは宛先ごとに同じ文面を投稿せず、イベント単位で1回だけ配信する。
  let recipientIds: UserId[] = [CHANNEL_NOTIFICATION_RECIPIENT];
  if (input.sink.audience === "recipient") {
    const recipients = await input.repository.resolveRecipients(entry.value);
    if (Result.isFailure(recipients)) {
      return Result.fail(repositoryConsumerError(recipients.error));
    }
    recipientIds = recipients.value;
  }

  let delivered = 0;
  let duplicate = 0;
  let skipped = 0;
  for (const recipientUserId of recipientIds) {
    const delivery = await input.repository.ensureDelivery({
      entry: entry.value,
      recipientUserId,
      now: input.now,
    });
    if (Result.isFailure(delivery)) {
      return Result.fail(repositoryConsumerError(delivery.error));
    }
    if (delivery.value.status === "sent") {
      duplicate += 1;
      continue;
    }

    const request = input.repository.notificationRequest({
      entry: entry.value,
      event: source.value.event,
      recipientUserId,
    });
    const sent = await input.sink.send(request);
    if (Result.isFailure(sent)) {
      input.telemetry?.emit(
        safeLogRecord({
          level: "error",
          event: "notification.failed",
          correlation: actionCorrelation({
            organizationId: entry.value.organizationId,
            actionRequestId: entry.value.actionRequestId,
            component: "notification",
            operation: "deliver",
          }),
          attributes: { errorCode: sent.error.code, retriable: sent.error.retriable },
        }),
      );
      const marked = await input.repository.markDeliveryFailed({
        organizationId: entry.value.organizationId,
        notificationKey: entry.value.notificationKey,
        recipientUserId,
        failedAt: input.now,
        error: sent.error.message,
      });
      if (Result.isFailure(marked)) {
        return Result.fail(repositoryConsumerError(marked.error));
      }
      return Result.fail(
        new NotificationConsumerError(sent.error.code, sent.error.retriable, sent.error.message),
      );
    }

    if (sent.value === "skipped") {
      const marked = await input.repository.markDeliverySkipped({
        organizationId: entry.value.organizationId,
        notificationKey: entry.value.notificationKey,
        recipientUserId,
        skippedAt: input.now,
      });
      if (Result.isFailure(marked)) {
        return Result.fail(repositoryConsumerError(marked.error));
      }
      skipped += 1;
      continue;
    }

    const marked = await input.repository.markDeliverySent({
      organizationId: entry.value.organizationId,
      notificationKey: entry.value.notificationKey,
      recipientUserId,
      sentAt: input.now,
    });
    if (Result.isFailure(marked)) {
      return Result.fail(repositoryConsumerError(marked.error));
    }
    delivered += 1;
  }

  if (skipped > 0) {
    // sink設定後にrequeueSkippedで再送できるよう、outbox側もskippedにしておく。
    const marked = await input.repository.markSkipped({
      organizationId: entry.value.organizationId,
      outboxKey: entry.value.outboxKey,
    });
    if (Result.isFailure(marked)) return Result.fail(repositoryConsumerError(marked.error));
  }

  return Result.succeed({ delivered, duplicate, skipped });
}
