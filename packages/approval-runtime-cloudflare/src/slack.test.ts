import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionRequestId, OrganizationId, UserId } from "@app/approval-core";

import { MemoryTelemetrySink, type TelemetryRecord } from "@app/approval-core";
import {
  defaultFetchImpl,
  emitNotificationSkipped,
  notifyAlertTransition,
  SlackWebhookSink,
  formatSlackAlertText,
  formatSlackNotificationText,
  notifyAlertTransitionViaSlack,
} from "./slack.ts";

const organizationId = "organization:m8-2-slack" as OrganizationId;
const actionRequestId = "action:m8-2-slack-1" as ActionRequestId;

function notificationRequest() {
  return {
    organizationId,
    actionRequestId,
    notificationKey: "notification:m8-2-test:1:user:user:test",
    eventKey: "m8-2-test-event",
    eventType: "action.completed",
    event: {
      type: "action.completed",
      actionRequestId,
      result: "executed",
    },
    recipientUserId: "user:test" as UserId,
    occurredAt: "2026-09-23T00:00:00.000Z",
  } as const;
}

describe("SlackWebhookSink", () => {
  it("payloadに秘密情報・入力・コメント・添付を含めない", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: unknown, init?: { body?: BodyInit | null }) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const sink = new SlackWebhookSink({
      webhookUrl: "https://hooks.slack.com/services/T/TEST/WEBHOOK",
      fetchImpl,
    });
    const sent = await sink.send(notificationRequest());
    assert(Result.isSuccess(sent));

    expect(capturedBody).toContain("action.completed");
    expect(capturedBody).toContain(String(actionRequestId));
    // URL自体はbodyに含めない
    expect(capturedBody).not.toContain("hooks.slack.com");
    const parsed = JSON.parse(capturedBody) as { text: string };
    expect(typeof parsed.text).toBe("string");
    expect(parsed.text.length).toBeLessThanOrEqual(2000);
  });

  it("空webhook URLは非retriableで失敗する", async () => {
    const sink = new SlackWebhookSink({ webhookUrl: "   " });
    const sent = await sink.send(notificationRequest());
    assert(Result.isFailure(sent));
    expect(sent.error.code).toBe("slack_webhook_missing");
    expect(sent.error.retriable).toBe(false);
    // error messageにURLを含めない
    expect(sent.error.message).not.toContain("hooks.slack.com");
  });

  it("429/5xxはretriable、400は非retriable", async () => {
    const retriable = new SlackWebhookSink({
      webhookUrl: "https://hooks.slack.com/x",
      fetchImpl: (async () => new Response("retry", { status: 429 })) as typeof fetch,
    });
    const r429 = await retriable.send(notificationRequest());
    assert(Result.isFailure(r429));
    expect(r429.error.retriable).toBe(true);
    expect(r429.error.code).toBe("slack_webhook_http_429");

    const fatal = new SlackWebhookSink({
      webhookUrl: "https://hooks.slack.com/x",
      fetchImpl: (async () => new Response("bad", { status: 400 })) as typeof fetch,
    });
    const r400 = await fatal.send(notificationRequest());
    assert(Result.isFailure(r400));
    expect(r400.error.retriable).toBe(false);
    expect(r400.error.code).toBe("slack_webhook_http_400");
  });

  it("network失敗はretriable", async () => {
    const sink = new SlackWebhookSink({
      webhookUrl: "https://hooks.slack.com/x",
      fetchImpl: (() => Promise.reject(new Error("connection reset"))) as typeof fetch,
    });
    const sent = await sink.send(notificationRequest());
    assert(Result.isFailure(sent));
    expect(sent.error.retriable).toBe(true);
    expect(sent.error.code).toBe("slack_webhook_network_error");
  });

  it("alert textはkey・遷移・orgのみ", () => {
    const text = formatSlackAlertText({
      organizationId,
      alertKey: "outbox_backlog",
      from: "ok",
      to: "firing",
    });
    expect(text).toContain("outbox_backlog");
    expect(text).toContain("firing");
    expect(text).toContain(String(organizationId));
  });

  it("notification textは種別・相関のみ", () => {
    const text = formatSlackNotificationText({
      organizationId,
      actionRequestId,
      notificationKey: "notification:k",
      eventType: "action.completed",
      occurredAt: "2026-09-23T00:00:00.000Z",
    });
    expect(text).toContain("action.completed");
    expect(text).toContain(String(actionRequestId));
  });

  it("degraded skipはwarn log + metricを出しURLを含めない", () => {
    const telemetry = new MemoryTelemetrySink();
    emitNotificationSkipped(telemetry, { organizationId, actionRequestId });
    const logs = telemetry.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: "log" }> => record.kind === "log",
    );
    const metrics = telemetry.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: "metric" }> => record.kind === "metric",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warn",
      event: "notification.skipped",
      attributes: { errorCode: "slack_webhook_missing" },
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      name: "outbox.failure_total",
      value: 1,
    });
    expect(JSON.stringify(telemetry.records)).not.toContain("hooks.slack.com");
  });

  it("alert遷移: secret未設定時はskip + warn log/metricでcronを壊さない", async () => {
    const telemetry = new MemoryTelemetrySink();
    await notifyAlertTransition({
      webhookUrl: "   ",
      organizationId,
      alertKey: "outbox_backlog",
      from: "breaching",
      to: "firing",
      telemetry,
    });
    const logs = telemetry.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: "log" }> => record.kind === "log",
    );
    const metrics = telemetry.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: "metric" }> => record.kind === "metric",
    );
    expect(logs).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "notification.skipped",
        attributes: expect.objectContaining({
          alertKey: "outbox_backlog",
          errorCode: "slack_webhook_missing",
        }),
      }),
    ]);
    expect(metrics).toEqual([expect.objectContaining({ name: "outbox.failure_total", value: 1 })]);
    expect(JSON.stringify(telemetry.records)).not.toContain("hooks.slack.com");
  });

  it("alert遷移: POST失敗はerror log/metricに記録する", async () => {
    const telemetry = new MemoryTelemetrySink();
    const fetchImpl = (async () => new Response("error", { status: 500 })) as typeof fetch;
    await notifyAlertTransition({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      organizationId,
      alertKey: "outbox_backlog",
      from: "ok",
      to: "firing",
      fetchImpl,
      telemetry,
    });
    const logs = telemetry.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: "log" }> => record.kind === "log",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "error", event: "notification.failed" });
    expect(
      telemetry.records.filter(
        (record): record is Extract<TelemetryRecord, { kind: "metric" }> =>
          record.kind === "metric",
      ),
    ).toHaveLength(1);
  });

  it("alert遷移: 成功時は追加のlog/metricを出さない", async () => {
    const telemetry = new MemoryTelemetrySink();
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await notifyAlertTransition({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      organizationId,
      alertKey: "outbox_backlog",
      from: "firing",
      to: "ok",
      fetchImpl,
      telemetry,
    });
    expect(telemetry.records).toHaveLength(0);
  });

  describe("default fetch binding (Illegal invocation回帰)", () => {
    it("defaultFetchImplはbare fetchではなくbind済み関数を返す", () => {
      const impl = defaultFetchImpl();
      expect(typeof impl).toBe("function");
      // 修正前はbareなfetch参照が既定値で、workerdでは
      // `TypeError: Illegal invocation` になっていた (M8-2再drill本番tailで確定)。
      expect(impl).not.toBe(globalThis.fetch);
    });

    it("fetchImpl未指定のsinkはbare fetchを保持しない", () => {
      const sink = new SlackWebhookSink({
        webhookUrl: "https://hooks.slack.com/services/T/B/X",
      });
      const stored = (sink as unknown as { fetchImpl: unknown }).fetchImpl;
      expect(stored).not.toBe(globalThis.fetch);
    });

    it("fetchImpl未指定でも実到達試行する (到達不能先はnetwork_error)", async () => {
      // 127.0.0.1:9 は何もlistenしていない。到達試行が起きること自体を検証する。
      // 原因の同一性 (Illegal invocationでないこと) は上の2件で担保する。
      // なお本リポジトリのtoolchainにcloudflare:testのfetchMockは存在しないため、
      // loopback到達不能によるoffline決定的テストとしている。
      const sink = new SlackWebhookSink({ webhookUrl: "http://127.0.0.1:9/hook" });
      const sent = await sink.send(notificationRequest());
      assert(Result.isFailure(sent));
      expect(sent.error.code).toBe("slack_webhook_network_error");
      expect(sent.error.retriable).toBe(true);
    });

    it("alert既定経路も実到達試行する (到達不能先はnotification.failed)", async () => {
      const telemetry = new MemoryTelemetrySink();
      await notifyAlertTransition({
        webhookUrl: "http://127.0.0.1:9/hook",
        organizationId,
        alertKey: "outbox_backlog",
        from: "ok",
        to: "firing",
        telemetry,
      });
      const logs = telemetry.records.filter(
        (record): record is Extract<TelemetryRecord, { kind: "log" }> => record.kind === "log",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: "error",
        event: "notification.failed",
        attributes: expect.objectContaining({ errorCode: "slack_webhook_network_error" }),
      });
    });
  });

  it("alert通知はwebhookへPOSTする", async () => {
    let captured = "";
    const fetchImpl = (async (_url: unknown, init?: { body?: BodyInit | null }) => {
      captured = typeof init?.body === "string" ? init.body : "";
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const notified = await notifyAlertTransitionViaSlack({
      webhookUrl: "https://hooks.slack.com/x",
      organizationId,
      alertKey: "outbox_backlog",
      from: "breaching",
      to: "firing",
      fetchImpl,
    });
    assert(Result.isSuccess(notified));
    expect(captured).toContain("outbox_backlog");
  });
});
