import { Result } from "@praha/byethrow";
import { assert, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import {
  MemoryTelemetrySink,
  NotificationSinkError,
  actionEventRecord,
  type ActionFingerprint,
  type ActionRequestId,
  type NotificationRequest,
  type NotificationSink,
  type OrganizationId,
  type UserId,
} from "@app/approval-core";
import { D1ActionEventRepository, D1NotificationOutboxRepository } from "@app/approval-d1";

import {
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "./notifications.ts";
import { handleNotificationQueueBatch, type NotificationQueueBatch } from "./operations.ts";
import { UnconfiguredNotificationSink } from "./slack.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const organizationId = "organization:notification-reliability" as OrganizationId;
const actionRequestId = "action:notification-reliability" as ActionRequestId;
const requester = "user:requester" as UserId;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM notification_deliveries"),
    testEnv.DB.prepare("DELETE FROM outbox_events"),
  ]);
});

async function seedCompleted(): Promise<void> {
  const appended = await new D1ActionEventRepository(testEnv.DB).appendMany([
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-25T00:00:00.000Z",
      event: {
        type: "action.received",
        actionRequestId,
        actor: { type: "user", id: requester },
        authority: { type: "user", id: requester },
        actionFingerprint: "sha256:reliability" as ActionFingerprint,
      },
    }),
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-25T00:01:00.000Z",
      event: { type: "action.completed", actionRequestId, result: "executed" },
    }),
  ]);
  assert(Result.isSuccess(appended));
}

class CollectingQueue implements NotificationQueueProducer {
  messages: NotificationQueueMessage[] = [];
  failing = false;

  async send(message: NotificationQueueMessage): Promise<void> {
    if (this.failing) return Promise.reject(new Error("queue outage"));
    this.messages.push(message);
  }
}

class RecordingSink implements NotificationSink {
  requests: NotificationRequest[] = [];

  constructor(
    readonly audience: "channel" | "recipient",
    private readonly failure?: NotificationSinkError,
  ) {}

  async send(request: NotificationRequest) {
    this.requests.push(request);
    return this.failure ? Result.fail(this.failure) : Result.succeed("sent" as const);
  }
}

async function dispatchOne(repository: D1NotificationOutboxRepository, now: string) {
  const queue = new CollectingQueue();
  const dispatched = await dispatchNotificationOutbox({ repository, queue, now });
  assert(Result.isSuccess(dispatched));
  return queue.messages;
}

function batchOf(queue: string, messages: NotificationQueueMessage[]) {
  const acked: number[] = [];
  const retried: { index: number; delaySeconds?: number }[] = [];
  const batch: NotificationQueueBatch = {
    queue,
    messages: messages.map((body, index) => ({
      body,
      attempts: 2,
      ack: () => acked.push(index),
      retry: (options) => retried.push({ index, ...options }),
    })),
  };
  return { batch, acked, retried };
}

async function outboxStatus(): Promise<string | undefined> {
  const row = await testEnv.DB.prepare("SELECT status FROM outbox_events WHERE organization_id = ?")
    .bind(organizationId)
    .first<{ status: string }>();
  return row?.status;
}

describe("#94 notification delivery reliability", () => {
  it("sink未設定はsentではなくskippedで記録し、設定後に再送できる", async () => {
    await seedCompleted();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const [message] = await dispatchOne(repository, "2026-09-25T00:02:00.000Z");
    assert(message);

    const skipped = await consumeNotificationMessage({
      repository,
      sink: new UnconfiguredNotificationSink(),
      message,
      now: "2026-09-25T00:03:00.000Z",
    });
    assert(Result.isSuccess(skipped));
    expect(skipped.value).toEqual({ delivered: 0, duplicate: 0, skipped: 1 });
    expect(await outboxStatus()).toBe("skipped");
    const health = await repository.health();
    assert(Result.isSuccess(health));
    expect(health.value).toMatchObject({ skippedDeliveries: 1, failedDeliveries: 0 });

    // secret設定後: skippedをpendingへ戻して再dispatch → 配信される
    const requeued = await repository.requeueSkipped();
    assert(Result.isSuccess(requeued));
    expect(requeued.value).toBe(1);
    const [again] = await dispatchOne(repository, "2026-09-25T00:10:00.000Z");
    assert(again);
    const sink = new RecordingSink("channel");
    const sent = await consumeNotificationMessage({
      repository,
      sink,
      message: again,
      now: "2026-09-25T00:11:00.000Z",
    });
    assert(Result.isSuccess(sent));
    expect(sent.value).toEqual({ delivered: 1, duplicate: 0, skipped: 0 });
    expect(sink.requests).toHaveLength(1);
  });

  it("channel sinkは宛先数に関係なくイベント単位で1回だけ投稿する", async () => {
    await seedCompleted();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const [message] = await dispatchOne(repository, "2026-09-25T00:02:00.000Z");
    assert(message);
    const channel = new RecordingSink("channel");
    const consumed = await consumeNotificationMessage({
      repository,
      sink: channel,
      message,
      now: "2026-09-25T00:03:00.000Z",
    });
    assert(Result.isSuccess(consumed));
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0]?.recipientUserId).toBe("channel");
  });

  it("queue consumer: 非retriableはackし、retriableだけbackoff付きでretryする", async () => {
    await seedCompleted();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const [message] = await dispatchOne(repository, "2026-09-25T00:02:00.000Z");
    assert(message);

    const mismatch = batchOf("ultra-easy-notifications-staging", [
      { ...message, actionRequestId: "action:other" as ActionRequestId },
    ]);
    await handleNotificationQueueBatch({
      batch: mismatch.batch,
      db: testEnv.DB,
      sink: new RecordingSink("channel"),
      telemetry: new MemoryTelemetrySink(),
      now: () => "2026-09-25T00:03:00.000Z",
    });
    expect(mismatch.acked).toEqual([0]);
    expect(mismatch.retried).toEqual([]);

    const clientError = batchOf("ultra-easy-notifications-staging", [message]);
    await handleNotificationQueueBatch({
      batch: clientError.batch,
      db: testEnv.DB,
      sink: new RecordingSink(
        "channel",
        new NotificationSinkError("slack_webhook_http_404", false, "gone"),
      ),
      telemetry: new MemoryTelemetrySink(),
      now: () => "2026-09-25T00:03:00.000Z",
    });
    expect(clientError.acked).toEqual([0]);
    expect(clientError.retried).toEqual([]);

    const outage = batchOf("ultra-easy-notifications-staging", [message]);
    await handleNotificationQueueBatch({
      batch: outage.batch,
      db: testEnv.DB,
      sink: new RecordingSink(
        "channel",
        new NotificationSinkError("slack_webhook_http_503", true, "retry"),
      ),
      telemetry: new MemoryTelemetrySink(),
      now: () => "2026-09-25T00:04:00.000Z",
    });
    expect(outage.acked).toEqual([]);
    expect(outage.retried).toEqual([{ index: 0, delaySeconds: 20 }]);
  });

  it("dispatch失敗はbackoffし、上限でdeadになって再送対象から外れる", async () => {
    await seedCompleted();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const queue = new CollectingQueue();
    queue.failing = true;
    const telemetry = new MemoryTelemetrySink();
    const policy = { maxAttempts: 2, baseDelayMs: 60_000, maxDelayMs: 60_000 };

    const first = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-25T00:02:00.000Z",
      retryPolicy: policy,
      telemetry,
    });
    assert(Result.isSuccess(first));
    expect(first.value).toMatchObject({ failed: 1, dead: 0 });
    // backoff中は再送しない
    const early = await repository.listDispatchable("2026-09-25T00:02:30.000Z");
    assert(Result.isSuccess(early));
    expect(early.value).toHaveLength(0);

    const second = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-25T00:03:00.000Z",
      retryPolicy: policy,
      telemetry,
    });
    assert(Result.isSuccess(second));
    expect(second.value).toMatchObject({ failed: 0, dead: 1 });
    expect(await outboxStatus()).toBe("dead");
    const later = await repository.listDispatchable("2026-09-26T00:00:00.000Z");
    assert(Result.isSuccess(later));
    expect(later.value).toHaveLength(0);
    expect(telemetry.records).toContainEqual(
      expect.objectContaining({ kind: "metric", name: "outbox.dead_total" }),
    );
  });

  it("DLQに入ったmessageはoutboxをdeadにしてalert対象にする", async () => {
    await seedCompleted();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const [message] = await dispatchOne(repository, "2026-09-25T00:02:00.000Z");
    assert(message);
    expect(await outboxStatus()).toBe("dispatched");

    const telemetry = new MemoryTelemetrySink();
    const dlq = batchOf("ultra-easy-notifications-staging-dlq", [message]);
    await handleNotificationQueueBatch({
      batch: dlq.batch,
      db: testEnv.DB,
      sink: new RecordingSink("channel"),
      telemetry,
      now: () => "2026-09-25T00:30:00.000Z",
    });
    expect(dlq.acked).toEqual([0]);
    expect(await outboxStatus()).toBe("dead");
    const health = await repository.health();
    assert(Result.isSuccess(health));
    expect(health.value.deadOutbox).toBe(1);
    expect(telemetry.records).toContainEqual(
      expect.objectContaining({ kind: "log", event: "notification.dead" }),
    );
  });
});
