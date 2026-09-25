import { Result } from "@praha/byethrow";
import { brandLiteral } from "./domain/brand.ts";

import type { ActionEvent } from "./action-event.ts";
import type { ActionRequestId, OrganizationId, UserId } from "./domain/brand.ts";

export type NotificationRequest = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  notificationKey: string;
  eventKey: string;
  eventType: ActionEvent["type"];
  event: ActionEvent;
  recipientUserId: UserId;
  occurredAt: string;
};

export class NotificationSinkError extends Error {
  readonly name = "NotificationSinkError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * - sent: 配信した
 * - skipped: sinkが未設定等で配信しなかった（sentとして記録しない。設定後に再送できる）
 */
export type NotificationSendOutcome = "sent" | "skipped";

/**
 * 宛先の単位。channel（Slack Incoming Webhook等の単一チャンネル）はイベント単位で1回だけ投稿し、
 * recipient（DM等の宛先を持つsink）は宛先ごとに配信する。
 */
export type NotificationSinkAudience = "channel" | "recipient";

export interface NotificationSink {
  readonly audience: NotificationSinkAudience;

  /**
   * notificationKey is a stable logical-delivery idempotency key.
   * Adapters should reuse it when calling downstream providers that support
   * idempotency so queue redelivery cannot create a second logical notification.
   */
  send(
    request: NotificationRequest,
  ): Result.ResultAsync<NotificationSendOutcome, NotificationSinkError>;
}

/** channel audienceのdeliveryに使う宛先ID（notification_deliveriesの主キー用）。 */
export const CHANNEL_NOTIFICATION_RECIPIENT = brandLiteral("UserId", "channel");

export function notificationKeyForEvent(eventKey: string): string {
  return `notification:${eventKey}`;
}

export function notificationDeliveryKey(input: {
  notificationKey: string;
  recipientUserId: UserId;
}): string {
  return `${input.notificationKey}:user:${String(input.recipientUserId)}`;
}
