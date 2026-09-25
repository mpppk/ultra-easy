import { Result } from "@praha/byethrow";
import { brandLiteral } from "@app/approval-core";

import {
  actionCorrelation,
  ConsoleTelemetrySink,
  metricRecord,
  NotificationSinkError,
  safeLogRecord,
  type ActionRequestId,
  type NotificationRequest,
  type NotificationSendOutcome,
  type NotificationSink,
  type OrganizationId,
  type TelemetrySink,
} from "@app/approval-core";
import type { OperatorAlertKey } from "@app/approval-core";

/**
 * Slack Incoming Webhook経由のNotificationSink。
 *
 * 安全設計:
 * - payloadは通知の存在・種別・相関IDのみ。Action入力・Decisionコメント・
 *   添付内容・認証情報を混ぜない。
 * - webhook URLはwrangler secret (SLACK_WEBHOOK_URL) からのみ供給し、
 *   ログ・metric・error messageへ出力しない。
 * - fetch境界はResult.fnで型付きerror化し、throwしない。
 */
export type SlackWebhookSinkInput = {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type SlackAlertNotifyInput = {
  webhookUrl: string;
  organizationId: OrganizationId;
  alertKey: OperatorAlertKey;
  from: string;
  to: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_SLACK_TIMEOUT_MS = 8_000;
const MAX_SLACK_TEXT_LENGTH = 2_000;

/**
 * 既定のfetch実装。bareなfetch参照を保持・呼出するとworkerdで
 * `TypeError: Illegal invocation` になるため (M8-2再drillで確定)、
 * 既存規約 (approval-fga) と同じくglobalThisへbindする。
 * Exported for unit tests (既定経路がbind済みであることの回帰検証用)。
 */
export function defaultFetchImpl(): typeof fetch {
  return globalThis.fetch.bind(globalThis);
}

function normalizeWebhookUrl(value: string): string {
  return value.trim();
}

function truncateText(value: string): string {
  if (value.length <= MAX_SLACK_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`;
}

/**
 * 通知payloadのtext部。相関IDと種別のみで本文・入力・添付を含めない。
 * Exported for unit tests and runbook examples.
 */
export function formatSlackNotificationText(request: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  notificationKey: string;
  eventType: string;
  occurredAt: string;
}): string {
  return truncateText(
    `[ultra-easy] notification ${request.eventType} ` +
      `action=${String(request.actionRequestId)} ` +
      `org=${String(request.organizationId)} ` +
      `key=${request.notificationKey} at=${request.occurredAt}`,
  );
}

/**
 * alert遷移payloadのtext部。alertKey・遷移・orgのみ。
 * Exported for unit tests and runbook examples.
 */
export function formatSlackAlertText(input: {
  organizationId: OrganizationId;
  alertKey: OperatorAlertKey;
  from: string;
  to: string;
}): string {
  return truncateText(
    `[ultra-easy alert] ${input.alertKey}: ${input.from} -> ${input.to} ` +
      `org=${String(input.organizationId)}`,
  );
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const postSlackWebhook = Result.fn({
  try: async (input: {
    webhookUrl: string;
    text: string;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  }): Promise<Response> =>
    input.fetchImpl(input.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text }),
      signal: AbortSignal.timeout(input.timeoutMs),
    }),
  catch: (error): NotificationSinkError => {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || message.toLowerCase().includes("timeout"));
    return new NotificationSinkError(
      isTimeout ? "slack_webhook_timeout" : "slack_webhook_network_error",
      true,
      isTimeout ? "Slack webhook POSTがタイムアウトしました" : "Slack webhook POSTに失敗しました",
    );
  },
});

async function postText(input: {
  webhookUrl: string;
  text: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Result.ResultAsync<void, NotificationSinkError> {
  const normalized = normalizeWebhookUrl(input.webhookUrl);
  if (normalized.length === 0) {
    return Result.fail(
      new NotificationSinkError(
        "slack_webhook_missing",
        false,
        "Slack webhook URLが設定されていません",
      ),
    );
  }
  const posted = await postSlackWebhook({
    webhookUrl: normalized,
    text: input.text,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });
  if (Result.isFailure(posted)) return posted;
  const response = posted.value;
  if (response.ok) return Result.succeed(undefined);
  return Result.fail(
    new NotificationSinkError(
      `slack_webhook_http_${response.status}`,
      isRetriableStatus(response.status),
      `Slack webhookがHTTP ${response.status}を返しました`,
    ),
  );
}

/**
 * Slack Incoming Webhookは単一チャンネルへ投稿するため、audienceはchannel（イベント単位で1回）。
 * 本文に宛先を含めないので、宛先ごとに投稿すると同じ文面がN回並ぶ（#94）。
 */
export class SlackWebhookSink implements NotificationSink {
  readonly audience = "channel" as const;
  private readonly webhookUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: SlackWebhookSinkInput) {
    this.webhookUrl = input.webhookUrl;
    this.fetchImpl = input.fetchImpl ?? defaultFetchImpl();
    this.timeoutMs = input.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
  }

  async send(
    request: NotificationRequest,
  ): Result.ResultAsync<NotificationSendOutcome, NotificationSinkError> {
    const posted = await postText({
      webhookUrl: this.webhookUrl,
      text: formatSlackNotificationText({
        organizationId: request.organizationId,
        actionRequestId: request.actionRequestId,
        notificationKey: request.notificationKey,
        eventType: request.eventType,
        occurredAt: request.occurredAt,
      }),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    return Result.isFailure(posted) ? posted : Result.succeed("sent");
  }
}

/**
 * SLACK_WEBHOOK_URL未設定時のsink。配信せず`skipped`を返す（sentとして記録しない）。
 * secret設定後に`requeueSkipped`で再送できる。
 */
export class UnconfiguredNotificationSink implements NotificationSink {
  readonly audience = "channel" as const;

  async send(): Result.ResultAsync<NotificationSendOutcome, NotificationSinkError> {
    return Result.succeed("skipped");
  }
}

/** webhook URLがあればSlack、無ければskipするsinkを返す。 */
export function createSlackNotificationSink(webhookUrl: string | undefined): NotificationSink {
  const normalized = webhookUrl?.trim() ?? "";
  return normalized.length === 0
    ? new UnconfiguredNotificationSink()
    : new SlackWebhookSink({ webhookUrl: normalized });
}

/**
 * SLACK_WEBHOOK_URL未設定時のdegraded動作: 配信をskip（deliveryはskipped）し、
 * warn log + `notification.skipped_total`を出す。skipは失敗ではないため
 * `outbox.failure_total`には数えない（失敗系alertを誤発火させない）。
 */
export function emitNotificationSkipped(
  telemetry: TelemetrySink,
  input: { organizationId: OrganizationId; actionRequestId: ActionRequestId },
): void {
  const correlation = actionCorrelation({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    component: "notification",
    operation: "deliver",
  });
  telemetry.emit(
    safeLogRecord({
      level: "warn",
      event: "notification.skipped",
      correlation,
      attributes: { errorCode: "slack_webhook_missing" },
    }),
  );
  telemetry.emit(
    metricRecord({
      name: "notification.skipped_total",
      value: 1,
      unit: "count",
      correlation,
      attributes: { errorCode: "slack_webhook_missing" },
    }),
  );
}

/**
 * cronのalert遷移 (firing/resolved) をSlackへ通知する。
 * 失敗はResultとして返し、呼び出し側がlog/metricに記録する。
 * cron全体を壊さないためthrowしない。
 *
 * secret未設定時のdegraded動作: 配信をskipし、warn log + metricを出す。
 * structuredなalert.firing/alert.resolvedログ自体は呼び出し側がemitする。
 * URL・payloadは記録しない。
 */
export async function notifyAlertTransition(input: {
  webhookUrl: string;
  organizationId: OrganizationId;
  alertKey: OperatorAlertKey;
  from: string;
  to: string;
  fetchImpl?: typeof fetch;
  telemetry?: TelemetrySink;
}): Promise<void> {
  const telemetry = input.telemetry ?? new ConsoleTelemetrySink();
  const correlation = actionCorrelation({
    organizationId: input.organizationId,
    actionRequestId: brandLiteral("ActionRequestId", "action:operator-alert"),
    component: "notification",
    operation: "alert.notify",
  });
  if (input.webhookUrl.trim().length === 0) {
    telemetry.emit(
      safeLogRecord({
        level: "warn",
        event: "notification.skipped",
        correlation: {
          ...correlation,
          correlationId: `operator-alert:${String(input.organizationId)}:${input.alertKey}`,
        },
        attributes: { alertKey: input.alertKey, errorCode: "slack_webhook_missing" },
      }),
    );
    telemetry.emit(
      metricRecord({
        name: "notification.skipped_total",
        value: 1,
        unit: "count",
        correlation,
        attributes: { errorCode: "slack_webhook_missing" },
      }),
    );
    return;
  }
  const notified = await notifyAlertTransitionViaSlack({
    webhookUrl: input.webhookUrl,
    organizationId: input.organizationId,
    alertKey: input.alertKey,
    from: input.from,
    to: input.to,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (Result.isFailure(notified)) {
    telemetry.emit(
      safeLogRecord({
        level: "error",
        event: "notification.failed",
        correlation,
        attributes: { errorCode: notified.error.code, retriable: notified.error.retriable },
      }),
    );
    telemetry.emit(
      metricRecord({
        name: "outbox.failure_total",
        value: 1,
        unit: "count",
        correlation,
        attributes: { errorCode: notified.error.code },
      }),
    );
  }
}

/**
 * cronのalert遷移 (firing/resolved) をSlackへ通知する。
 * 失敗はResultとして返し、呼び出し側がlog/metricに記録する。
 * cron全体を壊さないためthrowしない。
 */
export async function notifyAlertTransitionViaSlack(
  input: SlackAlertNotifyInput,
): Result.ResultAsync<void, NotificationSinkError> {
  return postText({
    webhookUrl: input.webhookUrl,
    text: formatSlackAlertText({
      organizationId: input.organizationId,
      alertKey: input.alertKey,
      from: input.from,
      to: input.to,
    }),
    fetchImpl: input.fetchImpl ?? defaultFetchImpl(),
    timeoutMs: input.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS,
  });
}
