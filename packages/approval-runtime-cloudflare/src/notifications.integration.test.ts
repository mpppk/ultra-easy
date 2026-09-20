import { Result } from "@praha/byethrow";
import { beforeAll, beforeEach, describe, expect, it, assert } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import {
  NotificationSinkError,
  actionEventRecord,
  type ActionFingerprint,
  type ActionRequestId,
  type NotificationRequest,
  type NotificationSink,
  type OrganizationId,
  type UserId,
} from "@app/approval-core";
import {
  D1ActionEventRepository,
  D1NotificationOutboxRepository,
} from "@app/approval-d1";

import {
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "./notifications.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const organizationId = "organization:notifications" as OrganizationId;
const actionRequestId = "action:notifications" as ActionRequestId;
const requester = "user:requester" as UserId;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM notification_deliveries"),
    testEnv.DB.prepare("DELETE FROM outbox_events"),
    testEnv.DB.prepare("DELETE FROM action_events"),
  ]);
});

async function seedCompletedNotification(): Promise<void> {
  const events = new D1ActionEventRepository(testEnv.DB);
  const appended = await events.appendMany([
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-20T08:00:00.000Z",
      event: {
        type: "action.received",
        actionRequestId,
        actor: { type: "user", id: requester },
        authority: { type: "user", id: requester },
        actionFingerprint: "sha256:notification-action" as ActionFingerprint,
      },
    }),
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-20T08:01:00.000Z",
      event: {
        type: "action.completed",
        actionRequestId,
        result: "executed",
      },
    }),
  ]);
  assert(Result.isSuccess(appended));
}

class RetryQueue implements NotificationQueueProducer {
  attempts = 0;
  messages: NotificationQueueMessage[] = [];

  async send(message: NotificationQueueMessage): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) return Promise.reject(new Error("temporary queue outage"));
    this.messages.push(message);
  }
}

class RetrySink implements NotificationSink {
  requests: NotificationRequest[] = [];

  async send(request: NotificationRequest) {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return Result.fail(new NotificationSinkError("temporary_provider_outage", true, "retry me"));
    }
    return Result.succeed(undefined);
  }
}

describe("notification outbox Queue integration", () => {
  it("AC-M7-004: dispatcher retry後も1 logical outboxを同じQueue messageとして配送する", async () => {
    await seedCompletedNotification();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const queue = new RetryQueue();

    const first = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-20T08:02:00.000Z",
    });
    assert(Result.isSuccess(first));
    expect(first.value).toEqual({ attempted: 1, dispatched: 0, failed: 1 });

    const afterFailure = await repository.health();
    assert(Result.isSuccess(afterFailure));
    expect(afterFailure.value.failedOutbox).toBe(1);

    const second = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-20T08:03:00.000Z",
    });
    assert(Result.isSuccess(second));
    expect(second.value).toEqual({ attempted: 1, dispatched: 1, failed: 0 });
    expect(queue.messages).toHaveLength(1);
  });

  it("AC-M7-004: consumer redeliveryは同じrecipient idempotency keyを再利用しsent後はskipする", async () => {
    await seedCompletedNotification();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const queue = new RetryQueue();
    queue.attempts = 1;

    const dispatched = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-20T08:02:00.000Z",
    });
    assert(Result.isSuccess(dispatched));
    const message = queue.messages[0]!;
    const sink = new RetrySink();

    const first = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-20T08:03:00.000Z",
    });
    assert(Result.isFailure(first));
    expect(first.error.retriable).toBe(true);

    const second = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-20T08:04:00.000Z",
    });
    assert(Result.isSuccess(second));
    expect(second.value).toEqual({ delivered: 1, skipped: 0 });
    expect(sink.requests).toHaveLength(2);
    expect(sink.requests[0]?.notificationKey).toBe(sink.requests[1]?.notificationKey);

    const redelivery = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-20T08:05:00.000Z",
    });
    assert(Result.isSuccess(redelivery));
    expect(redelivery.value).toEqual({ delivered: 0, skipped: 1 });
    expect(sink.requests).toHaveLength(2);

    const health = await repository.health();
    assert(Result.isSuccess(health));
    expect(health.value.failedDeliveries).toBe(0);
  });
});
