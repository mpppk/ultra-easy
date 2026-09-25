import { Result } from "@praha/byethrow";
import { assert, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import {
  MemoryTelemetrySink,
  actionEventRecord,
  type ActionFingerprint,
  type ActionRequestId,
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
import { SlackWebhookSink } from "./slack.ts";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const organizationId = "organization:m8-2-slack-delivery" as OrganizationId;
const actionRequestId = "action:m8-2-slack-delivery-1" as ActionRequestId;
const requester = "user:m8-2-requester" as UserId;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM notification_deliveries"),
    testEnv.DB.prepare("DELETE FROM outbox_events"),
  ]);
});

async function seedCompletedNotification(): Promise<void> {
  const events = new D1ActionEventRepository(testEnv.DB);
  const appended = await events.appendMany([
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-23T00:00:00.000Z",
      event: {
        type: "action.received",
        actionRequestId,
        actor: { type: "user", id: requester },
        authority: { type: "user", id: requester },
        actionFingerprint: "sha256:m8-2-slack-action" as ActionFingerprint,
      },
    }),
    actionEventRecord({
      organizationId,
      occurredAt: "2026-09-23T00:01:00.000Z",
      event: {
        type: "action.completed",
        actionRequestId,
        result: "executed",
      },
    }),
  ]);
  assert(Result.isSuccess(appended));
}

class MemoryQueue implements NotificationQueueProducer {
  messages: NotificationQueueMessage[] = [];

  async send(message: NotificationQueueMessage): Promise<void> {
    this.messages.push(message);
  }
}

/** mock webhookサーバ: 最初の1回だけ500 (retriable) を返す。 */
function flappingWebhook() {
  const bodies: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: BodyInit | null }) => {
    calls += 1;
    if (typeof init?.body === "string") bodies.push(init.body);
    if (calls === 1) return new Response("temporary", { status: 500 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl, calls: () => calls };
}

describe("Slack delivery integration (mock webhook)", () => {
  it("AC-M8-003: Queue→consumer→Slack sinkで配信し、retry後は同じkeyで冪等skipする", async () => {
    await seedCompletedNotification();
    const repository = new D1NotificationOutboxRepository(testEnv.DB);
    const queue = new MemoryQueue();
    const dispatched = await dispatchNotificationOutbox({
      repository,
      queue,
      now: "2026-09-23T00:02:00.000Z",
    });
    assert(Result.isSuccess(dispatched));
    expect(queue.messages).toHaveLength(1);
    const message = queue.messages[0]!;

    const webhook = flappingWebhook();
    const sink = new SlackWebhookSink({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      fetchImpl: webhook.fetchImpl,
    });
    const telemetry = new MemoryTelemetrySink();

    // 1回目はwebhook 500 → consumer失敗 (retriable) → queue retry相当で再試行。
    const first = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-23T00:03:00.000Z",
      telemetry,
    });
    assert(Result.isFailure(first));
    expect(first.error.retriable).toBe(true);

    const second = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-23T00:04:00.000Z",
      telemetry,
    });
    assert(Result.isSuccess(second));
    expect(second.value).toEqual({ delivered: 1, duplicate: 0, skipped: 0 });

    // at-least-once再配送は同じnotificationKeyでskipされ、POSTは増えない。
    const redelivery = await consumeNotificationMessage({
      repository,
      sink,
      message,
      now: "2026-09-23T00:05:00.000Z",
      telemetry,
    });
    assert(Result.isSuccess(redelivery));
    expect(redelivery.value).toEqual({ delivered: 0, duplicate: 1, skipped: 0 });
    expect(webhook.calls()).toBe(2);
    expect(webhook.bodies).toHaveLength(2);
    // payloadは相関のみで秘密情報を含めない。
    expect(webhook.bodies[1]).toContain("action.completed");
    expect(webhook.bodies[1]).toContain("m8-2-slack-delivery-1");
    expect(webhook.bodies[1]).not.toContain("hooks.slack.com");

    const health = await repository.health();
    assert(Result.isSuccess(health));
    expect(health.value.failedDeliveries).toBe(0);
  });
});
